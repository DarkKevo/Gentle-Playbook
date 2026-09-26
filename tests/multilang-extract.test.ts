import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectProjectLanguages, detectProjectLanguage } from '../src/extract/extractor.js';
import { detectTopology } from '../src/extract/topology.js';
import { buildAgentExtractorPrompt } from '../src/extract/prompt.js';
import { parseAgentOutput } from '../src/extract/agent-extractor.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Multilanguage Projects & Agent Extraction', () => {
  const tsPath = path.join(__dirname, 'fixtures', 'ts-clean');
  const pyPath = path.join(__dirname, 'fixtures', 'python-api');

  it('should detect TypeScript project and its Clean Architecture layers', async () => {
    const lang = await detectProjectLanguage(tsPath);
    expect(lang).toBe('typescript');

    const topology = await detectTopology(tsPath);
    expect(topology.directories.some((d) => d.includes('domain'))).toBe(true);
    expect(topology.directories.some((d) => d.includes('infrastructure'))).toBe(true);
    expect(topology.directories.some((d) => d.includes('application'))).toBe(true);

    const prompt = buildAgentExtractorPrompt({
      targetPath: tsPath,
      language: lang,
      topology: topology.pattern,
    });

    expect(prompt).toContain('typescript');
    expect(prompt).toContain('ELECCIÓN vs IMPOSICIÓN');
  });

  it('should detect Python project with FastAPI and structure prompt correctly', async () => {
    const lang = await detectProjectLanguage(pyPath);
    expect(lang).toBe('python');

    const langInfo = await detectProjectLanguages(pyPath);
    expect(langInfo.isMonorepo).toBe(false);
    expect(langInfo.primary).toBe('python');

    const topology = await detectTopology(pyPath);
    expect(topology.directories.some((d) => d.includes('app'))).toBe(true);

    const prompt = buildAgentExtractorPrompt({
      targetPath: pyPath,
      language: lang,
      topology: topology.pattern,
    });

    expect(prompt).toContain('python');
    expect(prompt).toContain('B1. Organización y arquitectura');
  });

  it('should parse mock agent output for TypeScript project with Zod and Never rules', () => {
    const mockTsOutput = `
=== REPORTE DE EVIDENCIA ===
| ID | Regla | Tipo | Cumple | Evidencia (archivo:línea) | Contraejemplos |
|---|---|---|---|---|---|
| E1 | Validación estricta con Zod | INVARIANT | 8/8 | src/application/dtos/user.dto.ts:3 | ninguno |
| E2 | Sanitización de bytes nulos | INVARIANT | 1/1 | src/infrastructure/http/middlewares/sanitizer.ts:4 | ninguno |

=== PLAYBOOK COMPACTO ===
\`\`\`markdown
---
source: /fixtures/ts-clean
lang: typescript
project_type: api-http
stack: express, zod
extracted: 2026-03-30
---

## Estructura
- src/domain/
- src/application/
- src/infrastructure/

## Invariants
- [B1] Dominio desacoplado: entidades e interfaces en src/domain sin dependencias de frameworks.
- [H2] Contratos de entrada validados estrictamente con esquemas Zod en src/application/dtos.

## Ask Rules
- [H1] SI endpoint maneja transacciones financieras → preguntar por idempotency key.

## Nunca
- [B6] No usar 'any' ni casteos no seguros 'as unknown as T'.
- [B6] No importar librerías de infraestructura dentro de la capa de dominio.

## Snippets canónicos
### Validador Zod DTO
\`\`\`typescript
export const UserSchema = z.object({
  email: z.string().email(),
});
\`\`\`
\`\`\`
`;

    const result = parseAgentOutput(mockTsOutput, 'typescript');
    expect(result.playbook.language).toBe('typescript');
    expect(result.playbook.invariants.length).toBe(2);
    expect(result.playbook.neverRules?.length).toBe(2);
    expect(result.playbook.snippets[0].language).toBe('typescript');
    expect(result.playbook.neverRules?.[0].description).toContain("No usar 'any'");
  });
});
