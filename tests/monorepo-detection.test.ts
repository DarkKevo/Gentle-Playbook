import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { detectProjectLanguages, detectProjectLanguage } from '../src/extract/extractor.js';

describe('Monorepo Language Detection', () => {
  it('should detect monorepo with multiple manifests and pick predominant by file count', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gentle-monorepo-test-'));

    try {
      // Create manifests for Go and TypeScript
      await fs.writeFile(path.join(tmpDir, 'go.mod'), 'module example/monorepo\n\ngo 1.22\n');
      await fs.writeFile(path.join(tmpDir, 'package.json'), '{"name": "frontend"}\n');

      // Create 1 Go file and 3 TypeScript files
      await fs.mkdir(path.join(tmpDir, 'backend'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, 'backend', 'main.go'), 'package main\n');

      await fs.mkdir(path.join(tmpDir, 'frontend', 'src'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, 'frontend', 'src', 'App.tsx'), 'export const App = () => {};\n');
      await fs.writeFile(path.join(tmpDir, 'frontend', 'src', 'index.ts'), 'console.log("hello");\n');
      await fs.writeFile(path.join(tmpDir, 'frontend', 'src', 'utils.ts'), 'export const id = 1;\n');

      const result = await detectProjectLanguages(tmpDir);

      expect(result.isMonorepo).toBe(true);
      expect(result.detected).toContain('go');
      expect(result.detected).toContain('typescript');
      expect(result.counts['typescript']).toBe(3);
      expect(result.counts['go']).toBe(1);
      // TypeScript must win because it has 3 files vs 1 Go file
      expect(result.primary).toBe('typescript');

      const primary = await detectProjectLanguage(tmpDir);
      expect(primary).toBe('typescript');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('should detect single language project cleanly', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gentle-single-test-'));

    try {
      await fs.writeFile(path.join(tmpDir, 'Cargo.toml'), '[package]\nname = "test"\n');
      const result = await detectProjectLanguages(tmpDir);

      expect(result.isMonorepo).toBe(false);
      expect(result.primary).toBe('rust');
      expect(result.detected).toEqual(['rust']);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
