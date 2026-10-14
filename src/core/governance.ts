// Módulo de gobernanza compartido entre runtimes (Pi y OpenCode).
// Toda la lógica aquí es agnóstica al runtime: no importa APIs de Pi ni de
// OpenCode. Los textos de directivas y bloqueos son idénticos byte a byte al
// comportamiento histórico de la extensión Pi para garantizar paridad de
// enforcement entre ambos runtimes.

import { AGENTS_PREFERENCES_ID, Playbook } from './schema.js';
import {
  AskTriggerMatch,
  ViolationKind,
  ViolationMatch,
  checkAskTrigger,
  evaluatePromptFull,
} from './checker.js';

// ---------------------------------------------------------------------------
// Puntero de system prompt (Eje 4)
// ---------------------------------------------------------------------------

/**
 * Construye la directiva liviana de system prompt que orienta al modelo a
 * consultar `playbook_consult` antes de estructurar, planificar o modificar.
 * Pi la inyecta en `systemPromptOptions.sections.playbook_guidance`;
 * OpenCode la agrega vía `experimental.chat.system.transform`.
 */
export function buildSystemGuidance(playbooks: Playbook[]): string {
  const targets: string[] = [];
  for (const pb of playbooks) {
    if (pb.scope === 'project' || pb.language === 'project') {
      targets.push('playbook local (playbook.md)');
    } else if (pb.scope === 'stack' || pb.stackId) {
      targets.push(`stack ${pb.stackName || pb.stackId}`);
    } else if (pb.language === AGENTS_PREFERENCES_ID) {
      targets.push('preferencias de gobernanza de agente');
    } else {
      targets.push(`playbook de ${pb.language.toUpperCase()}`);
    }
  }

  return (
    `[gentle-playbook] Este workspace cuenta con normas activas (${targets.join(', ')}). ` +
    `Antes de estructurar, planificar, generar o modificar código o ejecutar acciones operativas en este proyecto, ` +
    `debes consultar la herramienta \`playbook_consult\` para conocer la topología, invariantes, estándares y prohibiciones vinculantes del repositorio.`
  );
}

/**
 * Nombre de presentación de un playbook para mensajes de gobernanza.
 */
export function playbookDisplayName(pb: Playbook): string {
  return pb.language === AGENTS_PREFERENCES_ID ? 'Agents Preferences' : pb.language.toUpperCase();
}

// ---------------------------------------------------------------------------
// Pre-vuelo determinístico del prompt (Eje 1)
// ---------------------------------------------------------------------------

export interface PreflightViolation {
  playbook: Playbook;
  violation: ViolationMatch;
}

export interface PreflightAsk {
  playbook: Playbook;
  ask: AskTriggerMatch;
}

export interface WorkspacePromptEvaluation {
  violations: PreflightViolation[];
  asks: PreflightAsk[];
}

/**
 * Evalúa el prompt del usuario contra todas las capas activas y recolecta
 * violaciones y reglas ASK disparadas, sin ramas interactivas. Cada runtime
 * compone después su propia política (TUI interactiva en Pi, transform
 * determinístico o agente-mediado en OpenCode).
 *
 * La evaluación es estrictamente determinística y en memoria (<1ms): nunca
 * invoca APIs de LLM síncronas.
 */
export async function evaluateWorkspacePrompt(
  promptText: string,
  playbooksToCheck: Playbook[]
): Promise<WorkspacePromptEvaluation> {
  const violations: PreflightViolation[] = [];
  const asks: PreflightAsk[] = [];

  if (!promptText || !promptText.trim()) {
    return { violations, asks };
  }

  for (const pb of playbooksToCheck) {
    const evaluation = await evaluatePromptFull(promptText, pb);
    if (evaluation.violation) {
      violations.push({ playbook: pb, violation: evaluation.violation });
    } else {
      const askMatch = evaluation.triggeredAsk || checkAskTrigger(promptText, pb);
      if (askMatch) {
        asks.push({ playbook: pb, ask: askMatch });
      }
    }
  }

  return { violations, asks };
}

/**
 * Indica si la violación es un intento explícito de eludir checkpoints o
 * apagar el playbook (bypass), que exige confirmación interactiva o
 * falla cerrada en entornos desatendidos.
 */
export function isBypassViolation(violation: ViolationMatch): boolean {
  return (
    violation.kind === 'checkpoint_bypass' ||
    violation.kind === 'playbook_bypass' ||
    violation.kind === 'agent_governance_violation'
  );
}

/**
 * Mensaje fail-closed visible para intentos de bypass en entornos
 * desatendidos. Nunca es un aborto mudo.
 */
export function buildBypassBlockedMessage(): string {
  return (
    '❌ [GOBERNANZA PLAYBOOK] Operación bloqueada: No se permite omitir puntos de control ' +
    '("sin consultar") en entornos desatendidos sin confirmación interactiva.'
  );
}

/**
 * Directiva de gobernanza para intentos de bypass en runtimes que no pueden
 * cancelar el mensaje del usuario (OpenCode: `chat.message` no bloquea el
 * envío). El intento queda visible para el modelo con los controles activos,
 * y la barrera de herramientas mantiene el enforcement real (fail-closed en
 * `tool.execute.before`).
 */
export function buildBypassGovernanceDirective(ruleId: string, reason: string): string {
  return (
    `[DIRECTIVA DE GOBERNANZA PLAYBOOK]: Se detectó un intento de eludir el control [${ruleId}]: ${reason}. ` +
    `Los controles de gobernanza permanecen activos: no omitas los checkpoints del playbook, ` +
    `consulta \`playbook_consult\` y construye el requerimiento respetando la arquitectura canónica. ` +
    `La barrera de herramientas bloqueará toda escritura que viole las reglas.`
  );
}

/**
 * Directiva de redirección canónica para conflictos de superficie/kit en modo
 * desatendido. Jamás aborta en mudo: orienta al modelo a construir el feature
 * base en la superficie canónica del playbook.
 */
export function buildHeadlessRedirectDirective(
  promptText: string,
  ruleId: string,
  reason: string,
  targetSurface: string
): string {
  return (
    `[ADVERTENCIA DE GOBERNANZA PLAYBOOK]: El requerimiento entra en conflicto con la regla [${ruleId}]: ${reason}. ` +
    `En modo desatendido se aplica la arquitectura canónica: implementa el feature solicitado ("${promptText}") ` +
    `ubicando el código exclusivamente en "${targetSurface}" y sin usar las tecnologías prohibidas. ` +
    `Detalla esta decisión al inicio de tu respuesta.`
  );
}

/**
 * Directiva de acción por defecto para reglas ASK en modo desatendido,
 * garantizando que el feature base solicitado nunca quede en inanición.
 */
export function buildAskDefaultDirective(promptText: string, askId: string, defaultAction: string): string {
  return (
    `[DIRECTIVA DE GOBERNANZA PLAYBOOK]: Ejecución desatendida. Para la regla [ASK:${askId}], ` +
    `aplica la acción por defecto: "${defaultAction}". ` +
    `Implementa completamente el requerimiento base solicitado ("${promptText}") respetando este default.`
  );
}

// ---------------------------------------------------------------------------
// Barrera de escritura (Eje 1: tool_call / tool.execute.before)
// ---------------------------------------------------------------------------

/**
 * Determina si la superficie declarada en una regla de preferencias de
 * agente aplica a la herramienta invocada. Soporta `tools:all`,
 * `tools:<acción>`, los alias `tools:write`/`tools:edit`, el prefijo
 * genérico `tools` y listas separadas por comas, todo case-insensitive.
 */
export function matchesAgentToolSurface(ruleSurface: string | undefined, toolAction: string): boolean {
  if (!ruleSurface) return false;
  const surfaces = ruleSurface.toLowerCase().split(',').map((s) => s.trim());
  return surfaces.some(
    (s) =>
      s === 'tools:all' ||
      s === `tools:${toolAction}` ||
      s === 'tools:write' ||
      s === 'tools:edit' ||
      s === 'tools'
  );
}

/**
 * Razón de bloqueo para prohibiciones terminantes de herramientas (never).
 */
export function buildAgentNeverBlockReason(never: { id: string; description: string }): string {
  return `Operación bloqueada por prohibición de agente [${never.id.toUpperCase()}]: ${never.description}`;
}

/**
 * Razón de bloqueo headless para puntos de control condicionales (ask) de
 * preferencias de agente.
 */
export function buildAgentAskHeadlessBlockReason(ask: { id: string; defaultAction: string }): string {
  return `Operación bloqueada en modo desatendido por punto de control [${ask.id.toUpperCase()}]: ${ask.defaultAction}`;
}

/**
 * Razón de bloqueo headless para límites operativos obligatorios
 * (invariants) de preferencias de agente, nombrando la acción.
 */
export function buildAgentInvariantHeadlessBlockReason(
  inv: { id: string; description: string },
  toolAction: string
): string {
  return `Operación bloqueada: la acción "${toolAction}" requiere autorización interactiva según la regla [${inv.id.toUpperCase()}]: ${inv.description}`;
}

/**
 * Razón de bloqueo fail-safe para violaciones de superficie de ruta,
 * indicando dónde debe ubicarse el código.
 */
export function buildPathViolationBlockReason(
  targetPath: string,
  violation: { rule: { id: string; description: string; surface?: string } }
): string {
  return (
    `Operación bloqueada: la ruta "${targetPath}" viola la regla [${violation.rule.id.toUpperCase()}]: ` +
    `${violation.rule.description}. Debes ubicar este código exclusivamente dentro de "${violation.rule.surface}".`
  );
}
