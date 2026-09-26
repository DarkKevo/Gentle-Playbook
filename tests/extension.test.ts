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

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gentle-extension-test-'));
    originalEnv = process.env.GENTLE_PLAYBOOK_DIR;
    process.env.GENTLE_PLAYBOOK_DIR = tempDir;
  });

  afterEach(async () => {
    if (originalEnv !== undefined) {
      process.env.GENTLE_PLAYBOOK_DIR = originalEnv;
    } else {
      delete process.env.GENTLE_PLAYBOOK_DIR;
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
});
