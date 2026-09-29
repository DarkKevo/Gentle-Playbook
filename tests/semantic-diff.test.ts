import { describe, it, expect } from 'vitest';
import {
  computeSemanticPlaybookDiff,
  resolveConflictWithAI,
  buildSemanticDiffPrompt,
  parseSemanticDiffResponse,
} from '../src/core/semantic-diff.js';
import { mergePlaybooks } from '../src/core/diff.js';
import { Playbook } from '../src/core/schema.js';

describe('Semantic Playbook Diff & AI Resolution', () => {
  const existing: Playbook = {
    language: 'typescript',
    version: 1,
    updatedAt: '2026-01-01',
    topology: { pattern: 'Clean Architecture', directories: ['src/'] },
    invariants: [
      {
        id: 'no-any-interfaces',
        type: 'invariant',
        title: 'No usar tipos any',
        surface: 'src/domain/',
        description: 'No usar una interfaz que reciba cualquier tipo de dato (any)',
      },
    ],
    askRules: [],
    snippets: [],
  };

  const incoming: Playbook = {
    language: 'typescript',
    version: 1,
    updatedAt: '2026-03-30',
    topology: { pattern: 'Clean Architecture', directories: ['src/'] },
    invariants: [
      {
        id: 'b6-interfaces-any',
        type: 'invariant',
        title: 'Prohibir any en contratos',
        surface: 'src/types/',
        description: 'No usar interfaces Any en definiciones de dominio',
      },
      {
        id: 'strict-null-checks',
        type: 'invariant',
        title: 'Strict Null Checks',
        surface: 'src/',
        description: 'Habilitar y respetar strictNullChecks',
      },
    ],
    askRules: [],
    snippets: [],
  };

  it('should detect semantic redundancy between differently worded rules as CONFLICT', async () => {
    const mockModelResponse = `
\`\`\`json
{
  "invariants": [
    {
      "incomingId": "b6-interfaces-any",
      "status": "CONFLICT",
      "existingId": "no-any-interfaces",
      "reason": "Redundancia semántica: ambas reglas prohíben el uso de tipos any en interfaces de TypeScript"
    },
    {
      "incomingId": "strict-null-checks",
      "status": "NEW"
    }
  ],
  "askRules": [],
  "neverRules": [],
  "snippets": []
}
\`\`\`
`;

    const diff = await computeSemanticPlaybookDiff(incoming, existing, async () => mockModelResponse);

    expect(diff.stats.conflictRules).toBe(1);
    expect(diff.stats.newRules).toBe(1);

    const conflictInv = diff.invariants.find((i) => i.incoming.id === 'b6-interfaces-any');
    expect(conflictInv?.status).toBe('conflict');
    expect(conflictInv?.reason).toContain('Redundancia semántica');
    expect(conflictInv?.existing?.id).toBe('no-any-interfaces');

    const newInv = diff.invariants.find((i) => i.incoming.id === 'strict-null-checks');
    expect(newInv?.status).toBe('new');
  });

  it('should abort and throw "Ha habido un problema con tu agente, reintenta." when agent fails or disconnects', async () => {
    // El agente falla o devuelve salida inválida -> Se aborta la operación directamente sin diff sintáctico
    await expect(
      computeSemanticPlaybookDiff(incoming, existing, async () => 'Error del modelo: timeout')
    ).rejects.toThrow('Ha habido un problema con tu agente, reintenta.');
  });

  it('should synthesize a unified rule when resolving conflict with AI', async () => {
    const mockAiResolved = `
\`\`\`json
{
  "title": "Prohibición Absoluta de Any en Interfaces",
  "surface": "src/domain/",
  "description": "Prohibido el uso de tipos o interfaces genéricas any; tipar explícitamente con genéricos o unknown"
}
\`\`\`
`;

    const result = await resolveConflictWithAI({
      ruleType: 'invariant',
      language: 'typescript',
      existingRule: existing.invariants[0],
      incomingRule: incoming.invariants[0],
      userInstruction: 'fusiona ambas diciendo que se prohíbe any y se debe tipar con unknown',
      completePrompt: async () => mockAiResolved,
    });

    expect(result.title).toBe('Prohibición Absoluta de Any en Interfaces');
    expect(result.surface).toBe('src/domain/');
    expect(result.description).toContain('unknown');
  });

  it('should pass precomputed semantic diff into mergePlaybooks and apply custom_edit to target existing rule', async () => {
    const mockModelResponse = `
\`\`\`json
{
  "invariants": [
    {
      "incomingId": "b6-interfaces-any",
      "status": "CONFLICT",
      "existingId": "no-any-interfaces",
      "reason": "Redundancia semántica detectada por el modelo"
    },
    {
      "incomingId": "strict-null-checks",
      "status": "NEW"
    }
  ],
  "askRules": [],
  "neverRules": [],
  "snippets": []
}
\`\`\`
`;

    // 1. Agente detecta el diff semántico
    const semanticDiff = await computeSemanticPlaybookDiff(incoming, existing, async () => mockModelResponse);

    // 2. El usuario arbitra el conflicto aplicando custom_edit
    const resolutions = {
      'b6-interfaces-any': {
        ruleId: 'b6-interfaces-any',
        action: 'custom_edit' as const,
        customTitle: 'Regla FUSIONADA por IA',
        customDescription: 'Texto final acordado por el usuario y la IA',
      },
    };

    // 3. El merge debe recibir el diff semántico del agente y NO recalcular un diff por ID
    const merged = mergePlaybooks(incoming, existing, resolutions, semanticDiff);

    // Debe haber 2 invariantes en total: la existente editada + la nueva strict-null-checks
    expect(merged.invariants).toHaveLength(2);

    const mergedTarget = merged.invariants.find((i) => i.id === 'no-any-interfaces');
    expect(mergedTarget).toBeDefined();
    expect(mergedTarget?.title).toBe('Regla FUSIONADA por IA');
    expect(mergedTarget?.description).toBe('Texto final acordado por el usuario y la IA');

    // strict-null-checks debe entrar como nueva
    expect(merged.invariants.some((i) => i.id === 'strict-null-checks')).toBe(true);

    // b6-interfaces-any NO debe duplicarse en el playbook como regla extra
    expect(merged.invariants.filter((i) => i.id === 'b6-interfaces-any')).toHaveLength(0);
  });

  it('should handle action: "accept" with different IDs replacing the targeted existing rule', async () => {
    const singleIncoming: Playbook = {
      ...incoming,
      invariants: [incoming.invariants[0]],
    };
    const mockModelResponse = `
\`\`\`json
{
  "invariants": [
    {
      "incomingId": "b6-interfaces-any",
      "status": "CONFLICT",
      "existingId": "no-any-interfaces",
      "reason": "Reemplazo de regla"
    }
  ]
}
\`\`\`
`;
    const diff = await computeSemanticPlaybookDiff(singleIncoming, existing, async () => mockModelResponse);
    const merged = mergePlaybooks(singleIncoming, existing, {
      'b6-interfaces-any': { ruleId: 'b6-interfaces-any', action: 'accept' },
    }, diff);

    expect(merged.invariants).toHaveLength(1);
    // Preserves the existing canonical rule ID instead of replacing it with the draft's ephemeral ID
    expect(merged.invariants[0].id).toBe('no-any-interfaces');
    expect(merged.invariants[0].description).toContain('interfaces Any');
  });

  it('should handle action: "reject" with different IDs keeping existing rule intact and discarding incoming', async () => {
    const singleIncoming: Playbook = {
      ...incoming,
      invariants: [incoming.invariants[0]],
    };
    const mockModelResponse = `
\`\`\`json
{
  "invariants": [
    {
      "incomingId": "b6-interfaces-any",
      "status": "CONFLICT",
      "existingId": "no-any-interfaces",
      "reason": "Rechazar regla"
    }
  ]
}
\`\`\`
`;
    const diff = await computeSemanticPlaybookDiff(singleIncoming, existing, async () => mockModelResponse);
    const merged = mergePlaybooks(singleIncoming, existing, {
      'b6-interfaces-any': { ruleId: 'b6-interfaces-any', action: 'reject' },
    }, diff);

    expect(merged.invariants).toHaveLength(1);
    expect(merged.invariants[0].id).toBe('no-any-interfaces');
    expect(merged.invariants[0].description).toContain('cualquier tipo de dato');
  });

  it('should handle action: "convert_to_ask" with different IDs moving incoming to askRules and removing from invariants', async () => {
    const singleIncoming: Playbook = {
      ...incoming,
      invariants: [incoming.invariants[0]],
    };
    const mockModelResponse = `
\`\`\`json
{
  "invariants": [
    {
      "incomingId": "b6-interfaces-any",
      "status": "CONFLICT",
      "existingId": "no-any-interfaces",
      "reason": "Convertir a opcional"
    }
  ]
}
\`\`\`
`;
    const diff = await computeSemanticPlaybookDiff(singleIncoming, existing, async () => mockModelResponse);
    const merged = mergePlaybooks(singleIncoming, existing, {
      'b6-interfaces-any': {
        ruleId: 'b6-interfaces-any',
        action: 'convert_to_ask',
        customPrompt: '¿Deseas prohibir any en interfaces?',
      },
    }, diff);

    expect(merged.invariants).toHaveLength(0);
    expect(merged.askRules).toHaveLength(1);
    expect(merged.askRules[0].id).toBe('b6-interfaces-any');
    expect(merged.askRules[0].prompt).toBe('¿Deseas prohibir any en interfaces?');
  });

  it('should handle neverRules semantic conflict with custom_edit', async () => {
    const existingWithNever: Playbook = {
      ...existing,
      neverRules: [{ id: 'no-orm', type: 'never', title: 'Sin ORM', surface: 'general', description: 'No usar ORM pesados' }],
    };
    const incomingWithNever: Playbook = {
      ...incoming,
      neverRules: [{ id: 'prohibit-heavy-orms', type: 'never', title: 'Prohibir GORM', surface: 'general', description: 'Prohibido usar GORM o TypeORM' }],
    };

    const mockModelResponse = `
\`\`\`json
{
  "neverRules": [
    {
      "incomingId": "prohibit-heavy-orms",
      "status": "CONFLICT",
      "existingId": "no-orm",
      "reason": "Misma prohibicion con distinta redaccion"
    }
  ]
}
\`\`\`
`;
    const diff = await computeSemanticPlaybookDiff(incomingWithNever, existingWithNever, async () => mockModelResponse);
    const merged = mergePlaybooks(incomingWithNever, existingWithNever, {
      'prohibit-heavy-orms': {
        ruleId: 'prohibit-heavy-orms',
        action: 'custom_edit',
        customDescription: 'NUNCA usar ORMs en persistencia; usar SQL puro',
      },
    }, diff);

    expect(merged.neverRules).toHaveLength(1);
    expect(merged.neverRules?.[0].description).toBe('NUNCA usar ORMs en persistencia; usar SQL puro');
  });

  it('should safely handle hallucinated existingId by inserting the resolved rule without crashing', async () => {
    const mockModelResponse = `
\`\`\`json
{
  "invariants": [
    {
      "incomingId": "b6-interfaces-any",
      "status": "CONFLICT",
      "existingId": "completely-hallucinated-id-123",
      "reason": "Alucinacion de ID por el modelo"
    }
  ]
}
\`\`\`
`;
    const diff = await computeSemanticPlaybookDiff(incoming, existing, async () => mockModelResponse);
    const merged = mergePlaybooks(incoming, existing, {
      'b6-interfaces-any': { ruleId: 'b6-interfaces-any', action: 'accept' },
    }, diff);

    // No debe crashear, y la regla entrante debe estar presente
    expect(merged.invariants.some((i) => i.id === 'b6-interfaces-any')).toBe(true);
  });

  it('should parse JSON with conversational preamble and postamble in parseSemanticDiffResponse', () => {
    const rawWithChatter = `¡Por supuesto! He analizado los playbooks en profundidad.
Aquí tienes el resultado en JSON:
\`\`\`json
{
  "invariants": [
    { "incomingId": "rule-1", "status": "NEW" }
  ]
}
\`\`\`
Espero que este reporte te sea de gran utilidad para el merge.`;

    const parsed = parseSemanticDiffResponse(rawWithChatter);
    expect(parsed).not.toBeNull();
    expect(parsed?.invariants).toHaveLength(1);
    expect(parsed?.invariants?.[0].incomingId).toBe('rule-1');
  });

  it('should handle partial JSON with missing keys without crashing', async () => {
    const partialJson = `
\`\`\`json
{
  "invariants": [
    { "incomingId": "b6-interfaces-any", "status": "NEW" }
  ]
}
\`\`\`
`;
    const diff = await computeSemanticPlaybookDiff(incoming, existing, async () => partialJson);
    // incoming tiene 2 invariants: b6-interfaces-any (NEW) y strict-null-checks (NEW fallback)
    expect(diff.invariants).toHaveLength(2);
    expect(diff.askRules).toHaveLength(0);
    expect(diff.neverRules).toHaveLength(0);
    expect(diff.snippets).toHaveLength(0);
  });

  describe('Rule Identity Contract & Non-Collapsing Guarantee (Issue #7)', () => {
    it('should NOT match or collapse rules by identical titles when IDs differ', async () => {
      const existingPlaybook: Playbook = {
        language: 'go',
        version: 1,
        updatedAt: '2026-03-30',
        topology: { pattern: 'Standard', directories: [] },
        invariants: [
          {
            id: 'legacy-rate-limit',
            type: 'invariant',
            title: 'Rate Limiting Middleware',
            surface: 'internal/http/',
            description: 'Limit requests to 100 req/sec',
          },
        ],
        askRules: [],
        snippets: [],
      };

      const incomingPlaybook: Playbook = {
        language: 'go',
        version: 1,
        updatedAt: '2026-03-30',
        topology: { pattern: 'Standard', directories: [] },
        invariants: [
          {
            // Exact same title as existing, but completely different ID and surface
            id: 'v2-rate-limit',
            type: 'invariant',
            title: 'Rate Limiting Middleware',
            surface: 'internal/adapters/handlers/',
            description: 'Apply distributed token bucket limiter',
          },
        ],
        askRules: [],
        snippets: [],
      };

      // When the LLM outputs NEW because the IDs are different
      const modelResponse = `
\`\`\`json
{
  "invariants": [
    { "incomingId": "v2-rate-limit", "status": "NEW" }
  ]
}
\`\`\`
`;

      const diff = await computeSemanticPlaybookDiff(
        incomingPlaybook,
        existingPlaybook,
        async () => modelResponse
      );

      // Must remain NEW and must NOT match or collapse legacy-rate-limit
      expect(diff.stats.newRules).toBe(1);
      expect(diff.stats.conflictRules).toBe(0);
      expect(diff.invariants[0].status).toBe('new');
      expect(diff.invariants[0].existing).toBeUndefined();
    });

    it('should adhere to golden JSON schema output from model', async () => {
      const goldenResponse = `
\`\`\`json
{
  "invariants": [
    {
      "incomingId": "b6-interfaces-any",
      "status": "CONFLICT",
      "existingId": "no-any-interfaces",
      "reason": "Ambas normas prohíben interfaces con any"
    },
    {
      "incomingId": "strict-null-checks",
      "status": "NEW"
    }
  ],
  "askRules": [],
  "neverRules": [],
  "snippets": []
}
\`\`\`
`;
      const diff = await computeSemanticPlaybookDiff(
        incoming,
        existing,
        async () => goldenResponse
      );

      expect(diff.stats.conflictRules).toBe(1);
      expect(diff.stats.newRules).toBe(1);
      expect(diff.stats.identicalRules).toBe(0);
    });
  });
});
