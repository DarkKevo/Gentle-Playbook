import { describe, it, expect } from 'vitest';
import { parsePlaybook, serializePlaybook, formatPlaybookForSystemPrompt } from '../src/core/parser.js';
import { parseAgentOutput } from '../src/extract/agent-extractor.js';

describe('Agent Extractor Output & Compact Parser', () => {
  const sampleAgentOutput = `
=== REPORTE DE EVIDENCIA ===
| ID | Regla | Tipo | Cumple | Evidencia (archivo:línea) | Contraejemplos |
|---|---|---|---|---|---|
| E1 | Envolver errores con %w | INVARIANT | 15/15 | internal/adapters/handler.go:42 | ninguno |
| E2 | Rate limiting en endpoints públicos | ASK_RULE | 4/5 | cmd/api/main.go:88 | internal/admin |

Descartadas:
- ORM: no se detectó uso de ORMs pesados.

=== PLAYBOOK COMPACTO ===
\`\`\`markdown
---
source: /tmp/my-go-backend
lang: go
project_type: api-http
stack: chi, pgx, slog
extracted: 2026-03-30
---

## Estructura
- cmd/api/
- internal/domain/
- internal/adapters/

## Invariants
- [B3] Envolver todo error al propagar con formato "<op>: %w".
- [H3] Toda respuesta HTTP usa envelope {data, error}.

## Ask Rules
- [H1] SI el endpoint es público Y modifica estado → ¿Deseas aplicar middleware de Rate Limiting?

## Nunca
- [B6] No usar ORM; queries escritas en SQL explícito con pgx.

## Snippets canónicos
### Handler con Envelope
\`\`\`go
func Handler(w http.ResponseWriter, r *http.Request) {
    // response envelope
}
\`\`\`
\`\`\`
`;

  it('should parse agent output into evidence report and Playbook object', () => {
    const result = parseAgentOutput(sampleAgentOutput, 'go');

    expect(result.evidenceReport).toContain('| E1 | Envolver errores');
    expect(result.playbook.language).toBe('go');
    expect(result.playbook.invariants.length).toBe(2);
    expect(result.playbook.askRules.length).toBe(1);
    expect(result.playbook.neverRules?.length).toBe(1);
    expect(result.playbook.snippets.length).toBe(1);

    expect(result.playbook.invariants[0].description).toContain('Envolver todo error');
    expect(result.playbook.neverRules?.[0].description).toContain('No usar ORM');
  });

  it('should format deliberate prohibitions into the system prompt', () => {
    const { playbook } = parseAgentOutput(sampleAgentOutput, 'go');
    const promptText = formatPlaybookForSystemPrompt(playbook);

    expect(promptText).toContain('ACTIVE ARCHITECTURAL PLAYBOOK: Go');
    expect(promptText).toContain('DELIBERATE PROHIBITIONS (NEVER DO)');
    expect(promptText).toContain('No usar ORM');
  });
});
