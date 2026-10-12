// Entrada del plugin para OpenCode: adapter twin de la extensión Pi.
//
// Contrato de hooks de @opencode-ai/plugin (declarado estructuralmente, sin
// dependencia del paquete — mismo patrón que ExtensionAPI en index.ts):
//   - tool: { [nombre]: { description, args (zod raw shape), execute } }
//   - "experimental.chat.system.transform": agrega el puntero de playbook_consult
//   - "chat.message": pre-vuelo determinístico; muta el text part in-place
//     (OpenCode no permite cancelar el mensaje: los intentos de bypass quedan
//     visibles como directiva y la barrera de herramientas mantiene el bloqueo)
//   - "tool.execute.before": barrera de escritura fail-closed (throw = bloqueo,
//     patrón probado por los plugins de gentle-ai para OpenCode)
//   - "experimental.session.compacting": inyecta las normas activas como
//     contexto de compactación (exclusivo de OpenCode; Pi no lo necesita)
//
// Toda la lógica de decisión y los textos provienen de core/governance.ts,
// compartida con la extensión Pi: paridad de enforcement byte a byte.

import * as z from 'zod';
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
// Tipos estructurales del contrato de OpenCode (sin importar el paquete)
// ---------------------------------------------------------------------------

export interface OpenCodePluginInput {
  project?: unknown;
  client?: unknown;
  $?: unknown;
  serverUrl?: unknown;
  directory: string;
  worktree: string;
}

export interface OpenCodeToolContext {
  sessionID?: string;
  messageID?: string;
  agent?: string;
  directory: string;
  worktree: string;
  abort?: AbortSignal;
  metadata?(input: { title?: string; metadata?: Record<string, unknown> }): void;
}

export type OpenCodeToolResult =
  | string
  | { title?: string; output: string; metadata?: Record<string, unknown> };

export interface OpenCodeToolDefinition {
  description: string;
  args: Record<string, z.ZodTypeAny>;
  execute(args: Record<string, unknown>, context: OpenCodeToolContext): Promise<OpenCodeToolResult>;
}

export interface OpenCodeHooks {
  tool?: Record<string, OpenCodeToolDefinition>;
  'chat.message'?(
    input: { sessionID: string; agent?: string },
    output: { message: Record<string, unknown>; parts: Array<Record<string, unknown>> }
  ): Promise<void>;
  'tool.execute.before'(
    input: { tool: string; sessionID: string; callID: string },
    output: { args: Record<string, unknown> }
  ): Promise<void>;
  'experimental.chat.system.transform'(
    input: { sessionID?: string },
    output: { system: string[] }
  ): Promise<void>;
  'experimental.session.compacting'(
    input: { sessionID: string },
    output: { context: string[]; prompt?: string }
  ): Promise<void>;
}

export type OpenCodePlugin = (input: OpenCodePluginInput) => Promise<OpenCodeHooks>;

// ---------------------------------------------------------------------------
// Utilidades de adaptación
// ---------------------------------------------------------------------------

/** Herramientas de OpenCode que escriben archivos en disco. */
const FILE_WRITE_TOOLS = new Set(['write', 'edit', 'patch']);

/** Extrae el texto plano de los text parts del mensaje del usuario. */
function extractPartsText(parts: Array<Record<string, unknown>>): string {
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('\n');
}

/**
 * Agrega la directiva al primer text part mutándolo in-place. Evita pushear
 * parts nuevas al arreglo (intermitentemente reportado por opencode#23440).
 * Si no existe ningún text part, hace un push de mejor esfuerzo.
 */
function appendDirectiveToParts(parts: Array<Record<string, unknown>>, directiveBlock: string): void {
  if (!Array.isArray(parts)) return;
  const firstText = parts.find((p) => p && p.type === 'text' && typeof p.text === 'string');
  if (firstText) {
    firstText.text = `${firstText.text as string}\n\n${directiveBlock}`;
    return;
  }
  parts.push({ type: 'text', text: directiveBlock });
}

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
  language: string
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

  if (normalized === 'project' || normalized === 'local') {
    const pb = await storage.getLocalProjectPlaybook(cwd);
    return {
      scope: 'project',
      key: 'project',
      label: 'PROYECTO LOCAL (playbook.md)',
      isNew: !pb,
      playbook: pb || skeleton({ language: 'project', scope: 'project' }),
    };
  }

  if (normalized === 'agents' || normalized === AGENTS_PREFERENCES_ID) {
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

  if (normalized && (await storage.hasStack(normalized))) {
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
      if (lang === 'project' || lang === 'local') {
        throw new Error('El playbook local (playbook.md) es un archivo del repositorio: editá o borrá el archivo directamente.');
      }
      const target = await resolveManageTarget(storage, cwd, lang);
      if (target.isNew) return `El playbook ${target.label} no existe: nada que eliminar.`;
      await storage.deletePlaybook(target.key);
      return `✓ Playbook ${target.label} eliminado por completo.`;
    }

    if (!args.ruleId) throw new Error('playbook_manage delete requiere ruleId (o whole=true para el playbook completo)');
    if (lang === 'project' || lang === 'local') {
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
  const target = await resolveManageTarget(storage, cwd, args.language || '');

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

const GentlePlaybookPlugin: OpenCodePlugin = async ({ directory, worktree }) => {
  const storage = new PlaybookStorage();
  const cwd = () => worktree || directory;

  /** Jerarquía completa del workspace (Local > Stack > Global > Agente). */
  const activeHierarchy = () => getActiveWorkspacePlaybooks(cwd(), storage);

  /** Capas activas con enmascaramiento local por superficie (para enforcement). */
  const activeMasked = async () => maskSubordinatePlaybooks(await activeHierarchy());

  return {
    // Herramienta on-demand compartida con Pi: mismos datos pasivos de
    // referencia, sin inyección en system prompt.
    tool: {
      playbook_consult: {
        description:
          'Consult architectural conventions, topology constraints, coding invariants, conditional asks, prohibitions, and agent supervision preferences for the project or language. Returns passive reference data without system prompt injection.',
        args: {
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
        },
        async execute(args, context) {
          const consultCwd = context.worktree || context.directory || cwd();
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

          return results.join('\n\n---\n\n');
        },
      },
      // Mutaciones agente-mediadas: el agente sintetiza la regla conversando
    // con el usuario, muestra el preview, confirma y persiste. Reemplaza los
    // wizards interactivos de Pi (OpenCode no expone UI a plugins).
    playbook_manage: {
      description:
        'Preview, save, or delete architectural rules and playbooks. Two-phase flow: action=preview validates the rule content (injection filter), checks collisions across active layers, and returns a preview WITHOUT writing to disk; then the agent asks the user for confirmation and calls action=save with the same arguments to persist. action=delete removes a rule by ruleId or a whole playbook with whole=true. Target language accepts a global language (go, typescript...), a stack slug, "agents", or "project" for the local playbook.md.',
      args: {
        action: z.enum(['preview', 'save', 'delete']).describe('preview (no disk write), save (persist), delete'),
        language: z
          .string()
          .optional()
          .describe("Target: language (e.g. 'go'), stack slug, 'agents', or 'project' for the local playbook.md"),
        ruleId: z.string().optional().describe('Rule id to delete (with action=delete)'),
        whole: z.boolean().optional().describe('Delete the whole playbook (with action=delete)'),
        rule: z
          .object({
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
          })
          .optional()
          .describe('The synthesized rule (required for preview/save)'),
      },
      async execute(args, context) {
        const manageCwd = context.worktree || context.directory || cwd();
        return executePlaybookManage(storage, manageCwd, args as never);
      },
    },
    },

    // Puntero liviano en system prompt: mismo texto que Pi inyecta en
    // systemPromptOptions.sections.playbook_guidance.
    'experimental.chat.system.transform': async (_input, output) => {
      const pbs = await activeHierarchy();
      if (pbs.length === 0) return;
      output.system.push(buildSystemGuidance(pbs));
    },

    // Pre-vuelo determinístico del prompt. OpenCode no permite cancelar el
    // mensaje desde un plugin: cada conflicto queda como directiva visible y
    // el enforcement real vive en la barrera de herramientas.
    'chat.message': async (_input, output) => {
      try {
        const promptText = extractPartsText(output.parts as Array<Record<string, unknown>>);
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
          appendDirectiveToParts(output.parts as Array<Record<string, unknown>>, directives.join('\n\n'));
        }
      } catch {
        // Paridad con el input hook de Pi: ante error interno no se altera el
        // mensaje; la barrera de herramientas sigue protegiendo las escrituras.
      }
    },

    // Barrera de escritura fail-closed: throw = bloqueo.
    'tool.execute.before': async (input, output) => {
      if (!FILE_WRITE_TOOLS.has(input.tool)) return;

      const targetPath = extractTargetPath(output.args);
      if (!targetPath.trim()) return;

      try {
        const pbs = await activeMasked();
        const agentPrefs = await storage.getAgentPreferences();

        // Preferencias de agente: never bloquea terminante; ask e invariants
        // exigen autorización interactiva que OpenCode no expone a plugins,
        // por lo que aplican la política determinística headless (fail-closed).
        if (agentPrefs) {
          for (const never of agentPrefs.neverRules || []) {
            if (matchesAgentToolSurface(never.surface, input.tool)) {
              throw new Error(buildAgentNeverBlockReason(never));
            }
          }
          for (const ask of agentPrefs.askRules || []) {
            if (matchesAgentToolSurface(ask.surface, input.tool)) {
              throw new Error(buildAgentAskHeadlessBlockReason(ask));
            }
          }
          for (const inv of agentPrefs.invariants || []) {
            if (matchesAgentToolSurface(inv.surface, input.tool)) {
              throw new Error(buildAgentInvariantHeadlessBlockReason(inv, input.tool));
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
    },

    // Exclusivo de OpenCode: las normas activas sobreviven a la compactación
    // como contexto del resumen de continuación.
    'experimental.session.compacting': async (_input, output) => {
      const pbs = await activeHierarchy();
      if (pbs.length === 0) return;
      output.context.push(buildSystemGuidance(pbs));
    },
  };
};

export default GentlePlaybookPlugin;
