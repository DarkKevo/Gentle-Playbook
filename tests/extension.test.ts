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
    expect(injected).toContain('ACTIVE AGENT GOVERNANCE & SUPERVISION PLAYBOOK');
    expect(injected).toContain('require-write-approval');
    expect(injected).toContain('tools:write,tools:edit');
    expect(injected).toContain('¿Autorizas este comando destructivo?');
  });
});
