import { RuleType, AGENTS_PREFERENCES_ID } from './schema.js';

export interface SynthesizedRule {
  type: RuleType;
  id: string;
  title: string;
  surface: string;
  description: string;
  reason?: string;
  // Ask specific
  trigger?: string;
  antiTrigger?: string;
  prompt?: string;
  defaultAction?: string;
}

export type ProhibitionScope = 'specific' | 'categorical' | 'custom';

export interface SynthesisOptions {
  prohibitionScope?: ProhibitionScope;
  customScopeText?: string;
}

/**
 * Heurística semántica para detectar si la descripción expresa intención de prohibición,
 * inhibición, veto o rechazo de una tecnología, patrón o acción.
 */
export function isProhibitionDescription(text: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  const patterns = [
    /\b(?:no\s+(?:usar|utilizar|meter|agregar|instalar|importar|permitir|hacer|tocar))\b/i,
    /\b(?:prohibid[oa]|prohibir|vetad[oa]|vetar)\b/i,
    /\b(?:evitar|impedir|restringir|rechazar)\b/i,
    /\b(?:no\s+quiero|no\s+se\s+debe|nunca\s+(?:usar|hacer|instalar))\b/i,
    /\b(?:never\s+use|do\s+not\s+use|don't\s+use|avoid|prohibit|ban|disallow)\b/i,
  ];
  return patterns.some((p) => p.test(lower));
}

export function buildSynthesisPrompt(
  language: string,
  userDescription: string,
  ruleType: RuleType,
  options: SynthesisOptions = {}
): string {
  const isAgentGovernance = language === AGENTS_PREFERENCES_ID || language === 'agents-preferences';

  if (isAgentGovernance) {
    if (ruleType === 'never') {
      let scopeGuidance = '';
      if (options.prohibitionScope === 'specific') {
        scopeGuidance = 'La prohibición es ESPECÍFICA para esta acción o herramienta puntual, sin extender a otras.';
      } else if (options.prohibitionScope === 'categorical') {
        scopeGuidance = 'La prohibición es CATEGÓRICA / DE FAMILIA: Veta esta acción y cualquier práctica o herramienta análoga.';
      } else if (options.prohibitionScope === 'custom' && options.customScopeText) {
        scopeGuidance = `El usuario especificó el siguiente alcance exacto: "${options.customScopeText}".`;
      }

      return `Eres un supervisor de gobernanza operativa de agentes de IA.
El usuario quiere registrar una RESTRICCIÓN / PROHIBICIÓN TERMINANTE (Never Rule) en su Playbook de Gobernanza.
Esta regla veta terminantemente una acción, comando o práctica para el agente.
${scopeGuidance}

Preferencia del usuario:
"${userDescription}"

Devuelve ÚNICAMENTE un bloque JSON válido (sin explicaciones adicionales, sin markdown extra) con esta estructura:
{
  "id": "slug-identificador-corto (ej: no-direct-push)",
  "title": "Título conciso y profesional de la restricción",
  "surface": "herramienta o acción operativa afectada (ej: tools:bash, git:push, tools:write)",
  "description": "Redacción técnica y terminante de la acción estrictamente prohibida que el agente NUNCA debe ejecutar",
  "reason": "Motivo de gobernanza y seguridad de la restricción"
}`;
    } else if (ruleType === 'invariant') {
      return `Eres un supervisor de gobernanza operativa de agentes de IA.
El usuario quiere registrar una NORMATIVA (Límite operativo no negociable o restricción estricta de comportamiento) para el agente en su Playbook de Gobernanza.
Esta regla supervisa y delimita las acciones del agente sin alterar su filosofía ni esencia.

Preferencia del usuario:
"${userDescription}"

Devuelve ÚNICAMENTE un bloque JSON válido (sin explicaciones adicionales, sin markdown extra) con esta estructura:
{
  "id": "slug-identificador-corto",
  "title": "Título conciso y profesional de la norma",
  "surface": "acción, herramienta o contexto operativo afectado (ej: tools:write,tools:edit, tools:bash, workflow:planning, git:commit)",
  "description": "Redacción técnica y quirúrgica del límite o regla no negociable que el agente debe obedecer estrictamente"
}`;
    } else {
      return `Eres un supervisor de gobernanza operativa de agentes de IA.
El usuario quiere registrar un punto de control condicional tipo ASK (un momento donde el agente debe detenerse y pedir confirmación/pregunta al usuario antes de actuar) en su Playbook de Gobernanza.
Esta regla supervisa y delimita las acciones del agente sin alterar su filosofía ni esencia.

Preferencia del usuario:
"${userDescription}"

Devuelve ÚNICAMENTE un bloque JSON válido (sin explicaciones adicionales, sin markdown extra) con esta estructura:
{
  "id": "slug-identificador-corto",
  "title": "Título conciso y profesional del punto de control",
  "surface": "acción, herramienta o contexto operativo afectado (ej: tools:write,tools:edit, tools:bash, workflow:planning, git:commit)",
  "trigger": "Señal o acción específica del agente que dispara la consulta al usuario (ej: intento de modificar archivos o aplicar cambios)",
  "antiTrigger": "Condición donde NO se debe interrumpir al usuario (ej: tareas de solo lectura, exploración)",
  "prompt": "Pregunta exacta que el agente formulará al usuario para pedir aprobación o decisión",
  "defaultAction": "Qué hacer por defecto si el usuario rechaza la acción o no responde",
  "description": "Resumen técnico de la condición de supervisión"
}`;
    }
  }

  if (ruleType === 'never') {
    let scopeGuidance = '';
    if (options.prohibitionScope === 'specific') {
      scopeGuidance = 'ALCANCE ESPECÍFICO: La prohibición aplica únicamente a este elemento/paquete/librería puntual. No veta el resto de la categoría.';
    } else if (options.prohibitionScope === 'categorical') {
      scopeGuidance = 'ALCANCE CATEGÓRICO / FAMILIA: La prohibición veta este elemento Y cualquier alternativa similar de terceros (ej: si se prohíbe Gin, se prohíbe Gin y cualquier otro router/framework externo como Chi, Echo, Fiber, Gorilla Mux, exigiendo usar la alternativa estándar de la biblioteca del lenguaje o patrón canónico). Redacta explícitamente los ejemplos de la familia para evitar que el LLM use alternativas afines.';
    } else if (options.prohibitionScope === 'custom' && options.customScopeText) {
      scopeGuidance = `ALCANCE PERSONALIZADO: El usuario definió el siguiente alcance exacto: "${options.customScopeText}". Sintetiza la regla respetando estrictamente estos límites.`;
    }

    return `Eres un arquitecto de software senior para ${language}.
El usuario quiere registrar una PROHIBICIÓN ARQUITECTÓNICA ESTRICTA (Never Rule / Restricción de no hacer) en su Playbook de arquitectura.
${scopeGuidance}

Preferencia del usuario:
"${userDescription}"

Devuelve ÚNICAMENTE un bloque JSON válido (sin explicaciones adicionales, sin markdown extra) con esta estructura:
{
  "id": "slug-identificador-corto (ej: no-gin o no-external-routers)",
  "title": "Título conciso y profesional de la prohibición",
  "surface": "capa o superficie afectada (ej: dependencies, internal/ports, architecture)",
  "description": "Redacción técnica y terminante de la prohibición, detallando lo prohibido y la alternativa canónica o estándar requerida",
  "reason": "Motivo arquitectónico de la restricción"
}`;
  }

  if (ruleType === 'invariant') {
    return `Eres un arquitecto de software senior para ${language}.
El usuario quiere registrar una NORMATIVA (Invariante no negociable) en su Playbook de arquitectura.

Preferencia del usuario:
"${userDescription}"

Devuelve ÚNICAMENTE un bloque JSON válido (sin explicaciones adicionales, sin markdown extra) con esta estructura:
{
  "id": "slug-identificador-corto",
  "title": "Título conciso y profesional de la norma",
  "surface": "directorio o capa afectada (ej: internal/adapters/handlers/ o src/shared/)",
  "description": "Redacción técnica y quirúrgica de la regla no negociable"
}`;
  } else {
    return `Eres un arquitecto de software senior para ${language}.
El usuario quiere registrar una regla condicional tipo ASK (un patrón opcional o receta que solo se consulta bajo ciertas condiciones) en su Playbook de arquitectura.

Preferencia del usuario:
"${userDescription}"

Devuelve ÚNICAMENTE un bloque JSON válido (sin explicaciones adicionales, sin markdown extra) con esta estructura:
{
  "id": "slug-identificador-corto",
  "title": "Título conciso y profesional de la regla",
  "surface": "directorio o capa afectada (ej: internal/adapters/handlers/ o src/shared/)",
  "trigger": "Señal o condición técnica específica de activación",
  "antiTrigger": "Condición de veto absoluto (cuándo está PROHIBIDO preguntar)",
  "prompt": "Pregunta exacta que el agente le hará al usuario",
  "defaultAction": "Qué hacer por defecto si el usuario dice no o no contesta",
  "description": "Resumen técnico de la regla opcional"
}`;
  }
}

export function parseSynthesizedRule(
  rawJsonOrMarkdown: string,
  ruleType: RuleType,
  language?: string
): SynthesizedRule {
  let cleaned = rawJsonOrMarkdown.trim();
  const codeBlockMatch = cleaned.match(/```(?:json)?\r?\n([\s\S]*?)\r?\n```/);
  if (codeBlockMatch) {
    cleaned = codeBlockMatch[1].trim();
  } else {
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      cleaned = jsonMatch[0].trim();
    }
  }

  const parsed = JSON.parse(cleaned);
  const isAgentGovernance = language === AGENTS_PREFERENCES_ID || language === 'agents-preferences';

  if (ruleType === 'never') {
    return {
      type: 'never',
      id: parsed.id || 'custom-never',
      title: parsed.title || (isAgentGovernance ? 'Restricción de Operación' : 'Prohibición de Arquitectura'),
      surface: parsed.surface || (isAgentGovernance ? 'tools:all' : 'dependencies'),
      description: parsed.description || parsed.rule || '',
      reason: parsed.reason || '',
    };
  }

  if (ruleType === 'invariant') {
    return {
      type: 'invariant',
      id: parsed.id || 'custom-invariant',
      title: parsed.title || (isAgentGovernance ? 'Normativa de Gobernanza' : 'Normativa de Arquitectura'),
      surface: parsed.surface || (isAgentGovernance ? 'tools:all' : ''),
      description: parsed.description || parsed.rule || '',
    };
  } else {
    return {
      type: 'ask',
      id: parsed.id || 'custom-ask',
      title: parsed.title || (isAgentGovernance ? 'Punto de Control de Agente' : 'Regla Condicional'),
      surface: parsed.surface || (isAgentGovernance ? 'tools:all' : ''),
      description: parsed.description || parsed.prompt || '',
      trigger: parsed.trigger || '',
      antiTrigger: parsed.antiTrigger || '',
      prompt: parsed.prompt || '',
      defaultAction: parsed.defaultAction || 'Omitir regla',
    };
  }
}
