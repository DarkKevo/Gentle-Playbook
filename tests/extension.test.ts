import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import registerExtension, { ExtensionAPI } from '../src/index.js';
import { PlaybookStorage } from '../src/core/storage.js';
import { Playbook, AGENTS_PREFERENCES_ID } from '../src/core/schema.js';

describe('Gentle Playbook Extension Hooks', () => {
  let tempDir: string;
  let originalEnv: string | undefined;
  let originalCodegraphBin: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gentle-extension-test-'));
    originalEnv = process.env.GENTLE_PLAYBOOK_DIR;
    process.env.GENTLE_PLAYBOOK_DIR = tempDir;
    originalCodegraphBin = process.env.CODEGRAPH_BIN;
    process.env.CODEGRAPH_BIN = '/bin/non-existent-codegraph-bin';
  });

  afterEach(async () => {
    if (originalEnv !== undefined) {
      process.env.GENTLE_PLAYBOOK_DIR = originalEnv;
    } else {
      delete process.env.GENTLE_PLAYBOOK_DIR;
    }
    if (originalCodegraphBin !== undefined) {
      process.env.CODEGRAPH_BIN = originalCodegraphBin;
    } else {
      delete process.env.CODEGRAPH_BIN;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should inject agents-preferences into system prompt on before_agent_start', async () => {
    const storage = new PlaybookStorage(tempDir);
    const agentPb: Playbook = {
      language: AGENTS_PREFERENCES_ID,
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
      askRules: [
        {
          id: 'ask-destructive',
          type: 'ask',
          title: 'Confirmación destructiva',
          surface: 'tools:bash',
          trigger: 'Comandos rm -rf',
          antiTrigger: 'Comandos de lectura',
          prompt: '¿Autorizas este comando destructivo?',
          defaultAction: 'Cancelar',
        },
      ],
      snippets: [],
    };
    await storage.saveAgentPreferences(agentPb);

    const commands: Record<string, any> = {};
    const listeners: Record<string, Function> = {};

    const mockPi: ExtensionAPI = {
      registerCommand(name, options) {
        commands[name] = options;
      },
      sendMessage: vi.fn(),
      on(event, handler) {
        listeners[event] = handler;
      },
    };

    registerExtension(mockPi);

    expect(commands['gentle-playbook']).toBeDefined();
    expect(commands['gentle-playbook-add']).toBeDefined();
    expect(listeners['before_agent_start']).toBeDefined();

    // Trigger before_agent_start in a generic cwd (no language detected)
    const event: any = {
      systemPromptOptions: {
        sections: {},
      },
    };
    const ctx = { cwd: tempDir };

    await listeners['before_agent_start'](event, ctx);

    const injected = event.systemPromptOptions.sections['gentle_playbook'];
    expect(injected).toBeDefined();
    expect(injected).toContain('AGENT SUPERVISION & OPERATIONAL BOUNDARIES');
    expect(injected).toContain('require-write-approval');
    expect(injected).toContain('tools:write,tools:edit');
    expect(injected).toContain('¿Autorizas este comando destructivo?');
  });

  it('should inject agents-preferences with neverRules into system prompt', async () => {
    const storage = new PlaybookStorage(tempDir);
    const agentPb: Playbook = {
      language: AGENTS_PREFERENCES_ID,
      version: 1,
      updatedAt: '2026-03-30',
      topology: { pattern: 'Agent Runtime', directories: [] },
      invariants: [],
      askRules: [],
      neverRules: [
        {
          id: 'no-push-to-main',
          type: 'never',
          title: 'Prohibido push a main',
          surface: 'git:push',
          description: 'No hacer git push directo a la rama main o master.',
        },
      ],
      snippets: [],
    };
    await storage.saveAgentPreferences(agentPb);

    const listeners: Record<string, Function> = {};
    const mockPi: ExtensionAPI = {
      registerCommand: vi.fn(),
      sendMessage: vi.fn(),
      on(event, handler) {
        listeners[event] = handler;
      },
    };

    registerExtension(mockPi);

    const event: any = { systemPromptOptions: { sections: {} } };
    const ctx = { cwd: tempDir };

    await listeners['before_agent_start'](event, ctx);

    const injected = event.systemPromptOptions.sections['gentle_playbook'];
    expect(injected).toBeDefined();
    expect(injected).toContain('RESTRICTED ACTIONS');
    expect(injected).toContain('no-push-to-main');
    expect(injected).toContain('No hacer git push directo a la rama main o master');
  });

  it('should abort extract immediately with error notification when model is missing', async () => {
    const commands: Record<string, any> = {};
    const mockPi: ExtensionAPI = {
      registerCommand(name, options) {
        commands[name] = options;
      },
      sendMessage: vi.fn(),
      on: vi.fn(),
    };

    registerExtension(mockPi);

    const notifyMock = vi.fn();
    const ctx = {
      cwd: tempDir,
      modelRegistry: null,
      model: null,
      ui: { notify: notifyMock },
    };

    await commands['gentle-playbook'].handler('extract', ctx);

    expect(notifyMock).toHaveBeenCalledWith(
      expect.stringContaining('Se requiere un modelo activo en Pi'),
      'error'
    );
  });

  it('should not touch disk when user cancels final confirmation in extract', async () => {
    const commands: Record<string, any> = {};
    const mockPi: ExtensionAPI = {
      registerCommand(name, options) {
        commands[name] = options;
      },
      sendMessage: vi.fn(),
      on: vi.fn(),
    };

    registerExtension(mockPi);

    const notifyMock = vi.fn();
    const confirmMock = vi.fn().mockResolvedValue(false);
    const modelCompleteMock = vi.fn().mockResolvedValue({
      content: [
        {
          text: `=== REPORTE DE EVIDENCIA ===\n| E1 | Regla | INVARIANT | 1/1 | main.go:1 | ninguno |\n\n=== PLAYBOOK COMPACTO ===\n\`\`\`markdown\n---
source: ${tempDir}
lang: go
project_type: cli
stack: none
extracted: 2026-03-30
---\n## Invariants\n- [B1] Regla de prueba\n\`\`\``,
        },
      ],
    });

    const ctx = {
      cwd: tempDir,
      modelRegistry: { complete: modelCompleteMock },
      model: { id: 'test-model' },
      ui: {
        notify: notifyMock,
        confirm: confirmMock,
        select: vi.fn(),
      },
    };

    await commands['gentle-playbook'].handler('extract', ctx);

    expect(confirmMock).toHaveBeenCalled();
    expect(notifyMock).toHaveBeenCalledWith(
      expect.stringContaining('Guardado cancelado por el usuario'),
      'info'
    );

    const storage = new PlaybookStorage(tempDir);
    const pb = await storage.getPlaybook('go');
    expect(pb).toBeNull();
  });

  it('should parse --lang flag in extract command without treating it as an invalid path', async () => {
    const commands: Record<string, any> = {};
    const mockPi: ExtensionAPI = {
      registerCommand(name, options) {
        commands[name] = options;
      },
      sendMessage: vi.fn(),
      on: vi.fn(),
    };

    registerExtension(mockPi);

    const notifyMock = vi.fn();
    const ctx = {
      cwd: tempDir,
      modelRegistry: null,
      model: null,
      ui: { notify: notifyMock },
    };

    await commands['gentle-playbook'].handler('extract --lang typescript', ctx);

    expect(notifyMock).toHaveBeenCalledWith(
      expect.stringContaining('Se requiere un modelo activo en Pi'),
      'error'
    );
    expect(notifyMock).not.toHaveBeenCalledWith(
      expect.stringContaining('no existe'),
      'error'
    );
  });

  it('should not write to disk when UI confirm is missing and --yes is not passed', async () => {
    const commands: Record<string, any> = {};
    const mockPi: ExtensionAPI = {
      registerCommand(name, options) {
        commands[name] = options;
      },
      sendMessage: vi.fn(),
      on: vi.fn(),
    };

    registerExtension(mockPi);

    const notifyMock = vi.fn();
    const modelCompleteMock = vi.fn().mockResolvedValue({
      content: [
        {
          text: `=== REPORTE DE EVIDENCIA ===\n| E1 | Regla | INVARIANT | 1/1 | main.go:1 | ninguno |\n\n=== PLAYBOOK COMPACTO ===\n\`\`\`markdown\n---
source: ${tempDir}
lang: go
project_type: cli
stack: none
extracted: 2026-03-30
---\n## Invariants\n- [B1] Regla sin UI\n\`\`\``,
        },
      ],
    });

    // Context without ui.confirm
    const ctx = {
      cwd: tempDir,
      modelRegistry: { complete: modelCompleteMock },
      model: { id: 'test-model' },
      ui: {
        notify: notifyMock,
        // no confirm property!
      },
    };

    await commands['gentle-playbook'].handler('extract', ctx);

    expect(notifyMock).toHaveBeenCalledWith(
      expect.stringContaining('Extracción completada sin guardar: se requiere confirmación'),
      'warning'
    );

    const storage = new PlaybookStorage(tempDir);
    const pb = await storage.getPlaybook('go');
    expect(pb).toBeNull();
  });

  it('should write to disk when UI confirm is missing but --yes is passed', async () => {
    const commands: Record<string, any> = {};
    const mockPi: ExtensionAPI = {
      registerCommand(name, options) {
        commands[name] = options;
      },
      sendMessage: vi.fn(),
      on: vi.fn(),
    };

    registerExtension(mockPi);

    const notifyMock = vi.fn();
    const modelCompleteMock = vi.fn().mockResolvedValue({
      content: [
        {
          text: `=== REPORTE DE EVIDENCIA ===\n| E1 | Regla | INVARIANT | 1/1 | main.go:1 | ninguno |\n\n=== PLAYBOOK COMPACTO ===\n\`\`\`markdown\n---
source: ${tempDir}
lang: go
project_type: cli
stack: none
extracted: 2026-03-30
---\n## Invariants\n- [B1] Regla guardada con autoConfirm\n\`\`\``,
        },
      ],
    });

    const ctx = {
      cwd: tempDir,
      modelRegistry: { complete: modelCompleteMock },
      model: { id: 'test-model' },
      ui: {
        notify: notifyMock,
      },
    };

    await commands['gentle-playbook'].handler('extract --lang go --yes', ctx);

    expect(notifyMock).toHaveBeenCalledWith(
      expect.stringContaining('Playbook para go actualizado'),
      'info'
    );

    const storage = new PlaybookStorage(tempDir);
    const pb = await storage.getPlaybook('go');
    expect(pb).not.toBeNull();
    expect(pb?.language).toBe('go');
  });

  describe('Interactive Playbook & Rule Deletion in Pi (TUI-First)', () => {
    let storage: PlaybookStorage;

    beforeEach(async () => {
      storage = new PlaybookStorage(tempDir);
      // Seed storage with a test playbook
      await storage.savePlaybook({
        language: 'go',
        version: 1,
        updatedAt: '2026-03-30',
        topology: { pattern: 'Standard', directories: [] },
        invariants: [
          {
            id: 'rule-to-delete',
            type: 'invariant',
            title: 'Delete Me',
            surface: 'pkg/',
            description: 'To be removed',
          },
          {
            id: 'rule-to-keep',
            type: 'invariant',
            title: 'Keep Me',
            surface: 'pkg/',
            description: 'Must remain',
          },
        ],
        askRules: [],
        snippets: [],
      });
    });

    it('should delete full playbook when user selects full deletion and confirms', async () => {
      const commands: Record<string, any> = {};
      const mockPi: ExtensionAPI = {
        registerCommand(name, options) {
          commands[name] = options;
        },
        sendMessage: vi.fn(),
        on: vi.fn(),
      };
      registerExtension(mockPi);

      const notifyMock = vi.fn();
      const selectMock = vi.fn().mockResolvedValue('🗑️ Eliminar el playbook completo de este lenguaje');
      const confirmMock = vi.fn().mockResolvedValue(true);

      const ctx = {
        cwd: tempDir,
        ui: {
          select: selectMock,
          confirm: confirmMock,
          notify: notifyMock,
        },
      };

      await commands['gentle-playbook'].handler('delete go', ctx);

      expect(selectMock).toHaveBeenCalled();
      expect(confirmMock).toHaveBeenCalled();
      expect(notifyMock).toHaveBeenCalledWith(
        expect.stringContaining('eliminado por completo'),
        'info'
      );

      const pb = await storage.getPlaybook('go');
      expect(pb).toBeNull();
    });

    it('should cancel full playbook deletion when user rejects confirmation', async () => {
      const commands: Record<string, any> = {};
      const mockPi: ExtensionAPI = {
        registerCommand(name, options) {
          commands[name] = options;
        },
        sendMessage: vi.fn(),
        on: vi.fn(),
      };
      registerExtension(mockPi);

      const notifyMock = vi.fn();
      const selectMock = vi.fn().mockResolvedValue('🗑️ Eliminar el playbook completo de este lenguaje');
      const confirmMock = vi.fn().mockResolvedValue(false);

      const ctx = {
        cwd: tempDir,
        ui: {
          select: selectMock,
          confirm: confirmMock,
          notify: notifyMock,
        },
      };

      await commands['gentle-playbook'].handler('delete go', ctx);

      expect(confirmMock).toHaveBeenCalled();
      expect(notifyMock).toHaveBeenCalledWith(
        expect.stringContaining('cancelada por el usuario'),
        'info'
      );

      const pb = await storage.getPlaybook('go');
      expect(pb).not.toBeNull();
    });

    it('should surgically delete a specific rule from a playbook in Pi TUI', async () => {
      const commands: Record<string, any> = {};
      const mockPi: ExtensionAPI = {
        registerCommand(name, options) {
          commands[name] = options;
        },
        sendMessage: vi.fn(),
        on: vi.fn(),
      };
      registerExtension(mockPi);

      const notifyMock = vi.fn();
      // First select: choose rule deletion
      // Second select: choose the specific rule
      const selectMock = vi
        .fn()
        .mockResolvedValueOnce('✂️ Eliminar una regla específica del playbook')
        .mockResolvedValueOnce('[INVARIANT] rule-to-delete: Delete Me');

      const confirmMock = vi.fn().mockResolvedValue(true);

      const ctx = {
        cwd: tempDir,
        ui: {
          select: selectMock,
          confirm: confirmMock,
          notify: notifyMock,
        },
      };

      await commands['gentle-playbook'].handler('delete go', ctx);

      expect(notifyMock).toHaveBeenCalledWith(
        expect.stringContaining('eliminada con éxito'),
        'info'
      );

      const pb = await storage.getPlaybook('go');
      expect(pb).not.toBeNull();
      expect(pb?.invariants.some((i) => i.id === 'rule-to-delete')).toBe(false);
      expect(pb?.invariants.some((i) => i.id === 'rule-to-keep')).toBe(true);
    });

    it('should cancel specific rule deletion when user rejects confirmation', async () => {
      const commands: Record<string, any> = {};
      const mockPi: ExtensionAPI = {
        registerCommand(name, options) {
          commands[name] = options;
        },
        sendMessage: vi.fn(),
        on: vi.fn(),
      };
      registerExtension(mockPi);

      const notifyMock = vi.fn();
      const selectMock = vi
        .fn()
        .mockResolvedValueOnce('✂️ Eliminar una regla específica del playbook')
        .mockResolvedValueOnce('[INVARIANT] rule-to-delete: Delete Me');

      const confirmMock = vi.fn().mockResolvedValue(false);

      const ctx = {
        cwd: tempDir,
        ui: {
          select: selectMock,
          confirm: confirmMock,
          notify: notifyMock,
        },
      };

      await commands['gentle-playbook'].handler('delete go', ctx);

      expect(notifyMock).toHaveBeenCalledWith(
        expect.stringContaining('Eliminación de regla cancelada'),
        'info'
      );

      const pb = await storage.getPlaybook('go');
      expect(pb?.invariants.some((i) => i.id === 'rule-to-delete')).toBe(true);
    });

    it('should notify error when trying to delete a non-existent playbook', async () => {
      const commands: Record<string, any> = {};
      const mockPi: ExtensionAPI = {
        registerCommand(name, options) {
          commands[name] = options;
        },
        sendMessage: vi.fn(),
        on: vi.fn(),
      };
      registerExtension(mockPi);

      const notifyMock = vi.fn();
      const ctx = {
        cwd: tempDir,
        ui: { notify: notifyMock },
      };

      await commands['gentle-playbook'].handler('delete rust', ctx);

      expect(notifyMock).toHaveBeenCalledWith(
        expect.stringContaining('no existe en el almacenamiento'),
        'error'
      );
    });

    it('should notify warning when trying to delete a rule from a playbook with no rules', async () => {
      // Save an empty playbook
      await storage.savePlaybook({
        language: 'python',
        version: 1,
        updatedAt: '2026-03-30',
        topology: { pattern: 'Standard', directories: [] },
        invariants: [],
        askRules: [],
        snippets: [],
      });

      const commands: Record<string, any> = {};
      const mockPi: ExtensionAPI = {
        registerCommand(name, options) {
          commands[name] = options;
        },
        sendMessage: vi.fn(),
        on: vi.fn(),
      };
      registerExtension(mockPi);

      const notifyMock = vi.fn();
      const selectMock = vi.fn().mockResolvedValue('✂️ Eliminar una regla específica del playbook');

      const ctx = {
        cwd: tempDir,
        ui: {
          select: selectMock,
          notify: notifyMock,
        },
      };

      await commands['gentle-playbook'].handler('delete python', ctx);

      expect(notifyMock).toHaveBeenCalledWith(
        expect.stringContaining('no tiene reglas individuales'),
        'warning'
      );
    });

    it('should notify error when direct --rule flag targets a non-existent rule id', async () => {
      const commands: Record<string, any> = {};
      const mockPi: ExtensionAPI = {
        registerCommand(name, options) {
          commands[name] = options;
        },
        sendMessage: vi.fn(),
        on: vi.fn(),
      };
      registerExtension(mockPi);

      const notifyMock = vi.fn();
      const confirmMock = vi.fn().mockResolvedValue(true);

      const ctx = {
        cwd: tempDir,
        ui: {
          confirm: confirmMock,
          notify: notifyMock,
        },
      };

      await commands['gentle-playbook'].handler('delete go --rule non-existent-rule', ctx);

      expect(notifyMock).toHaveBeenCalledWith(
        expect.stringContaining('no se encontró'),
        'error'
      );
    });

    it('should include never rules and snippets in the list command summary and options', async () => {
      // Add a never rule and a snippet to the go playbook
      const goPb = await storage.getPlaybook('go');
      if (goPb) {
        goPb.neverRules = [
          {
            id: 'no-heavy-orm',
            type: 'never',
            title: 'No ORM',
            surface: 'general',
            description: 'Do not use heavy ORMs like GORM',
          },
        ];
        goPb.snippets = [
          {
            id: 'canonical-logger',
            title: 'Logger',
            language: 'go',
            code: 'package logger',
          },
        ];
        await storage.savePlaybook(goPb);
      }

      const commands: Record<string, any> = {};
      const mockPi: ExtensionAPI = {
        registerCommand(name, options) {
          commands[name] = options;
        },
        sendMessage: vi.fn(),
        on: vi.fn(),
      };
      registerExtension(mockPi);

      const notifyMock = vi.fn();
      const selectMock = vi.fn().mockImplementation((_title, options) => {
        // Select the option for go
        return options.find((o: string) => o.includes('go'));
      });

      const ctx = {
        cwd: tempDir,
        ui: {
          select: selectMock,
          notify: notifyMock,
        },
      };

      await commands['gentle-playbook'].handler('list', ctx);

      // Verify that options passed to select contained the count of never rules and snippets
      expect(selectMock).toHaveBeenCalled();
      const optionsPassed = selectMock.mock.calls[0][1];
      const goOption = optionsPassed.find((o: string) => o.includes('go'));
      expect(goOption).toContain('prohibiciones (never)');
      expect(goOption).toContain('snippets');

      // Verify that notify summary also contained never rules and snippets
      expect(notifyMock).toHaveBeenCalledWith(
        expect.stringContaining('prohibiciones (never)'),
        'info'
      );
      expect(notifyMock).toHaveBeenCalledWith(
        expect.stringContaining('snippets'),
        'info'
      );
    });
  });
});
