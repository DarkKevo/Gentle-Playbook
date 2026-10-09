import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  detectProjectFlags,
  isStackActive,
  detectActiveStacks,
} from '../src/core/stack-detector.js';
import {
  buildStackSynthesisPrompt,
  parseSynthesizedStack,
  heuristicFallbackStack,
} from '../src/core/stack-synthesizer.js';
import { Playbook } from '../src/core/schema.js';

describe('Stack Detector & Synthesizer', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gentle-stack-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('detectProjectFlags', () => {
    it('should detect Go and Gin from go.mod', async () => {
      const goMod = `module example.com/myapi\n\ngo 1.22\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.1\n\tgorm.io/gorm v1.25.7\n)\n`;
      await fs.writeFile(path.join(tempDir, 'go.mod'), goMod, 'utf-8');

      const flags = await detectProjectFlags(tempDir);
      expect(flags.has('go')).toBe(true);
      expect(flags.has('gin')).toBe(true);
      expect(flags.has('gorm')).toBe(true);
      expect(flags.has('fiber')).toBe(false);
      expect(flags.has('typescript')).toBe(false);
    });

    it('should detect Node, TypeScript, NestJS, and TypeORM from package.json', async () => {
      const pkg = {
        name: 'nest-app',
        dependencies: {
          '@nestjs/core': '^10.0.0',
          'typeorm': '^0.3.20',
          'pg': '^8.11.0',
        },
        devDependencies: {
          'typescript': '^5.0.0',
        },
      };
      await fs.writeFile(path.join(tempDir, 'package.json'), JSON.stringify(pkg), 'utf-8');

      const flags = await detectProjectFlags(tempDir);
      expect(flags.has('javascript')).toBe(true);
      expect(flags.has('typescript')).toBe(true);
      expect(flags.has('nest')).toBe(true);
      expect(flags.has('typeorm')).toBe(true);
      expect(flags.has('express')).toBe(false);
    });

    it('should detect combined multi-stack workspace (Go + Gin + Solidity/Hardhat)', async () => {
      const goMod = `module myapp\n\nrequire github.com/gin-gonic/gin v1.9.0\n`;
      await fs.writeFile(path.join(tempDir, 'go.mod'), goMod, 'utf-8');

      const pkg = {
        devDependencies: {
          hardhat: '^2.19.0',
        },
      };
      await fs.writeFile(path.join(tempDir, 'package.json'), JSON.stringify(pkg), 'utf-8');
      await fs.writeFile(path.join(tempDir, 'hardhat.config.js'), '// config', 'utf-8');

      const flags = await detectProjectFlags(tempDir);
      expect(flags.has('go')).toBe(true);
      expect(flags.has('gin')).toBe(true);
      expect(flags.has('solidity')).toBe(true);
      expect(flags.has('hardhat')).toBe(true);
    });
  });

  describe('isStackActive (Structural Subtyping)', () => {
    const stackGoGin: Playbook = {
      language: 'go-gin',
      stackId: 'go-gin',
      requiredFlags: ['go', 'gin'],
      version: 1,
      updatedAt: '2026-10-08',
      topology: { pattern: 'Standard', directories: [] },
      invariants: [],
      askRules: [],
      snippets: [],
    };

    const stackSolidity: Playbook = {
      language: 'solidity-hardhat',
      stackId: 'solidity-hardhat',
      requiredFlags: ['solidity', 'hardhat'],
      version: 1,
      updatedAt: '2026-10-08',
      topology: { pattern: 'Standard', directories: [] },
      invariants: [],
      askRules: [],
      snippets: [],
    };

    it('should activate stack if project has ALL required flags even with extra flags', async () => {
      // Superset: has go, gin, solidity, hardhat
      const supersetFlags = new Set(['go', 'gin', 'solidity', 'hardhat', 'tailwind']);

      expect(await isStackActive(stackGoGin, supersetFlags, tempDir)).toBe(true);
      expect(await isStackActive(stackSolidity, supersetFlags, tempDir)).toBe(true);
    });

    it('should NOT activate stack if missing even one required flag', async () => {
      const incompleteFlags = new Set(['go']); // missing gin

      expect(await isStackActive(stackGoGin, incompleteFlags, tempDir)).toBe(false);
    });

    it('should verify custom file detection rules when specified', async () => {
      await fs.writeFile(path.join(tempDir, 'custom-config.json'), '{"preset":"enterprise"}', 'utf-8');

      const customStack: Playbook = {
        language: 'custom-corp',
        stackId: 'custom-corp',
        requiredFlags: ['go'],
        detection: {
          requiredFlags: ['go'],
          files: [
            {
              path: 'custom-config.json',
              contains: ['enterprise'],
            },
          ],
        },
        version: 1,
        updatedAt: '2026-10-08',
        topology: { pattern: 'Standard', directories: [] },
        invariants: [],
        askRules: [],
        snippets: [],
      };

      const flags = new Set(['go']);
      expect(await isStackActive(customStack, flags, tempDir)).toBe(true);

      // If file does not contain required substring
      await fs.writeFile(path.join(tempDir, 'custom-config.json'), '{"preset":"community"}', 'utf-8');
      expect(await isStackActive(customStack, flags, tempDir)).toBe(false);
    });
  });

  describe('detectActiveStacks', () => {
    it('should return all and only the stacks that match the project', async () => {
      const goMod = `module myapp\n\nrequire github.com/gin-gonic/gin v1.9.0\n`;
      await fs.writeFile(path.join(tempDir, 'go.mod'), goMod, 'utf-8');

      const stack1: Playbook = {
        language: 'go-gin',
        stackId: 'go-gin',
        requiredFlags: ['go', 'gin'],
        version: 1,
        updatedAt: '2026-10-08',
        topology: { pattern: 'Standard', directories: [] },
        invariants: [],
        askRules: [],
        snippets: [],
      };

      const stack2: Playbook = {
        language: 'nest-typeorm',
        stackId: 'nest-typeorm',
        requiredFlags: ['nest', 'typeorm'],
        version: 1,
        updatedAt: '2026-10-08',
        topology: { pattern: 'Standard', directories: [] },
        invariants: [],
        askRules: [],
        snippets: [],
      };

      const active = await detectActiveStacks(tempDir, [stack1, stack2]);
      expect(active.length).toBe(1);
      expect(active[0].stackId).toBe('go-gin');
    });
  });

  describe('stack-synthesizer', () => {
    it('should build prompt and parse LLM JSON response into SynthesizedStack', () => {
      const prompt = buildStackSynthesisPrompt('nest con typeorm y postgres');
      expect(prompt).toContain('nest con typeorm y postgres');

      const llmJson = `\`\`\`json
{
  "slug": "nest-typeorm",
  "name": "NestJS + TypeORM",
  "description": "Backend modular con NestJS y TypeORM",
  "requiredFlags": ["typescript", "nest", "typeorm"],
  "detectionFiles": [
    {
      "path": "package.json",
      "contains": ["@nestjs/core", "typeorm"]
    }
  ],
  "suggestedRules": [
    {
      "id": "use-dependency-injection",
      "title": "Inyección de dependencias en servicios",
      "surface": "src/**/*.service.ts",
      "description": "Usar siempre @Injectable() e inyectar repositorios con @InjectRepository."
    }
  ]
}
\`\`\``;

      const synthesized = parseSynthesizedStack(llmJson);
      expect(synthesized.slug).toBe('nest-typeorm');
      expect(synthesized.name).toBe('NestJS + TypeORM');
      expect(synthesized.requiredFlags).toEqual(['typescript', 'nest', 'typeorm']);
      expect(synthesized.initialInvariants?.length).toBe(1);
      expect(synthesized.initialInvariants?.[0].id).toBe('use-dependency-injection');
    });

    it('should fallback to heuristic detection if LLM output is malformed', () => {
      const fallback = heuristicFallbackStack('golang y gin con gorm');
      expect(fallback.slug).toBe('go-gin-gorm');
      expect(fallback.requiredFlags).toContain('go');
      expect(fallback.requiredFlags).toContain('gin');
      expect(fallback.requiredFlags).toContain('gorm');
    });
  });
});
