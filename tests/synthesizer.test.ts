import { describe, it, expect } from 'vitest';
import {
  buildSynthesisPrompt,
  parseSynthesizedRule,
  isProhibitionDescription,
} from '../src/core/synthesizer.js';

describe('Rule Synthesizer', () => {
  it('should detect prohibition intent semantically', () => {
    expect(isProhibitionDescription('no usar el framework gin')).toBe(true);
    expect(isProhibitionDescription('prohibido usar gorm en repositorios')).toBe(true);
    expect(isProhibitionDescription('evitar frameworks externos pesados')).toBe(true);
    expect(isProhibitionDescription('never use external routers')).toBe(true);
    expect(isProhibitionDescription('no quiero dependencias de terceros')).toBe(true);

    expect(isProhibitionDescription('usar patrón hexagonal con puertos y adaptadores')).toBe(false);
    expect(isProhibitionDescription('aplicar rate limit a rutas de login')).toBe(false);
  });

  it('should generate appropriate synthesis prompts for never rules with scopes', () => {
    const specificPrompt = buildSynthesisPrompt('go', 'no usar gin', 'never', {
      prohibitionScope: 'specific',
    });
    expect(specificPrompt).toContain('PROHIBICIÓN ARQUITECTÓNICA ESTRICTA');
    expect(specificPrompt).toContain('ALCANCE ESPECÍFICO');

    const categoricalPrompt = buildSynthesisPrompt('go', 'no usar gin', 'never', {
      prohibitionScope: 'categorical',
    });
    expect(categoricalPrompt).toContain('ALCANCE CATEGÓRICO / FAMILIA');
    expect(categoricalPrompt).toContain('Chi, Echo, Fiber');

    const customPrompt = buildSynthesisPrompt('go', 'no usar orms', 'never', {
      prohibitionScope: 'custom',
      customScopeText: 'salvo en scripts de migración aislados',
    });
    expect(customPrompt).toContain('ALCANCE PERSONALIZADO');
    expect(customPrompt).toContain('salvo en scripts de migración aislados');
  });

  it('should parse raw JSON block for a never rule', () => {
    const raw = `
\`\`\`json
{
  "id": "no-gin",
  "title": "Prohibido el uso de Gin",
  "surface": "dependencies",
  "description": "No usar el framework Gin; usar net/http de la biblioteca estándar.",
  "reason": "Mantener dependencias mínimas y stdlib nativa."
}
\`\`\`
`;
    const rule = parseSynthesizedRule(raw, 'never');
    expect(rule.type).toBe('never');
    expect(rule.id).toBe('no-gin');
    expect(rule.title).toBe('Prohibido el uso de Gin');
    expect(rule.description).toContain('net/http');
    expect(rule.reason).toContain('stdlib');
  });

  it('should generate appropriate synthesis prompts', () => {
    const invPrompt = buildSynthesisPrompt('go', 'validar bytes nulos', 'invariant');
    expect(invPrompt).toContain('NORMATIVA');
    expect(invPrompt).toContain('validar bytes nulos');

    const askPrompt = buildSynthesisPrompt('go', 'rate limit en rutas publicas', 'ask');
    expect(askPrompt).toContain('ASK');
    expect(askPrompt).toContain('antiTrigger');

    const agentInvPrompt = buildSynthesisPrompt('agents-preferences', 'no hacer write sin aprobacion', 'invariant');
    expect(agentInvPrompt).toContain('supervisor de gobernanza operativa');
    expect(agentInvPrompt).toContain('tools:write');

    const agentAskPrompt = buildSynthesisPrompt('agents-preferences', 'preguntar antes de borrar archivos', 'ask');
    expect(agentAskPrompt).toContain('punto de control condicional');
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
