import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { PlaybookStorage } from '../src/core/storage.js';
import { Playbook } from '../src/core/schema.js';

describe('PlaybookStorage', () => {
  let tempDir: string;
  let storage: PlaybookStorage;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gentle-playbook-test-'));
    storage = new PlaybookStorage(tempDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const samplePlaybook: Playbook = {
    language: 'go',
    version: 1,
    updatedAt: '2025-02-18',
    topology: {
      pattern: 'Hexagonal',
      directories: ['cmd/api/', 'internal/core/'],
    },
    invariants: [
      {
        id: 'null-byte',
        type: 'invariant',
        title: 'Null Byte Sanitizer',
        surface: 'internal/adapters/handlers/',
        description: 'Sanitize null bytes.',
      },
    ],
    askRules: [],
    snippets: [],
  };

  it('should save, list, get, check existence, and delete a playbook', async () => {
    expect(await storage.listLanguages()).toEqual([]);
    expect(await storage.exists('go')).toBe(false);

    await storage.savePlaybook(samplePlaybook);

    expect(await storage.exists('go')).toBe(true);
    expect(await storage.listLanguages()).toEqual(['go']);

    const loaded = await storage.getPlaybook('go');
    expect(loaded).not.toBeNull();
    expect(loaded?.language).toBe('go');
    expect(loaded?.invariants[0].id).toBe('null-byte');

    const deleted = await storage.deletePlaybook('go');
    expect(deleted).toBe(true);
    expect(await storage.exists('go')).toBe(false);
    expect(await storage.listLanguages()).toEqual([]);
  });

  it('should return null when reading a non-existent playbook', async () => {
    const loaded = await storage.getPlaybook('nonexistent');
    expect(loaded).toBeNull();
  });

  it('should save and load agent preferences correctly without polluting listLanguages', async () => {
    expect(await storage.hasAgentPreferences()).toBe(false);

    const agentPb: Playbook = {
      language: 'agents-preferences',
      version: 1,
      updatedAt: '2025-02-18',
      topology: { pattern: 'Agent Runtime', directories: [] },
      invariants: [
        {
          id: 'require-write-approval',
          type: 'invariant',
          title: 'Aprobación previa de escritura',
          surface: 'tools:write,tools:edit',
          description: 'No ejecutar write sin aprobacion.',
        },
      ],
      askRules: [],
      snippets: [],
    };

    await storage.saveAgentPreferences(agentPb);

    expect(await storage.hasAgentPreferences()).toBe(true);
    expect(await storage.listLanguages()).toEqual([]); // No debe ensuciar la lista de lenguajes

    const loaded = await storage.getAgentPreferences();
    expect(loaded).not.toBeNull();
    expect(loaded?.invariants[0].id).toBe('require-write-approval');

    // También accesible vía alias 'agents' o getPlaybook('agents')
    const loadedViaAlias = await storage.getPlaybook('agents');
    expect(loadedViaAlias?.invariants[0].id).toBe('require-write-approval');
  });
});
