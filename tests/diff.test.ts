import { describe, it, expect } from 'vitest';
import { computePlaybookDiff, mergePlaybooks } from '../src/core/diff.js';
import { Playbook } from '../src/core/schema.js';

describe('Diffing & Deduplication Engine', () => {
  const existingPlaybook: Playbook = {
    language: 'go',
    version: 1,
    updatedAt: '2025-01-01',
    topology: {
      pattern: 'Hexagonal',
      directories: ['cmd/api/', 'internal/core/ports/'],
    },
    invariants: [
      {
        id: 'null-byte-sanitizer',
        type: 'invariant',
        title: 'Middleware Sanitización Bytes Nulos',
        surface: 'internal/adapters/handlers/',
        description: 'Rechazar bytes nulos en peticiones HTTP.',
      },
    ],
    askRules: [
      {
        id: 'rate-limiting',
        type: 'ask',
        title: 'Rate Limiter',
        surface: 'internal/adapters/handlers/',
        trigger: 'Endpoints públicos',
        antiTrigger: 'Rutas privadas',
        prompt: '¿Aplicar rate limit?',
        defaultAction: 'Omitir',
        description: 'Limitar peticiones',
      },
    ],
    snippets: [],
  };

  const incomingPlaybook: Playbook = {
    language: 'go',
    version: 1,
    updatedAt: '2025-02-18',
    topology: {
      pattern: 'Modular Hexagonal',
      directories: ['cmd/api/', 'internal/core/ports/', 'internal/adapters/storage/'],
    },
    invariants: [
      // Identical invariant
      {
        id: 'null-byte-sanitizer',
        type: 'invariant',
        title: 'Middleware Sanitización Bytes Nulos',
        surface: 'internal/adapters/handlers/',
        description: 'Rechazar bytes nulos en peticiones HTTP.',
      },
      // New invariant
      {
        id: 'dto-notblank',
        type: 'invariant',
        title: 'Validación NotBlank',
        surface: 'internal/adapters/handlers/dto/',
        description: 'Validar campo no vacío ni con espacios.',
      },
    ],
    askRules: [
      // Conflict ask rule (modified prompt and trigger)
      {
        id: 'rate-limiting',
        type: 'ask',
        title: 'Rate Limiter',
        surface: 'internal/adapters/handlers/',
        trigger: 'Endpoints públicos sensibles como /login',
        antiTrigger: 'Rutas privadas con JWT',
        prompt: 'Detecto endpoint público. ¿Aplicar rate limit estándar?',
        defaultAction: 'Omitir',
        description: 'Limitar peticiones',
      },
      // New ask rule (RBAC)
      {
        id: 'rbac-auth',
        type: 'ask',
        title: 'RBAC Authorization',
        surface: 'internal/adapters/handlers/',
        trigger: 'Rutas con privilegios',
        antiTrigger: 'Rutas públicas',
        prompt: '¿Aplicar RBAC?',
        defaultAction: 'Omitir',
        description: 'Roles',
      },
    ],
    snippets: [],
  };

  it('should accurately compute diff between existing and incoming playbook', () => {
    const diff = computePlaybookDiff(incomingPlaybook, existingPlaybook);

    expect(diff.topologyChanged).toBe(true);
    expect(diff.invariants).toHaveLength(2);

    const identicalInv = diff.invariants.find((i) => i.incoming.id === 'null-byte-sanitizer');
    expect(identicalInv?.status).toBe('identical');

    const newInv = diff.invariants.find((i) => i.incoming.id === 'dto-notblank');
    expect(newInv?.status).toBe('new');

    const conflictAsk = diff.askRules.find((a) => a.incoming.id === 'rate-limiting');
    expect(conflictAsk?.status).toBe('conflict');
    expect(conflictAsk?.reason).toContain('Trigger differs');

    const newAsk = diff.askRules.find((a) => a.incoming.id === 'rbac-auth');
    expect(newAsk?.status).toBe('new');
  });

  it('should merge playbooks cleanly with conversions and deduplication', () => {
    const merged = mergePlaybooks(incomingPlaybook, existingPlaybook, {
      // Convert incoming invariant 'dto-notblank' to an Ask rule
      'dto-notblank': {
        ruleId: 'dto-notblank',
        action: 'convert_to_ask',
        customPrompt: '¿Deseas validar DTOs con NotBlank?',
      },
      // Convert incoming ask 'rbac-auth' to an Invariant
      'rbac-auth': {
        ruleId: 'rbac-auth',
        action: 'convert_to_invariant',
      },
      // Accept updated rate-limiting
      'rate-limiting': {
        ruleId: 'rate-limiting',
        action: 'accept',
      },
    });

    expect(merged.version).toBe(2);

    // Invariants should contain null-byte-sanitizer AND converted rbac-auth
    expect(merged.invariants.some((i) => i.id === 'null-byte-sanitizer')).toBe(true);
    expect(merged.invariants.some((i) => i.id === 'rbac-auth')).toBe(true);
    // dto-notblank must NOT be in invariants
    expect(merged.invariants.some((i) => i.id === 'dto-notblank')).toBe(false);

    // Ask rules should contain rate-limiting (updated) AND converted dto-notblank
    const askDto = merged.askRules.find((a) => a.id === 'dto-notblank');
    expect(askDto).toBeDefined();
    expect(askDto?.prompt).toBe('¿Deseas validar DTOs con NotBlank?');

    const askRate = merged.askRules.find((a) => a.id === 'rate-limiting');
    expect(askRate?.trigger).toBe('Endpoints públicos sensibles como /login');

    // Combined directories
    expect(merged.topology.directories).toContain('internal/adapters/storage/');
  });
});
