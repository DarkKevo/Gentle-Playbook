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

  it('should register playbook_consult tool and serve agent preferences without system prompt injection', async () => {
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
    const tools: Record<string, any> = {};

    const mockPi: ExtensionAPI = {
      registerCommand(name, options) {
        commands[name] = options;
      },
      sendMessage: vi.fn(),
      registerTool(tool) {
        tools[tool.name] = tool;
      },
      on(event, handler) {
        listeners[event] = handler;
      },
    };

    registerExtension(mockPi);

    expect(commands['gentle-playbook']).toBeDefined();
    expect(commands['gentle-playbook-add']).toBeDefined();
    // Verify lightweight guidance pointer is registered in before_agent_start (Eje 4)
    expect(listeners['before_agent_start']).toBeDefined();
    const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
    await listeners['before_agent_start'](event, { cwd: tempDir });
    expect(event.systemPromptOptions.sections.playbook_guidance).toContain('playbook_consult');
    // Ensures zero raw playbook markdown or XML data is injected into system prompt
    expect(event.systemPromptOptions.sections.playbook_guidance).not.toContain('<agent_supervision_context>');
    expect(event.systemPromptOptions.sections.playbook_guidance).not.toContain('<architectural_reference_context>');

    // Verify playbook_consult tool is registered
    expect(tools['playbook_consult']).toBeDefined();
    const tool = tools['playbook_consult'];
    expect(tool.description).toContain('Consult architectural conventions');

    // Execute tool query
    const res = await tool.execute('call-1', { language: 'agents' }, null, null, { cwd: tempDir });
    expect(res.content[0].text).toContain('AGENT SUPERVISION & OPERATIONAL BOUNDARIES');
    expect(res.content[0].text).toContain('require-write-approval');
    expect(res.content[0].text).toContain('tools:write,tools:edit');
    expect(res.content[0].text).toContain('¿Autorizas este comando destructivo?');
  });

  it('should serve agent preferences with neverRules via playbook_consult tool with surface filtering', async () => {
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

    const tools: Record<string, any> = {};
    const listeners: Record<string, Function> = {};
    const mockPi: ExtensionAPI = {
      registerCommand: vi.fn(),
      sendMessage: vi.fn(),
      registerTool(tool) {
        tools[tool.name] = tool;
      },
      on(event, handler) {
        listeners[event] = handler;
      },
    };

    registerExtension(mockPi);

    expect(listeners['before_agent_start']).toBeDefined();
    expect(tools['playbook_consult']).toBeDefined();

    const tool = tools['playbook_consult'];

    // Test with matching surface filter
    const resMatch = await tool.execute('call-2', { language: 'agents', surface: 'git:push' }, null, null, { cwd: tempDir });
    expect(resMatch.content[0].text).toContain('RESTRICTED ACTIONS');
    expect(resMatch.content[0].text).toContain('no-push-to-main');

    // Test with non-matching surface filter
    const resNoMatch = await tool.execute('call-3', { language: 'agents', surface: 'docker:build' }, null, null, { cwd: tempDir });
    expect(resNoMatch.content[0].text).not.toContain('no-push-to-main');
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
        expect.stringContaining('1 prohibiciones (never), 1 snippets'),
        'info'
      );
    });

    it('should NOT mutate disk when add is run without UI confirm and without --yes', async () => {
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
        modelRegistry: {
          complete: vi.fn().mockResolvedValue({
            content: [{ type: 'text', text: JSON.stringify({
              id: 'test-inv',
              title: 'Test Invariant',
              surface: 'src/',
              description: 'Validar',
            }) }],
          }),
        },
        model: { id: 'test' },
        ui: {
          input: vi.fn().mockResolvedValue('Validar inputs de prueba'),
          notify: notifyMock,
          // no confirm method!
        },
      };

      await commands['gentle-playbook-add'].handler('go', ctx);

      expect(notifyMock).toHaveBeenCalledWith(
        expect.stringContaining('se requiere confirmación interactiva o el flag --yes'),
        'warning'
      );

      const pb = await storage.getPlaybook('go');
      expect(pb?.invariants.some((i) => i.title === 'Test Invariant')).toBe(false);
    });

    it('should mutate disk when add is run without UI confirm but with --yes', async () => {
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
        modelRegistry: {
          complete: vi.fn().mockResolvedValue({
            content: [{ type: 'text', text: JSON.stringify({
              id: 'rule-with-yes',
              title: 'Rule With Yes',
              surface: 'src/',
              description: 'Auto-approved rule',
            }) }],
          }),
        },
        model: { id: 'test' },
        ui: {
          input: vi.fn().mockResolvedValue('Auto-approved rule'),
          notify: notifyMock,
          // no confirm method!
        },
      };

      await commands['gentle-playbook-add'].handler('go --yes', ctx);

      expect(notifyMock).toHaveBeenCalledWith(
        expect.stringContaining('Regla guardada con éxito'),
        'info'
      );

      const pb = await storage.getPlaybook('go');
      expect(pb?.invariants.some((i) => i.title === 'Rule With Yes')).toBe(true);
    });

    it('should NOT mutate disk when delete is run without UI confirm and without --yes', async () => {
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
        ui: {
          notify: notifyMock,
          // no select, no confirm!
        },
      };

      await commands['gentle-playbook'].handler('delete go', ctx);

      expect(notifyMock).toHaveBeenCalledWith(
        expect.stringContaining('se requiere confirmación interactiva o el flag --yes'),
        'warning'
      );

      // Playbook must remain intact on disk
      const pb = await storage.getPlaybook('go');
      expect(pb).not.toBeNull();
    });

    it('should mutate disk when delete is run without UI confirm but with --yes', async () => {
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
        ui: {
          notify: notifyMock,
          // no select, no confirm!
        },
      };

      await commands['gentle-playbook'].handler('delete go --yes', ctx);

      expect(notifyMock).toHaveBeenCalledWith(
        expect.stringContaining('eliminado'),
        'info'
      );

      // Playbook must be gone
      const pb = await storage.getPlaybook('go');
      expect(pb).toBeNull();
    });

    it('should NOT delete specific rule via --rule without UI confirm and without --yes', async () => {
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
        ui: {
          notify: notifyMock,
          // no confirm!
        },
      };

      await commands['gentle-playbook'].handler('delete go --rule rule-to-delete', ctx);

      expect(notifyMock).toHaveBeenCalledWith(
        expect.stringContaining('se requiere confirmación interactiva o el flag --yes'),
        'warning'
      );

      const pb = await storage.getPlaybook('go');
      expect(pb?.invariants.some((i) => i.id === 'rule-to-delete')).toBe(true);
    });

    it('should delete specific rule via --rule without UI confirm when --yes is provided', async () => {
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
        ui: {
          notify: notifyMock,
          // no confirm!
        },
      };

      await commands['gentle-playbook'].handler('delete go --rule rule-to-delete --yes', ctx);

      expect(notifyMock).toHaveBeenCalledWith(
        expect.stringContaining('eliminada con éxito'),
        'info'
      );

      const pb = await storage.getPlaybook('go');
      expect(pb?.invariants.some((i) => i.id === 'rule-to-delete')).toBe(false);
    });
  });

  describe('Pre-flight Input and Tool Call Violation Enforcement', () => {
    let storage: PlaybookStorage;
    let commands: Record<string, any>;
    let listeners: Record<string, Function>;

    beforeEach(async () => {
      storage = new PlaybookStorage(tempDir);
      // Create Go project manifest so detectProjectLanguage(tempDir) returns 'go'
      await fs.writeFile(path.join(tempDir, 'go.mod'), 'module test/app\n\ngo 1.22\n');

      const goPlaybook: Playbook = {
        language: 'go',
        version: 1,
        updatedAt: '2026-09-28',
        topology: { pattern: 'Hexagonal', directories: ['internal/ports/httpserver/'] },
        invariants: [
          {
            id: 'http-handlers-ports',
            type: 'invariant',
            title: 'Handlers HTTP en ports',
            surface: 'internal/ports/httpserver/',
            description: 'Los handlers HTTP viven exclusivamente en internal/ports/httpserver/. No crear handlers en main.go ni en pkg/.',
          },
        ],
        askRules: [],
        neverRules: [
          {
            id: 'no-gin',
            type: 'never',
            title: 'No usar Gin',
            surface: 'dependencies',
            description: 'No usar el framework Gin; usar net/http de la biblioteca estándar.',
          },
        ],
        snippets: [],
      };
      await storage.savePlaybook(goPlaybook);

      commands = {};
      listeners = {};

      const fakePi: ExtensionAPI = {
        registerCommand(name, opts) {
          commands[name] = opts;
        },
        sendMessage: vi.fn(),
        registerTool: vi.fn(),
        on(event, handler) {
          listeners[event] = handler;
        },
      };

      registerExtension(fakePi);
    });

    it('should intercept conflicting input and cancel when user declines exception', async () => {
      const confirmMock = vi.fn().mockResolvedValue(false);
      const notifyMock = vi.fn();

      const ctx = {
        cwd: tempDir,
        ui: {
          confirm: confirmMock,
          notify: notifyMock,
        },
      };

      const result = await listeners['input'](
        { text: 'creame un servidor usando el framework Gin' },
        ctx
      );

      expect(confirmMock).toHaveBeenCalledTimes(1);
      expect(confirmMock).toHaveBeenCalledWith(
        expect.stringContaining('Conflicto con Playbook'),
        expect.stringContaining('NO-GIN')
      );
      expect(result).toEqual({ action: 'handled' });
      expect(notifyMock).toHaveBeenCalledWith(
        expect.stringContaining('Acción cancelada'),
        'info'
      );
    });

    it('should allow input through when user accepts exception', async () => {
      const confirmMock = vi.fn().mockResolvedValue(true);
      const notifyMock = vi.fn();

      const ctx = {
        cwd: tempDir,
        ui: {
          confirm: confirmMock,
          notify: notifyMock,
        },
      };

      const result = await listeners['input'](
        { text: 'creame un servidor usando Gin para este test' },
        ctx
      );

      expect(confirmMock).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ action: 'continue' });
    });

    it('should pass neutral input without triggering confirmation dialog', async () => {
      const confirmMock = vi.fn();
      const ctx = {
        cwd: tempDir,
        ui: { confirm: confirmMock },
      };

      const result = await listeners['input'](
        { text: 'creame un endpoint /health con net/http' },
        ctx
      );

      expect(confirmMock).not.toHaveBeenCalled();
      expect(result).toEqual({ action: 'continue' });
    });

    it('should block write tool_call when path violates invariant and user rejects', async () => {
      const confirmMock = vi.fn().mockResolvedValue(false);
      const notifyMock = vi.fn();

      const ctx = {
        cwd: tempDir,
        ui: {
          confirm: confirmMock,
          notify: notifyMock,
        },
      };

      const result = await listeners['tool_call'](
        {
          toolName: 'write',
          input: { path: 'pkg/handlers/health.go', content: 'package handlers' },
        },
        ctx
      );

      expect(confirmMock).toHaveBeenCalledWith(
        expect.stringContaining('Violación de Playbook'),
        expect.stringContaining('pkg/handlers/health.go')
      );
      expect(result).toEqual({
        block: true,
        reason: expect.stringContaining('HTTP-HANDLERS-PORTS'),
      });
      expect(notifyMock).toHaveBeenCalledWith(
        expect.stringContaining('bloqueada'),
        'warning'
      );
    });

    it('should allow write tool_call when target path conforms to invariant', async () => {
      const confirmMock = vi.fn();
      const ctx = {
        cwd: tempDir,
        ui: { confirm: confirmMock },
      };

      const result = await listeners['tool_call'](
        {
          toolName: 'write',
          input: {
            path: 'internal/ports/httpserver/health.go',
            content: 'package httpserver',
          },
        },
        ctx
      );

      expect(confirmMock).not.toHaveBeenCalled();
      expect(result).toBeUndefined();
    });
  });
});
