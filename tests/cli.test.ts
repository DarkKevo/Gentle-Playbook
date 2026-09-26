import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { PlaybookStorage } from '../src/core/storage.js';

const execFileAsync = promisify(execFile);
const cliPath = path.resolve(__dirname, '../dist/cli.js');

describe('CLI Integration (Sandboxed & Safe Deletion)', () => {
  let tmpDir: string;
  let storage: PlaybookStorage;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gentle-cli-test-'));
    storage = new PlaybookStorage(tmpDir);

    const samplePb = {
      language: 'go',
      version: 1,
      updatedAt: '2026-03-30',
      topology: {
        pattern: 'Modular Hexagonal',
        directories: ['internal/adapters/', 'internal/core/'],
      },
      invariants: [
        {
          id: 'null-byte-sanitizer',
          type: 'invariant' as const,
          title: 'Middleware Sanitizador',
          surface: 'internal/adapters/',
          description: 'Rechaza caracteres nulos en requests',
        },
      ],
      askRules: [
        {
          id: 'rate-limiting',
          type: 'ask' as const,
          title: 'Rate Limit',
          surface: 'internal/adapters/',
          trigger: 'Public endpoints',
          antiTrigger: 'Private routes',
          prompt: 'Apply rate limit?',
          defaultAction: 'No rate limit',
          description: 'Rate limit rule',
        },
      ],
      snippets: [],
    };
    await storage.savePlaybook(samplePb);

    // Create a typescript playbook to test prevention of accidental deletion
    await storage.savePlaybook({
      language: 'typescript',
      version: 1,
      updatedAt: '2026-03-30',
      topology: { pattern: 'Clean', directories: [] },
      invariants: [],
      askRules: [],
      snippets: [],
    });
  });

  afterAll(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('should execute gentle-playbook list command within sandbox', async () => {
    const { stdout } = await execFileAsync('node', [cliPath, 'list'], {
      env: { ...process.env, GENTLE_PLAYBOOK_DIR: tmpDir },
    });
    expect(stdout).toContain('Available Gentle Playbooks:');
    expect(stdout).toContain('go');
    expect(stdout).toContain('typescript');
  });

  it('should execute gentle-playbook show go command within sandbox', async () => {
    const { stdout } = await execFileAsync('node', [cliPath, 'show', 'go'], {
      env: { ...process.env, GENTLE_PLAYBOOK_DIR: tmpDir },
    });
    expect(stdout).toContain('# Playbook: Go');
    expect(stdout).toContain('Topology: Modular Hexagonal');
    expect(stdout).toContain('[INVARIANT:null-byte-sanitizer]');
  });

  it('should REJECT fuzzy/partial single-letter deletion (Issue #3)', async () => {
    try {
      await execFileAsync('node', [cliPath, 'delete', 's', '--yes'], {
        env: { ...process.env, GENTLE_PLAYBOOK_DIR: tmpDir },
      });
      expect.fail('Should have rejected deletion of "s"');
    } catch (err: any) {
      expect(err.stderr || err.stdout).toContain('Ambiguous or unknown language "s"');
    }

    // Verify typescript playbook was NOT deleted by fuzzy "s" match
    const tsPb = await storage.getPlaybook('typescript');
    expect(tsPb).not.toBeNull();
  });

  it('should add an individual invariant rule via CLI', async () => {
    const { stdout } = await execFileAsync(
      'node',
      [
        cliPath,
        'add',
        'go',
        '--type',
        'invariant',
        '--id',
        'dto-validation',
        '--title',
        'DTO NotBlank',
        '--surface',
        'internal/shared/',
        '--description',
        'Campos string no pueden estar vacios',
      ],
      { env: { ...process.env, GENTLE_PLAYBOOK_DIR: tmpDir } }
    );

    expect(stdout).toContain('Added invariant rule [dto-validation]');
    const pb = await storage.getPlaybook('go');
    expect(pb?.invariants.some((i) => i.id === 'dto-validation')).toBe(true);
  });

  it('should add a deliberate prohibition (never rule) via CLI', async () => {
    const { stdout } = await execFileAsync(
      'node',
      [
        cliPath,
        'add',
        'go',
        '--type',
        'never',
        '--id',
        'no-heavy-orm',
        '--description',
        'No usar ORMs pesados como GORM; usar pgx directamente',
      ],
      { env: { ...process.env, GENTLE_PLAYBOOK_DIR: tmpDir } }
    );

    expect(stdout).toContain('Added deliberate prohibition [no-heavy-orm]');
    const pb = await storage.getPlaybook('go');
    expect(pb?.neverRules?.some((n) => n.id === 'no-heavy-orm')).toBe(true);
  });

  it('should perform surgical rule deletion with --rule without deleting the playbook', async () => {
    const { stdout } = await execFileAsync(
      'node',
      [cliPath, 'delete', 'go', '--rule', 'dto-validation'],
      { env: { ...process.env, GENTLE_PLAYBOOK_DIR: tmpDir } }
    );

    expect(stdout).toContain('Deleted rule "dto-validation" (invariant)');
    const pb = await storage.getPlaybook('go');
    // dto-validation was deleted
    expect(pb?.invariants.some((i) => i.id === 'dto-validation')).toBe(false);
    // null-byte-sanitizer still survives!
    expect(pb?.invariants.some((i) => i.id === 'null-byte-sanitizer')).toBe(true);
  });

  it('should require --yes for full playbook deletion in non-interactive environment', async () => {
    try {
      await execFileAsync('node', [cliPath, 'delete', 'typescript'], {
        env: { ...process.env, GENTLE_PLAYBOOK_DIR: tmpDir },
      });
      expect.fail('Should have required --yes');
    } catch (err: any) {
      expect(err.stderr || err.stdout).toContain('requires explicit confirmation');
    }

    // Now delete with --yes
    const { stdout } = await execFileAsync('node', [cliPath, 'delete', 'typescript', '--yes'], {
      env: { ...process.env, GENTLE_PLAYBOOK_DIR: tmpDir },
    });
    expect(stdout).toContain('Deleted playbook for "typescript"');
    const tsPb = await storage.getPlaybook('typescript');
    expect(tsPb).toBeNull();
  });
});
