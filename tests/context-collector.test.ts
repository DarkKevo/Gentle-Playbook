import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { collectProjectContext } from '../src/extract/context-collector.js';
import { CodeGraphWrapper } from '../src/extract/codegraph.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturePath = path.join(__dirname, 'fixtures', 'go-hexagonal');

describe('Project Context Collector (CodeGraph & Native Fallback)', () => {
  it('should collect context from fixture repository (manifests and file tree)', async () => {
    const context = await collectProjectContext(fixturePath, 'go', {
      maxFilesToRead: 3,
    });

    expect(context.manifests.length).toBeGreaterThan(0);
    expect(context.manifests.some((m) => m.file === 'go.mod')).toBe(true);

    expect(context.fileList.length).toBeGreaterThan(0);
    expect(context.fileList.some((f) => f.endsWith('.go'))).toBe(true);

    expect(context.formattedContext).toContain('CONTEXTO REAL DEL REPOSITORIO');
    expect(context.formattedContext).toContain('MANIFIESTOS DE DEPENDENCIAS');
    expect(context.formattedContext).toContain('go.mod');
  });

  it('should include code snippets with line numbers', async () => {
    const context = await collectProjectContext(fixturePath, 'go', {
      maxFilesToRead: 2,
    });

    expect(context.codeSnippets.length).toBeGreaterThan(0);
    expect(context.formattedContext).toContain('MUESTRAS DE CÓDIGO FUENTE REAL');
    // Ensure line numbers format: "1 | ..."
    expect(context.codeSnippets[0].content).toMatch(/^\s*1\s*\|/m);
  });

  it('should gracefully handle CodeGraph when binary is missing or invalid', async () => {
    const fakeCg = new CodeGraphWrapper('/bin/non-existent-codegraph-bin');
    const context = await collectProjectContext(fixturePath, 'go', {
      codeGraph: fakeCg,
    });

    expect(context.usedCodeGraph).toBe(false);
    expect(context.fileList.length).toBeGreaterThan(0);
    expect(context.formattedContext).toContain('Inspección Estructural de Archivos');
  });

  it('should handle repository without supported code files or manifests without crashing', async () => {
    const tmpEmpty = await fs.mkdtemp(path.join(os.tmpdir(), 'gentle-collector-empty-'));
    try {
      await fs.writeFile(path.join(tmpEmpty, 'README.md'), '# Empty project');
      await fs.writeFile(path.join(tmpEmpty, 'logo.png'), 'fake-image-bytes');

      const context = await collectProjectContext(tmpEmpty, 'go', {
        codeGraph: new CodeGraphWrapper('/bin/non-existent-codegraph-bin'),
      });

      expect(context.manifests).toHaveLength(0);
      expect(context.fileList).toHaveLength(0);
      expect(context.codeSnippets).toHaveLength(0);
      expect(context.formattedContext).toContain('CONTEXTO REAL DEL REPOSITORIO');
    } finally {
      await fs.rm(tmpEmpty, { recursive: true, force: true });
    }
  });

  it('should truncate massive files and manifests to prevent prompt overflow', async () => {
    const tmpHuge = await fs.mkdtemp(path.join(os.tmpdir(), 'gentle-collector-huge-'));
    try {
      // Manifiesto de más de 4000 caracteres
      const hugeManifest = '{\n  "dependencies": {\n' + '    "pkg": "1.0.0",\n'.repeat(300) + '  }\n}';
      await fs.writeFile(path.join(tmpHuge, 'package.json'), hugeManifest);

      // Archivo de 300 líneas de código
      const hugeCode = Array.from({ length: 300 }, (_, i) => `const line${i} = ${i};`).join('\n');
      await fs.writeFile(path.join(tmpHuge, 'index.ts'), hugeCode);

      const context = await collectProjectContext(tmpHuge, 'typescript', {
        codeGraph: new CodeGraphWrapper('/bin/non-existent-codegraph-bin'),
        maxLinesPerFile: 50,
      });

      // Manifiesto cortado a máximo 3000 caracteres
      expect(context.manifests[0].content.length).toBeLessThanOrEqual(3000);

      // Muestra de código limitada a 50 líneas
      const snippetLines = context.codeSnippets[0].content.split('\n');
      expect(snippetLines.length).toBeLessThanOrEqual(50);
    } finally {
      await fs.rm(tmpHuge, { recursive: true, force: true });
    }
  });
});
