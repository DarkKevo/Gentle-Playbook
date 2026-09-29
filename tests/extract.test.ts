import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectProjectLanguage, extractPlaybook } from '../src/extract/extractor.js';
import { detectTopology } from '../src/extract/topology.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturePath = path.join(__dirname, 'fixtures', 'go-hexagonal');

describe('Extraction Engine with Local Fixture', () => {
  let originalCodegraphBin: string | undefined;

  beforeEach(() => {
    originalCodegraphBin = process.env.CODEGRAPH_BIN;
    process.env.CODEGRAPH_BIN = '/bin/non-existent-codegraph-bin';
  });

  afterEach(() => {
    if (originalCodegraphBin !== undefined) {
      process.env.CODEGRAPH_BIN = originalCodegraphBin;
    } else {
      delete process.env.CODEGRAPH_BIN;
    }
  });
  it('should detect Go language from fixture repository root', async () => {
    const lang = await detectProjectLanguage(fixturePath);
    expect(lang).toBe('go');
  });

  it('should detect Modular Hexagonal topology in fixture', async () => {
    const topology = await detectTopology(fixturePath);
    expect(topology.pattern).toContain('Hexagonal');
    expect(topology.directories.length).toBeGreaterThan(0);
    expect(topology.directories.some((d) => d.includes('adapters'))).toBe(true);
  });

  it('should require completePrompt when running agent extraction', async () => {
    await expect(extractPlaybook(fixturePath)).rejects.toThrow(
      /No se proveyó una función para ejecutar el prompt del agente/
    );
  });

  it('should extract playbook via agent completion', async () => {
    const mockOutput = `=== REPORTE DE EVIDENCIA ===
| E1 | Null-Byte Sanitizer | INVARIANT | 10/10 | internal/adapters/sanitizer.go:12 | ninguno |

=== PLAYBOOK COMPACTO ===
\`\`\`markdown
---
source: ${fixturePath}
lang: go
project_type: api-http
stack: chi, pgx
extracted: 2026-03-30
---

## Estructura
- cmd/api/
- internal/adapters/

## Invariants
- [H1] Interceptar y rechazar peticiones HTTP con caracteres nulos.

## Ask Rules
- [H2] SI la ruta es administrativa → ¿Deseas aplicar middleware de RBAC?
\`\`\`
`;
    const playbook = await extractPlaybook(fixturePath, {
      completePrompt: async () => mockOutput,
    });

    expect(playbook.language).toBe('go');
    expect(playbook.topology.pattern).toContain('Hexagonal');
    expect(playbook.invariants.length).toBe(1);
    expect(playbook.invariants[0].description).toContain('caracteres nulos');
    expect(playbook.askRules.length).toBe(1);
  });
});
