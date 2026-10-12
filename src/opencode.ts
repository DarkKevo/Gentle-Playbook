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
import {
  getActiveWorkspacePlaybooks,
  maskSubordinatePlaybooks,
} from './core/stack-handler.js';
import { checkPathViolation } from './core/checker.js';
import { AGENTS_PREFERENCES_ID } from './core/schema.js';
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
