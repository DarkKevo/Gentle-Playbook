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

  it('should save, list, get, delete stack playbooks without polluting languages', async () => {
    expect(await storage.listStacks()).toEqual([]);
    expect(await storage.hasStack('go-gin')).toBe(false);

    const stackPb: Playbook = {
      language: 'go-gin',
      stackId: 'go-gin',
      stackName: 'Go + Gin REST API',
      requiredFlags: ['go', 'gin'],
      scope: 'stack',
      version: 1,
      updatedAt: '2026-10-08',
      topology: { pattern: 'Standard Layout', directories: ['cmd/api/'] },
      invariants: [
        {
          id: 'use-gin-context',
          type: 'invariant',
          title: 'Utilizar gin.Context en handlers',
          surface: 'cmd/api,internal/handlers',
          description: 'Todos los handlers deben recibir *gin.Context.',
        },
      ],
      askRules: [],
      snippets: [],
    };

    await storage.saveStack(stackPb);

    expect(await storage.hasStack('go-gin')).toBe(true);
    expect(await storage.listStacks()).toEqual(['go-gin']);
    expect(await storage.listLanguages()).toEqual([]); // Languages intact

    const loaded = await storage.getStack('go-gin');
    expect(loaded).not.toBeNull();
    expect(loaded?.stackId).toBe('go-gin');
    expect(loaded?.requiredFlags).toEqual(['go', 'gin']);
    expect(loaded?.invariants[0].id).toBe('use-gin-context');

    // Rule deletion in stack
    const delRuleRes = await storage.deleteRuleFromStack('go-gin', 'use-gin-context');
    expect(delRuleRes.deleted).toBe(true);
    const reloaded = await storage.getStack('go-gin');
    expect(reloaded?.invariants.length).toBe(0);

    // Delete stack
    const deleted = await storage.deleteStack('go-gin');
    expect(deleted).toBe(true);
    expect(await storage.hasStack('go-gin')).toBe(false);
    expect(await storage.listStacks()).toEqual([]);
  });

  it('should save, get, and delete local project playbook at specified project path', async () => {
    const projectDir = path.join(tempDir, 'sample-project');
    await fs.mkdir(projectDir, { recursive: true });

    expect(await storage.hasLocalProjectPlaybook(projectDir)).toBe(false);
    expect(await storage.getLocalProjectPlaybook(projectDir)).toBeNull();

    const localPb: Playbook = {
      language: 'project',
      scope: 'project',
      version: 1,
      updatedAt: '2026-10-08',
      topology: { pattern: 'Project Custom', directories: ['src/'] },
      invariants: [
        {
          id: 'local-auth-guard',
          type: 'invariant',
          title: 'Guardia local de autenticación',
          surface: 'src/auth',
          description: 'Regla local específica de este repositorio.',
        },
      ],
      askRules: [],
      neverRules: [
        {
          id: 'no-raw-sql',
          type: 'never',
          title: 'Sin raw SQL',
          surface: 'src/db',
          description: 'No usar queries SQL raw bajo ninguna circunstancia.',
        },
      ],
      snippets: [],
    };

    await storage.saveLocalProjectPlaybook(localPb, projectDir);

    expect(await storage.hasLocalProjectPlaybook(projectDir)).toBe(true);
    const loaded = await storage.getLocalProjectPlaybook(projectDir);
    expect(loaded).not.toBeNull();
    expect(loaded?.scope).toBe('project');
    expect(loaded?.invariants[0].id).toBe('local-auth-guard');
    expect(loaded?.neverRules?.[0].id).toBe('no-raw-sql');

    // Delete rule from project
    const delRule = await storage.deleteRuleFromProject(projectDir, 'local-auth-guard');
    expect(delRule.deleted).toBe(true);

    const reloaded = await storage.getLocalProjectPlaybook(projectDir);
    expect(reloaded?.invariants.length).toBe(0);
    expect(reloaded?.neverRules?.length).toBe(1);

    // Delete local project playbook
    const delProj = await storage.deleteLocalProjectPlaybook(projectDir);
    expect(delProj).toBe(true);
    expect(await storage.hasLocalProjectPlaybook(projectDir)).toBe(false);
  });
});
