import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { runExtractTriage } from '../src/core/extract-triage.js';
import { PlaybookStorage } from '../src/core/storage.js';
import { Playbook } from '../src/core/schema.js';

describe('Extract Triage 1-a-1 Wizard', () => {
  let tempDir: string;
  let storage: PlaybookStorage;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gentle-triage-test-'));
    storage = new PlaybookStorage(tempDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const sampleDraft: Playbook = {
    language: 'go',
    version: 1,
    updatedAt: '2026-10-08',
    topology: { pattern: 'Hexagonal', directories: ['cmd/', 'internal/'] },
    invariants: [
      {
        id: 'rule-global',
        type: 'invariant',
        title: 'Norma Idiomática de Go',
        surface: 'internal/core',
        description: 'Usar context.Context como primer argumento.',
      },
      {
        id: 'rule-stack',
        type: 'invariant',
        title: 'Norma de Gin Routing',
        surface: 'internal/handlers',
        description: 'Usar gin.Context para deserializar bodies.',
      },
      {
        id: 'rule-local',
        type: 'invariant',
        title: 'Norma Específica de Este Repo',
        surface: 'internal/custom',
        description: 'Regla privada local del proyecto.',
      },
    ],
    askRules: [],
    neverRules: [
      {
        id: 'rule-discard',
        type: 'never',
        title: 'Regla para Descartar',
        surface: 'vendor/',
        description: 'No usar vendor.',
      },
    ],
    snippets: [],
  };

  it('should triage rules into Global, Stack, Local, and Discard respectively', async () => {
    // Stacks pre-existentes
    await storage.saveStack({
      language: 'go-gin',
      stackId: 'go-gin',
      stackName: 'Go + Gin API',
      requiredFlags: ['go', 'gin'],
      version: 1,
      updatedAt: '2026-10-08',
      topology: { pattern: 'Standard', directories: [] },
      invariants: [],
      askRules: [],
      snippets: [],
    });

    const selects = [
      '🌐 1. Global (Lenguaje: GO)', // rule-global -> Global
      '📦 2. Stack Tecnológico (Framework / Librerías)', // rule-stack -> Stack
      '📦 go-gin', // selecciona stack go-gin
      '🏠 3. Proyecto Local (playbook.md en este repositorio)', // rule-local -> Local
      '🗑️ 5. Descartar regla', // rule-discard -> Discard
    ];

    let selectIndex = 0;
    const selectMock = vi.fn().mockImplementation(async () => {
      const val = selects[selectIndex++];
      return val;
    });

    const notifications: string[] = [];
    const mockCtx = {
      cwd: tempDir,
      ui: {
        confirm: async () => true,
        select: selectMock,
        input: async () => 'test-input',
        notify: (msg: string) => notifications.push(msg),
      },
    };

    const mockPi = {
      sendMessage: vi.fn(),
    };

    const summary = await runExtractTriage({
      draft: sampleDraft,
      detectedLang: 'go',
      projectPath: tempDir,
      storage,
      ctx: mockCtx,
      pi: mockPi,
      completePrompt: async () => '',
    });

    expect(summary.savedToGlobal).toBe(1);
    expect(summary.savedToStack['go-gin']).toBe(1);
    expect(summary.savedToProject).toBe(1);
    expect(summary.discarded).toBe(1);

    // Verificar persistencia en storage
    const globalPb = await storage.getPlaybook('go');
    expect(globalPb?.invariants.some((i) => i.id === 'rule-global')).toBe(true);

    const stackPb = await storage.getStack('go-gin');
    expect(stackPb?.invariants.some((i) => i.id === 'rule-stack')).toBe(true);

    const localPb = await storage.getLocalProjectPlaybook(tempDir);
    expect(localPb?.invariants.some((i) => i.id === 'rule-local')).toBe(true);
  });

  it('should support modifying a rule with LLM loop before saving', async () => {
    const singleDraft: Playbook = {
      language: 'go',
      version: 1,
      updatedAt: '2026-10-08',
      topology: { pattern: 'Standard', directories: [] },
      invariants: [
        {
          id: 'rule-to-modify',
          type: 'invariant',
          title: 'Regla Inicial',
          surface: 'src/',
          description: 'Descripción básica',
        },
      ],
      askRules: [],
      snippets: [],
    };

    const selects = [
      '✏️ 4. Modificar regla (ajustar con IA)', // Primero modifica
      '🌐 1. Global (Lenguaje: GO)', // Luego guarda en global
    ];

    let selectIndex = 0;
    const selectMock = vi.fn().mockImplementation(async () => {
      return selects[selectIndex++];
    });

    const inputMock = vi.fn().mockResolvedValue('Ajustar a superficie internal/api y exigir context');

    const llmResponse = JSON.stringify({
      title: 'Regla Refinada por IA',
      surface: 'internal/api',
      description: 'Exigir context.Context en todos los endpoints.',
    });

    const completePromptMock = vi.fn().mockResolvedValue(llmResponse);

    const mockCtx = {
      cwd: tempDir,
      ui: {
        confirm: async () => true,
        select: selectMock,
        input: inputMock,
        notify: vi.fn(),
      },
    };

    const summary = await runExtractTriage({
      draft: singleDraft,
      detectedLang: 'go',
      projectPath: tempDir,
      storage,
      ctx: mockCtx,
      pi: { sendMessage: vi.fn() },
      completePrompt: completePromptMock,
    });

    expect(summary.modified).toBe(1);
    expect(summary.savedToGlobal).toBe(1);

    const saved = await storage.getPlaybook('go');
    const modifiedRule = saved?.invariants.find((i) => i.id === 'rule-to-modify');
    expect(modifiedRule?.title).toBe('Regla Refinada por IA');
    expect(modifiedRule?.surface).toBe('internal/api');
  });

  it('should resolve conflicts when saving to target layer', async () => {
    // Crear regla pre-existente en global
    await storage.savePlaybook({
      language: 'go',
      version: 1,
      updatedAt: '2026-10-08',
      topology: { pattern: 'Standard', directories: [] },
      invariants: [
        {
          id: 'conflict-rule',
          type: 'invariant',
          title: 'Versión Existente',
          surface: 'internal/handlers',
          description: 'No usar gin.',
        },
      ],
      askRules: [],
      snippets: [],
    });

    const conflictingDraft: Playbook = {
      language: 'go',
      version: 1,
      updatedAt: '2026-10-08',
      topology: { pattern: 'Standard', directories: [] },
      invariants: [
        {
          id: 'conflict-rule',
          type: 'invariant',
          title: 'Versión Entrante',
          surface: 'internal/handlers',
          description: 'Usar gin siempre.',
        },
      ],
      askRules: [],
      snippets: [],
    };

    // Usuario elige Global, luego elige "Adoptar nueva"
    const selectMock = vi
      .fn()
      .mockResolvedValueOnce('🌐 1. Global (Lenguaje: GO)')
      .mockResolvedValueOnce('📥 1. Adoptar nueva: "Usar gin siempre."');

    const mockCtx = {
      cwd: tempDir,
      ui: {
        confirm: async () => true,
        select: selectMock,
        notify: vi.fn(),
      },
    };

    const mockPi = { sendMessage: vi.fn() };

    const summary = await runExtractTriage({
      draft: conflictingDraft,
      detectedLang: 'go',
      projectPath: tempDir,
      storage,
      ctx: mockCtx,
      pi: mockPi,
      completePrompt: async () => '',
    });

    expect(summary.savedToGlobal).toBe(1);

    const reloaded = await storage.getPlaybook('go');
    const rule = reloaded?.invariants.find((i) => i.id === 'conflict-rule');
    expect(rule?.description).toBe('Usar gin siempre.');

    // Verificar que se emitió el card de conflicto comparativo a la interfaz
    const conflictMessage = mockPi.sendMessage.mock.calls.find((c: any) =>
      c[0]?.customType === 'gentle-playbook-layer-conflict'
    );
    expect(conflictMessage).toBeDefined();
    expect(conflictMessage[0].content).toContain('Versión Existente');
    expect(conflictMessage[0].content).toContain('Versión Entrante');
  });

  it('should NOT trigger false conflict for distinct rules sharing surface in same layer', async () => {
    // Regla existente b1 en core/style
    await storage.savePlaybook({
      language: 'go',
      version: 1,
      updatedAt: '2026-10-08',
      topology: { pattern: 'Standard', directories: [] },
      invariants: [
        {
          id: 'b1',
          type: 'invariant',
          title: 'Modular Hexagonal',
          surface: 'core/style',
          description: 'Usar app/ y ports/.',
        },
      ],
      askRules: [],
      snippets: [],
    });

    // Regla entrante b5 en core/style (distinto ID)
    const distinctDraft: Playbook = {
      language: 'go',
      version: 1,
      updatedAt: '2026-10-08',
      topology: { pattern: 'Standard', directories: [] },
      invariants: [
        {
          id: 'b5',
          type: 'invariant',
          title: 'Mocks Manuales',
          surface: 'core/style',
          description: 'Usar structs con closures.',
        },
      ],
      askRules: [],
      snippets: [],
    };

    // Solo debe preguntar a dónde guardarla (Global), NO debe preguntar por conflicto
    const selectMock = vi
      .fn()
      .mockResolvedValueOnce('🌐 1. Global (Lenguaje: GO)');

    const mockCtx = {
      cwd: tempDir,
      ui: {
        confirm: async () => true,
        select: selectMock,
        notify: vi.fn(),
      },
    };

    const mockPi = { sendMessage: vi.fn() };

    const summary = await runExtractTriage({
      draft: distinctDraft,
      detectedLang: 'go',
      projectPath: tempDir,
      storage,
      ctx: mockCtx,
      pi: mockPi,
      completePrompt: async () => '',
    });

    expect(summary.savedToGlobal).toBe(1);
    // select solo fue llamado 1 vez (para elegir Global), nunca para conflicto
    expect(selectMock).toHaveBeenCalledTimes(1);

    const reloaded = await storage.getPlaybook('go');
    expect(reloaded?.invariants.length).toBe(2);
    expect(reloaded?.invariants.some((i) => i.id === 'b1')).toBe(true);
    expect(reloaded?.invariants.some((i) => i.id === 'b5')).toBe(true);
  });
});
