// Entrada del plugin para OpenCode 2.x: adapter twin de la extensión Pi,
// portado al contrato v2 de @opencode/plugin (Plugin.define({ id, setup })).
//
// Mapeo de hooks v1 → v2 (semántica preservada byte a byte en los textos):
//   - Herramientas: v1 `tool: { [nombre]: {...} }` → v2 `ctx.tool.transform`
//     con `editor.add({ name, input (Standard Schema / zod), execute })`
//   - v1 "experimental.chat.system.transform" → v2 `ctx.session.hook("context")`:
//     agrega el puntero de playbook_consult al array SystemPart de la request
//   - v1 "chat.message" → v2 `ctx.session.hook("prompt")`: pre-vuelo
//     determinístico; muta `prompt.text` in-place (en v2 el prompt ya es texto
//     plano mutable, sin parts; OpenCode tampoco permite cancelar el mensaje:
//     los intentos de bypass quedan visibles como directiva y la barrera de
//     herramientas mantiene el bloqueo)
//   - v1 "tool.execute.before" → v2 `ctx.tool.hook("execute.before")`: barrera
//     de escritura fail-closed (throw = bloqueo, patrón probado por los
//     plugins de gentle-ai para OpenCode)
//   - v1 "experimental.session.compacting" → v2 `ctx.session.hook("compaction")`:
//     inyecta las normas activas como contexto del request de compactación
//     (exclusivo de OpenCode; Pi no lo necesita)
//
// Toda la lógica de decisión y los textos provienen de core/governance.ts,
// compartida con la extensión Pi: paridad de enforcement byte a byte.
// El módulo de gobernanza NO cambia: este archivo es solo transporte.

import * as z from 'zod';
import { Plugin } from '@opencode/plugin';
import { PlaybookStorage } from './core/storage.js';
import {
  formatPlaybookForTool,
  formatAgentPreferencesForTool,
} from './core/parser.js';
import { resolveLanguage } from './core/languages.js';
import { validateRuleContent } from './core/security.js';
import {
  getActiveWorkspacePlaybooks,
  maskSubordinatePlaybooks,
  findCollidingRules,
} from './core/stack-handler.js';
import { detectActiveStacks } from './core/stack-detector.js';
import { detectProjectLanguage } from './extract/extractor.js';
import { checkPathViolation } from './core/checker.js';
import { AGENTS_PREFERENCES_ID, Playbook } from './core/schema.js';
import {
  buildSystemGuidance,
  evaluateWorkspacePrompt,
  isBypassViolation,
  buildBypassGovernanceDirective,
  buildHeadlessRedirectDirective,
  buildAskDefaultDirective,
  matchesAgentToolSurface,
  buildAgentNeverBlockReason,
  buildAgentAskHeadlessBlockReason,
  buildAgentInvariantHeadlessBlockReason,
  buildPathViolationBlockReason,
} from './core/governance.js';

// ---------------------------------------------------------------------------
// Utilidades de adaptación
// ---------------------------------------------------------------------------

/** Herramientas de OpenCode que escriben archivos en disco. */
const FILE_WRITE_TOOLS = new Set(['write', 'edit', 'patch']);

/** Extrae la ruta objetivo de los args de una herramienta de escritura. */
function extractTargetPath(args: Record<string, unknown> | undefined): string {
  if (!args || typeof args !== 'object') return '';
  for (const key of ['filePath', 'path', 'file_path', 'file']) {
    const value = (args as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

// ---------------------------------------------------------------------------
// playbook_manage: mutaciones agente-mediadas (flujo preview → confirmación → save)
// ---------------------------------------------------------------------------

interface ManageRule {
  type: 'invariant' | 'ask' | 'never';
  id: string;
  title?: string;
  surface?: string;
  description: string;
  trigger?: string;
  antiTrigger?: string;
  prompt?: string;
  defaultAction?: string;
  reason?: string;
}

type ManageScope = 'project' | 'agents' | 'stack' | 'global';

interface ManageTarget {
  scope: ManageScope;
  key: string;
  label: string;
  isNew: boolean;
  playbook: Playbook;
}

async function resolveManageTarget(
  storage: PlaybookStorage,
  cwd: string,
  language: string,
  scopeHint?: 'global' | 'stack' | 'agents' | 'project'
): Promise<ManageTarget> {
  const today = new Date().toISOString().split('T')[0];
  const skeleton = (overrides: Partial<Playbook>): Playbook =>
    ({
      version: 1,
      updatedAt: today,
      topology: { pattern: 'Standard Layout', directories: ['src/'] },
      invariants: [],
      askRules: [],
      snippets: [],
      ...overrides,
    } as unknown as Playbook);

  const normalized = (language || '').trim().toLowerCase();

  if (scopeHint === 'project' || !scopeHint && (normalized === 'project' || normalized === 'local')) {
    const pb = await storage.getLocalProjectPlaybook(cwd);
    return {
      scope: 'project',
      key: 'project',
      label: 'PROYECTO LOCAL (playbook.md)',
      isNew: !pb,
      playbook: pb || skeleton({ language: 'project', scope: 'project' }),
    };
  }

  if (scopeHint === 'agents' || (!scopeHint && (normalized === 'agents' || normalized === AGENTS_PREFERENCES_ID))) {
    const pb = await storage.getAgentPreferences();
    return {
      scope: 'agents',
      key: AGENTS_PREFERENCES_ID,
      label: 'Agents Preferences',
      isNew: !pb,
      playbook:
        pb || skeleton({ language: AGENTS_PREFERENCES_ID, scope: 'agents', topology: { pattern: 'Agent Runtime', directories: [] } }),
    };
  }

  if (scopeHint === 'stack' || (!scopeHint && normalized && (await storage.hasStack(normalized)))) {
    if (!normalized) throw new Error('El ámbito stack requiere el slug del stack en language');
    const pb = await storage.getStack(normalized);
    return {
      scope: 'stack',
      key: normalized,
      label: `STACK ${normalized.toUpperCase()}`,
      isNew: !pb,
      playbook:
        pb ||
        skeleton({
          language: normalized,
          stackId: normalized,
          stackName: normalized.toUpperCase(),
          requiredFlags: [normalized],
          scope: 'stack',
          topology: { pattern: 'Standard Stack Layout', directories: ['src/'] },
        }),
    };
  }

  const resolved = resolveLanguage(normalized || 'generic');
  const pb = await storage.getPlaybook(resolved);
  return {
    scope: 'global',
    key: resolved,
    label: `GLOBAL: ${resolved.toUpperCase()}`,
    isNew: !pb,
    playbook: pb || skeleton({ language: resolved, scope: 'global' }),
  };
}

/**
 * Valida el contenido de la regla contra el filtro anti-inyección. Nunca
 * persistimos en silencio contenido que el sanitizador descartaría: el agente
 * recibe el campo ofensivo y lo corrige antes de guardar.
 */
function validateManageRule(rule: ManageRule): { valid: boolean; reason?: string } {
  const res = validateRuleContent(rule as never);
  if (!res.valid) return { valid: false, reason: `El campo de la regla activó el filtro de seguridad: ${res.reason}` };
  if (rule.type === 'ask' && !rule.prompt?.trim()) {
    return { valid: false, reason: 'Las reglas ASK requieren el campo prompt (la pregunta canónica).' };
  }
  return { valid: true };
}

/** Aplica la regla al playbook con upsert por id (misma lógica que la extensión Pi). */
function applyManageRule(pb: Playbook, rule: ManageRule): void {
  if (rule.type === 'invariant') {
    const idx = pb.invariants.findIndex((i) => i.id === rule.id);
    const newRule = {
      id: rule.id,
      type: 'invariant' as const,
      title: rule.title || rule.id,
      surface: rule.surface || 'src/',
      description: rule.description,
    };
    if (idx >= 0) pb.invariants[idx] = newRule;
    else pb.invariants.push(newRule);
  } else if (rule.type === 'never') {
    if (!pb.neverRules) pb.neverRules = [];
    const idx = pb.neverRules.findIndex((n) => n.id === rule.id);
    const newRule = {
      id: rule.id,
      type: 'never' as const,
      title: rule.title || rule.id,
      surface: rule.surface || 'general',
      description: rule.description,
      reason: rule.reason || '',
    };
    if (idx >= 0) pb.neverRules[idx] = newRule;
    else pb.neverRules.push(newRule);
  } else {
    const idx = pb.askRules.findIndex((a) => a.id === rule.id);
    const newRule = {
      id: rule.id,
      type: 'ask' as const,
      title: rule.title || rule.id,
      surface: rule.surface || 'src/',
      description: rule.description,
      trigger: rule.trigger || '',
      antiTrigger: rule.antiTrigger || '',
      prompt: rule.prompt || '',
      defaultAction: rule.defaultAction || 'Omitir regla',
    };
    if (idx >= 0) pb.askRules[idx] = newRule;
    else pb.askRules.push(newRule);
  }
}

/**
 * Capas candidatas para el chequeo de colisiones: la misma construcción que
 * el wizard add de Pi (capas activas excluyendo el ámbito destino).
 */
async function manageCandidateLayers(
  storage: PlaybookStorage,
  cwd: string,
  target: ManageTarget
): Promise<Array<{ scopeLabel: string; playbook: Playbook }>> {
  const candidates: Array<{ scopeLabel: string; playbook: Playbook }> = [];

  if (target.scope !== 'project') {
    const localPb = await storage.getLocalProjectPlaybook(cwd);
    if (localPb) candidates.push({ scopeLabel: 'LOCAL (playbook.md)', playbook: localPb });
  }

  const allStackSlugs = await storage.listStacks();
  const allStackPbs: Playbook[] = [];
  for (const sSlug of allStackSlugs) {
    const sPb = await storage.getStack(sSlug);
    if (sPb) allStackPbs.push(sPb);
  }
  const activeStacks = await detectActiveStacks(cwd, allStackPbs);
  for (const actStack of activeStacks) {
    if (target.scope !== 'stack' || actStack.stackId !== target.key) {
      candidates.push({ scopeLabel: `STACK: ${actStack.stackId}`, playbook: actStack });
    }
  }

  if (target.scope !== 'global') {
    const detectedLang = await detectProjectLanguage(cwd);
    if (detectedLang && detectedLang !== 'generic') {
      const globPb = await storage.getPlaybook(detectedLang);
      if (globPb) candidates.push({ scopeLabel: `GLOBAL: ${detectedLang}`, playbook: globPb });
    }
  }

  return candidates;
}

function renderManageRuleSummary(rule: ManageRule): string {
  const typeLabel = rule.type === 'invariant' ? 'INVARIANT' : rule.type === 'never' ? 'NUNCA/PROHIBICIÓN' : 'ASK';
  const lines = [`**Tipo:** ${typeLabel} · **ID:** ${rule.id} · **Surface:** \`${rule.surface || 'src/'}\``];
  if (rule.title) lines.push(`**Título:** ${rule.title}`);
  lines.push(`**Regla:** ${rule.description}`);
  if (rule.type === 'never' && rule.reason) lines.push(`**Motivo:** ${rule.reason}`);
  if (rule.type === 'ask') {
    lines.push(`**Trigger:** ${rule.trigger || '-'} · **Anti-Trigger:** ${rule.antiTrigger || '-'}`);
    lines.push(`**Pregunta canónica:** "${rule.prompt}"`);
    lines.push(`**Default:** ${rule.defaultAction || 'Omitir regla'}`);
  }
  return lines.join('\n');
}

async function persistManageTarget(
  storage: PlaybookStorage,
  cwd: string,
  target: ManageTarget,
  rule?: ManageRule
): Promise<Playbook> {
  if (rule) {
    applyManageRule(target.playbook, rule);
    target.playbook.version += 1;
    target.playbook.updatedAt = new Date().toISOString().split('T')[0];
  }
  if (target.scope === 'project') await storage.saveLocalProjectPlaybook(target.playbook, cwd);
  else if (target.scope === 'agents') await storage.saveAgentPreferences(target.playbook);
  else if (target.scope === 'stack') await storage.saveStack(target.playbook);
  else await storage.savePlaybook(target.playbook);
  return target.playbook;
}

async function executePlaybookManage(
  storage: PlaybookStorage,
  cwd: string,
  args: {
    action: 'preview' | 'save' | 'delete';
    language?: string;
    scope?: 'global' | 'stack' | 'agents' | 'project';
    rule?: ManageRule;
    ruleId?: string;
    whole?: boolean;
  }
): Promise<string> {
  if (!args?.action) throw new Error('playbook_manage requiere action: preview | save | delete');

  if (args.action === 'delete') {
    const lang = (args.language || '').trim().toLowerCase();
    if (!lang) throw new Error('playbook_manage delete requiere language (lenguaje, stack o agents)');

    if (args.whole) {
      if (lang === 'project' || lang === 'local' || args.scope === 'project') {
        throw new Error('El playbook local (playbook.md) es un archivo del repositorio: editá o borrá el archivo directamente.');
      }
      const target = await resolveManageTarget(storage, cwd, lang, args.scope);
      if (target.isNew) return `El playbook ${target.label} no existe: nada que eliminar.`;
      await storage.deletePlaybook(target.key);
      return `✓ Playbook ${target.label} eliminado por completo.`;
    }

    if (!args.ruleId) throw new Error('playbook_manage delete requiere ruleId (o whole=true para el playbook completo)');
    if (lang === 'project' || lang === 'local' || args.scope === 'project') {
      const res = await storage.deleteRuleFromProject(cwd, args.ruleId);
      if (!res.deleted) return `La regla "${args.ruleId}" no existe en PROYECTO LOCAL (playbook.md).`;
      return `✓ Regla "${args.ruleId}" (${res.ruleType}) eliminada de PROYECTO LOCAL (playbook.md).`;
    }
    const target = await resolveManageTarget(storage, cwd, lang);
    if (target.isNew) return `El playbook ${target.label} no existe: nada que eliminar.`;
    const res = await storage.deleteRule(target.key, args.ruleId);
    if (!res.deleted) return `La regla "${args.ruleId}" no existe en ${target.label}.`;
    return `✓ Regla "${args.ruleId}" (${res.ruleType}) eliminada de ${target.label}.`;
  }

  // preview | save
  if (!args.rule) throw new Error(`playbook_manage ${args.action} requiere el objeto rule completo`);
  const rule = args.rule;
  if (!rule.type || !rule.id || !rule.description) {
    throw new Error('La regla requiere type (invariant|ask|never), id y description');
  }

  const validity = validateManageRule(rule);
  const target = await resolveManageTarget(storage, cwd, args.language || '', args.scope);

  if (!validity.valid) {
    if (args.action === 'save') {
      // Nunca persistir en silencio contenido que el sanitizador descartaría.
      throw new Error(`CONTENIDO INVALIDO — ${validity.reason}. Corregí el texto y reintentá; la regla NO se guardó.`);
    }
    return [
      `## Preview — Regla para ${target.label}${target.isNew ? ' (nuevo playbook)' : ''}`,
      '',
      `❌ CONTENIDO INVALIDO: ${validity.reason}`,
      'Corregí el texto de la regla y volvé a ejecutar el preview. Este contenido NO debe guardarse.',
    ].join('\n');
  }

  const collisions = findCollidingRules(
    { id: rule.id, surface: rule.surface || '', title: rule.title || '', description: rule.description },
    await manageCandidateLayers(storage, cwd, target)
  );

  if (args.action === 'preview') {
    const lines = [
      `## Preview — Regla para ${target.label}${target.isNew ? ' (nuevo playbook)' : ''}`,
      '',
      renderManageRuleSummary(rule),
      '',
      '### Colisiones',
    ];
    if (collisions.length === 0) {
      lines.push('NINGUNA — la regla puede guardarse sin conflictos con otras capas activas.');
    } else {
      lines.push(`⚠️ ${collisions.length} colisión(es) con capas existentes:`);
      for (const c of collisions) {
        lines.push(`- [${c.scopeLabel}] ${c.rule.id}: ${c.rule.title || ''} (surface \`${c.rule.surface}\`)`);
      }
      lines.push('Si guardás igual, esta regla prevalece en su ámbito (soberanía local por capa).');
    }
    lines.push('', '### Siguiente paso', 'Mostrale este preview al usuario, pedí confirmación y ejecutá playbook_manage con action=save usando exactamente los mismos argumentos.');
    return lines.join('\n');
  }

  // save
  const saved = await persistManageTarget(storage, cwd, target, rule);
  return [
    `✓ Regla [${rule.id.toUpperCase()}] (${rule.type}) guardada en ${target.label} (v${saved.version}).`,
    '',
    renderManageRuleSummary(rule),
    ...(collisions.length > 0
      ? ['', `Nota: prevalece sobre ${collisions.length} regla(s) en colisión dentro de su ámbito.`]
      : []),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const consultInputSchema = z.object({
  language: z
    .string()
    .optional()
    .describe(
      "Target language (e.g. 'go', 'typescript', 'python') or 'agents' for agent supervision preferences. Defaults to auto-detected workspace language."
    ),
  surface: z
    .string()
    .optional()
    .describe(
      "Optional filter for rules affecting a specific surface or file path (e.g. 'internal/ports', 'tools:write', 'git:push')."
    ),
});

const manageRuleSchema = z.object({
  type: z.enum(['invariant', 'ask', 'never']),
  id: z.string().min(1),
  title: z.string().optional(),
  surface: z.string().optional(),
  description: z.string().min(1),
  trigger: z.string().optional(),
  antiTrigger: z.string().optional(),
  prompt: z.string().optional(),
  defaultAction: z.string().optional(),
  reason: z.string().optional(),
});

const manageInputSchema = z.object({
  action: z.enum(['preview', 'save', 'delete']).describe('preview (no disk write), save (persist), delete'),
  language: z
    .string()
    .optional()
    .describe("Target: language (e.g. 'go'), stack slug, 'agents', or 'project' for the local playbook.md"),
  scope: z
    .enum(['global', 'stack', 'agents', 'project'])
    .optional()
    .describe('Optional explicit routing: use scope=stack with a new slug to create a stack playbook'),
  ruleId: z.string().optional().describe('Rule id to delete (with action=delete)'),
  whole: z.boolean().optional().describe('Delete the whole playbook (with action=delete)'),
  rule: manageRuleSchema.optional().describe('The synthesized rule (required for preview/save)'),
});

/** Crea la herramienta playbook_consult como Tool.Info v2 (execute retorna Tool.Result). */
function playbookConsultTool(cwd: () => string, storage: PlaybookStorage) {
  /** Jerarquía completa del workspace (Local > Stack > Global > Agente). */
  const activeHierarchy = () => getActiveWorkspacePlaybooks(cwd(), storage);

  return {
    name: 'playbook_consult',
    // Direct-callable por el modelo: sin esto la tool cae en el catálogo de
    // Code Mode (solo accesible via `execute`) y el primer llamado directo
    // falla con "no tool named ..." (anomalyco/opencode#50312).
    options: { codemode: false },
    // Herramienta on-demand compartida con Pi: mismos datos pasivos de
    // referencia, sin inyección en system prompt.
    description:
      'Consult architectural conventions, topology constraints, coding invariants, conditional asks, prohibitions, and agent supervision preferences for the project or language. Returns passive reference data without system prompt injection.',
    input: consultInputSchema,
    async execute(args: z.infer<typeof consultInputSchema>) {
      // En v2 el ToolContext no trae directory/worktree: la ubicación vive en
      // ctx.location del setup (equivalente al input.directory de v1).
      const consultCwd = cwd();
          const targetLang = typeof args.language === 'string' ? args.language.trim().toLowerCase() : undefined;
          const surfaceFilter = typeof args.surface === 'string' ? args.surface.trim() : undefined;

          const results: string[] = [];

          if (targetLang === 'agents' || targetLang === AGENTS_PREFERENCES_ID) {
            const agentPrefs = await storage.getAgentPreferences();
            if (agentPrefs) {
              results.push(formatAgentPreferencesForTool(agentPrefs, surfaceFilter));
            } else {
              results.push('No agent supervision preferences found in storage.');
            }
          } else if (targetLang === 'project' || targetLang === 'local') {
            const localPb = await storage.getLocalProjectPlaybook(consultCwd);
            if (localPb) {
              results.push(formatPlaybookForTool(localPb, surfaceFilter));
            } else {
              results.push('No local project playbook (playbook.md) found in this repository.');
            }
          } else if (targetLang && (await storage.hasStack(targetLang))) {
            const stackPb = await storage.getStack(targetLang);
            if (stackPb) {
              results.push(formatPlaybookForTool(stackPb, surfaceFilter));
            } else {
              results.push(`No stack playbook found for '${targetLang}'.`);
            }
          } else if (targetLang) {
            const resolved = resolveLanguage(targetLang);
            const pb = await storage.getPlaybook(resolved);
            if (pb) {
              results.push(formatPlaybookForTool(pb, surfaceFilter));
            } else {
              results.push(`No playbook found for language '${targetLang}'.`);
            }
          } else {
            const playbooks = await activeHierarchy();
            for (const pb of playbooks) {
              let header = '';
              if (pb.scope === 'project' || pb.language === 'project') {
                header = '### 🏠 [LOCAL PROJECT PLAYBOOK: playbook.md]';
              } else if (pb.scope === 'stack' || pb.stackId) {
                header = `### 📦 [STACK PLAYBOOK: ${pb.stackName || pb.stackId}]`;
              } else if (pb.language === AGENTS_PREFERENCES_ID) {
                header = '### 🤖 [AGENT SUPERVISION PREFERENCES]';
              } else {
                header = `### 🌐 [GLOBAL PLAYBOOK: ${pb.language.toUpperCase()}]`;
              }

              const formatted =
                pb.language === AGENTS_PREFERENCES_ID
                  ? formatAgentPreferencesForTool(pb, surfaceFilter)
                  : formatPlaybookForTool(pb, surfaceFilter);

              if (formatted && !formatted.includes('No se encontraron reglas')) {
                results.push(`${header}\n\n${formatted}`);
              }
            }

            if (results.length === 0) {
              results.push('No playbook found for the current workspace and no agent preferences configured.');
            }
          }

      return { content: results.join('\n\n---\n\n') };
    },
  };
}

/** Crea la herramienta playbook_manage como Tool.Info v2 (execute retorna Tool.Result). */
function playbookManageTool(cwd: () => string, storage: PlaybookStorage) {
  return {
    name: 'playbook_manage',
    options: { codemode: false },
    // Mutaciones agente-mediadas: el agente sintetiza la regla conversando
    // con el usuario, muestra el preview, confirma y persiste. Reemplaza los
    // wizards interactivos de Pi (OpenCode no expone UI a plugins).
    description:
      'Preview, save, or delete architectural rules and playbooks. Two-phase flow: action=preview validates the rule content (injection filter), checks collisions across active layers, and returns a preview WITHOUT writing to disk; then the agent asks the user for confirmation and calls action=save with the same arguments to persist. action=delete removes a rule by ruleId or a whole playbook with whole=true. Target language accepts a global language (go, typescript...), a stack slug, "agents", or "project" for the local playbook.md.',
    input: manageInputSchema,
    async execute(args: z.infer<typeof manageInputSchema>) {
      return { content: await executePlaybookManage(storage, cwd(), args) };
    },
  };
}

export default Plugin.define({
  id: 'gentle-playbook',
  async setup(ctx) {
    const storage = new PlaybookStorage();
    const cwd = () => ctx.location.directory as string;

    /** Jerarquía completa del workspace (Local > Stack > Global > Agente). */
    const activeHierarchy = () => getActiveWorkspacePlaybooks(cwd(), storage);

    /** Capas activas con enmascaramiento local por superficie (para enforcement). */
    const activeMasked = async () => maskSubordinatePlaybooks(await activeHierarchy());

    const registrations: Array<{ dispose(): Promise<void> }> = [];

    // Herramientas del modelo, registradas por dominio (v2: ctx.tool.transform).
    registrations.push(
      await ctx.tool.transform((editor) => {
        editor.add(playbookConsultTool(cwd, storage) as never);
        editor.add(playbookManageTool(cwd, storage) as never);
      })
    );

    // OpenCode v2 refresca el catálogo de tools solo bajo demanda: sin este
    // reload el primer turno no ve playbook_consult/playbook_manage
    // (observado en vivo: "no tool named ..." en el primer turno y OK después).
    await ctx.tool.reload();

    // Puntero liviano en system prompt: mismo texto que Pi inyecta en
    // systemPromptOptions.sections.playbook_guidance. En v2 el hook
    // "context" corre por request con el array SystemPart mutable.
    registrations.push(
      await ctx.session.hook('context', async (input) => {
        const pbs = await activeHierarchy();
        if (pbs.length === 0) return;
        input.system.push({ type: 'text', text: buildSystemGuidance(pbs) });
      })
    );

    // Pre-vuelo determinístico del prompt (v2: hook "prompt", texto plano
    // mutable sobre input.prompt.text — no hay parts en el PromptInput v2, la
    // mutación es directa). OpenCode no permite cancelar el mensaje desde un
    // plugin: cada conflicto queda como directiva visible y el enforcement
    // real vive en la barrera de herramientas.
    registrations.push(
      await ctx.session.hook('prompt', async (input) => {
        try {
          const promptText = input.prompt.text ?? '';
          if (!promptText.trim()) return;

          const pbs = await activeMasked();
          if (pbs.length === 0) return;

          // Evaluación compartida runtime-agnostic (<1ms, sin llamadas a LLM).
          const evaluation = await evaluateWorkspacePrompt(promptText, pbs);

          const directives: string[] = [];
          for (const { violation } of evaluation.violations) {
            const ruleId = violation.rule.id.toUpperCase();
            if (isBypassViolation(violation)) {
              directives.push(buildBypassGovernanceDirective(ruleId, violation.reason));
            } else {
              const targetSurface =
                (violation.rule as { surface?: string }).surface || 'la superficie canónica del playbook';
              directives.push(buildHeadlessRedirectDirective(promptText, ruleId, violation.reason, targetSurface));
            }
          }
          for (const { ask } of evaluation.asks) {
            directives.push(buildAskDefaultDirective(promptText, ask.rule.id.toUpperCase(), ask.defaultAction));
          }

          if (directives.length > 0) {
            // In-place sobre el texto del prompt (mismo espíritu que la
            // mutación in-place de v1: no reemplazar el objeto prompt).
            input.prompt.text = `${promptText}\n\n${directives.join('\n\n')}`;
          }
        } catch {
          // Paridad con el input hook de Pi: ante error interno no se altera el
          // mensaje; la barrera de herramientas sigue protegiendo las escrituras.
        }
      })
    );

    // Barrera de escritura fail-closed: throw = bloqueo (v2: ctx.tool.hook
    // "execute.before"; los args de la llamada llegan en call.input).
    registrations.push(
      await ctx.tool.hook('execute.before', async (call) => {
        if (!FILE_WRITE_TOOLS.has(call.tool)) return;

        const targetPath = extractTargetPath(call.input as Record<string, unknown>);
        if (!targetPath.trim()) return;

        try {
          const pbs = await activeMasked();
          const agentPrefs = await storage.getAgentPreferences();

          // Preferencias de agente: never bloquea terminante; ask e invariants
          // exigen autorización interactiva que OpenCode no expone a plugins,
          // por lo que aplican la política determinística headless (fail-closed).
          if (agentPrefs) {
            for (const never of agentPrefs.neverRules || []) {
              if (matchesAgentToolSurface(never.surface, call.tool)) {
                throw new Error(buildAgentNeverBlockReason(never));
              }
            }
            for (const ask of agentPrefs.askRules || []) {
              if (matchesAgentToolSurface(ask.surface, call.tool)) {
                throw new Error(buildAgentAskHeadlessBlockReason(ask));
              }
            }
            for (const inv of agentPrefs.invariants || []) {
              if (matchesAgentToolSurface(inv.surface, call.tool)) {
                throw new Error(buildAgentInvariantHeadlessBlockReason(inv, call.tool));
              }
            }
          }

          for (const pb of pbs) {
            const pathViolation = checkPathViolation(targetPath, pb, cwd());
            if (pathViolation) {
              throw new Error(buildPathViolationBlockReason(targetPath, pathViolation as never));
            }
          }
        } catch (err) {
          // Fail-closed: cualquier error bloquea. Los bloqueos de gobernanza se
          // reenvían con su razón exacta; los errores internos se envuelven.
          const message = err instanceof Error ? err.message : String(err);
          if (message.startsWith('Operación bloqueada')) throw err;
          throw new Error(`Error interno en la barrera de gobernanza: ${message}`);
        }
      })
    );

    // Exclusivo de OpenCode: las normas activas sobreviven a la compactación
    // como contexto del request de compactación (v2: hook "compaction").
    registrations.push(
      await ctx.session.hook('compaction', async (input) => {
        const pbs = await activeHierarchy();
        if (pbs.length === 0) return;
        input.system.push({ type: 'text', text: buildSystemGuidance(pbs) });
      })
    );

    // Cleanup v2: libera todos los registros al descargar el plugin.
    return async () => {
      await Promise.all(registrations.map((r) => r.dispose()));
    };
  },
});
