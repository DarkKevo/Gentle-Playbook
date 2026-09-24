import { InvariantRule, AskRule, RuleType } from './schema.js';

export interface SynthesizedRule {
  type: RuleType;
  id: string;
  title: string;
  surface: string;
  description: string;
  // Ask specific
  trigger?: string;
  antiTrigger?: string;
  prompt?: string;
  defaultAction?: string;
}

export function buildSynthesisPrompt(
  language: string,
  userDescription: string,
  ruleType: RuleType
): string {
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
  ruleType: RuleType
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

  if (ruleType === 'invariant') {
    return {
      type: 'invariant',
      id: parsed.id || 'custom-invariant',
      title: parsed.title || 'Normativa de Arquitectura',
      surface: parsed.surface || '',
      description: parsed.description || parsed.rule || '',
    };
  } else {
    return {
      type: 'ask',
      id: parsed.id || 'custom-ask',
      title: parsed.title || 'Regla Condicional',
      surface: parsed.surface || '',
      description: parsed.description || parsed.prompt || '',
      trigger: parsed.trigger || '',
      antiTrigger: parsed.antiTrigger || '',
      prompt: parsed.prompt || '',
      defaultAction: parsed.defaultAction || 'Omitir regla',
    };
  }
}
