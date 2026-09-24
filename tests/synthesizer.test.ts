import { describe, it, expect } from 'vitest';
import { buildSynthesisPrompt, parseSynthesizedRule } from '../src/core/synthesizer.js';

describe('Rule Synthesizer', () => {
  it('should generate appropriate synthesis prompts', () => {
    const invPrompt = buildSynthesisPrompt('go', 'validar bytes nulos', 'invariant');
    expect(invPrompt).toContain('NORMATIVA');
    expect(invPrompt).toContain('validar bytes nulos');

    const askPrompt = buildSynthesisPrompt('go', 'rate limit en rutas publicas', 'ask');
    expect(askPrompt).toContain('ASK');
    expect(askPrompt).toContain('antiTrigger');
  });

  it('should parse raw JSON block for an invariant rule', () => {
    const raw = `
\`\`\`json
{
  "id": "rate-limit-auth",
  "title": "Rate Limiting en Autenticación",
  "surface": "internal/adapters/handlers/",
  "description": "Aplicar límite de peticiones en rutas de login."
}
\`\`\`
`;
    const rule = parseSynthesizedRule(raw, 'invariant');
    expect(rule.type).toBe('invariant');
    expect(rule.id).toBe('rate-limit-auth');
    expect(rule.surface).toBe('internal/adapters/handlers/');
  });

  it('should parse raw JSON block for an ask rule', () => {
    const raw = JSON.stringify({
      id: 'rate-limit-ask',
      title: 'Rate Limiter Condicional',
      surface: 'internal/adapters/handlers/',
      trigger: 'Endpoints públicos de autenticación',
      antiTrigger: 'Rutas privadas o tareas batch',
      prompt: '¿Deseas aplicar rate limit a este endpoint?',
      defaultAction: 'Continuar sin rate limit',
    });

    const rule = parseSynthesizedRule(raw, 'ask');
    expect(rule.type).toBe('ask');
    expect(rule.trigger).toBe('Endpoints públicos de autenticación');
    expect(rule.antiTrigger).toBe('Rutas privadas o tareas batch');
    expect(rule.prompt).toBe('¿Deseas aplicar rate limit a este endpoint?');
  });
});
