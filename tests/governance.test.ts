import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildSystemGuidance,
  playbookDisplayName,
  evaluateWorkspacePrompt,
  isBypassViolation,
  buildBypassBlockedMessage,
  buildHeadlessRedirectDirective,
  buildAskDefaultDirective,
  matchesAgentToolSurface,
  buildAgentNeverBlockReason,
  buildAgentAskHeadlessBlockReason,
  buildAgentInvariantHeadlessBlockReason,
  buildPathViolationBlockReason,
} from '../src/core/governance.js';
import { Playbook, AGENTS_PREFERENCES_ID } from '../src/core/schema.js';

function surfaceConflictPlaybook(): Playbook {
  return {
    language: 'go',
    version: 1,
    updatedAt: '2026-10-11',
    topology: { pattern: 'Hexagonal', directories: ['internal/adapters/http'] },
    invariants: [
      {
        id: 'canonical-http',
        type: 'invariant',
        title: 'Handlers HTTP en ports',
        surface: 'internal/ports/httpserver/',
        description:
          'Los handlers HTTP viven exclusivamente en internal/ports/httpserver/. No crear handlers en main.go ni en pkg/ ni en cmd/.',
      },
    ],
    askRules: [],
    neverRules: [],
    snippets: [],
  };
}

function askPlaybook(): Playbook {
  return {
    language: 'go',
    version: 1,
    updatedAt: '2026-10-11',
    topology: { pattern: 'Standard', directories: ['src/'] },
    invariants: [],
    askRules: [
      {
        id: 'rate-limit',
        type: 'ask',
        title: 'Rate limiting on public endpoints',
        surface: 'src/',
        description: 'Rate limiting for public endpoints',
        trigger: 'crear endpoints públicos',
        antiTrigger: 'rutas privadas autenticadas',
        prompt: 'Do you want rate limiting on this endpoint?',
        defaultAction: 'Continue without rate limiting',
      },
    ],
    neverRules: [],
    snippets: [],
  };
}

function workspacePlaybook(): Playbook {
  return {
    language: 'test',
    version: 1,
    updatedAt: '2026-10-11',
    topology: { pattern: 'Standard', directories: ['src/'] },
    invariants: [
      {
        id: 'test-invariant',
        type: 'invariant',
        title: 'Test Invariant',
        surface: 'src/',
        description: 'Place code under src/',
      },
    ],
    askRules: [],
    neverRules: [],
    snippets: [],
  };
}

describe('core/governance shared module (runtime-agnostic parity)', () => {
  describe('buildSystemGuidance', () => {
    it('renders the guidance pointer naming each active layer', () => {
      const text = buildSystemGuidance([workspacePlaybook()]);
      expect(text).toContain('[gentle-playbook] Este workspace cuenta con normas activas (playbook de TEST)');
      expect(text).toContain('`playbook_consult`');
    });

    it('names local, stack and agent layers distinctly', () => {
      const local: Playbook = { ...workspacePlaybook(), scope: 'project', language: 'project' };
      const guidance = buildSystemGuidance([local]);
      expect(guidance).toContain('playbook local (playbook.md)');
    });

    it('returns the same directive text for identical inputs (deterministic)', () => {
      const pbs = [workspacePlaybook()];
      expect(buildSystemGuidance(pbs)).toBe(buildSystemGuidance(pbs));
    });
  });

  describe('playbookDisplayName', () => {
    it('labels agent preferences by name', () => {
      const agents: Playbook = { ...workspacePlaybook(), language: AGENTS_PREFERENCES_ID };
      expect(playbookDisplayName(agents)).toBe('Agents Preferences');
    });

    it('upper-cases language playbooks', () => {
      expect(playbookDisplayName(workspacePlaybook())).toBe('TEST');
    });
  });

  describe('evaluateWorkspacePrompt', () => {
    it('collects surface conflicts from active playbooks', async () => {
      const pbs = [surfaceConflictPlaybook()];
      const evaluation = await evaluateWorkspacePrompt('crear el handler dentro de pkg/handlers', pbs);
      expect(evaluation.violations.length).toBeGreaterThan(0);
      expect(evaluation.violations[0].violation.rule.id).toBe('canonical-http');
      expect(evaluation.asks.length).toBe(0);
    });

    it('collects triggered ask rules without violations', async () => {
      const pbs = [askPlaybook()];
      const evaluation = await evaluateWorkspacePrompt('crear el endpoint /login público', pbs);
      expect(evaluation.violations.length).toBe(0);
      expect(evaluation.asks.length).toBe(1);
      expect(evaluation.asks[0].ask.rule.id).toBe('rate-limit');
    });

    it('returns empty results for neutral prompts', async () => {
      const evaluation = await evaluateWorkspacePrompt('explique el codigo actual', [workspacePlaybook()]);
      expect(evaluation.violations.length).toBe(0);
      expect(evaluation.asks.length).toBe(0);
    });
  });

  describe('isBypassViolation + buildBypassBlockedMessage', () => {
    it('flags checkpoint bypass kind as bypass', () => {
      expect(
        isBypassViolation({ kind: 'checkpoint_bypass', rule: { id: 'x', description: 'd' }, reason: 'r' } as any)
      ).toBe(true);
      expect(
        isBypassViolation({ kind: 'surface_conflict', rule: { id: 'x', description: 'd' }, reason: 'r' } as any)
      ).toBe(false);
    });

    it('renders the exact headless fail-closed bypass message', () => {
      const msg = buildBypassBlockedMessage();
      expect(msg).toBe(
        '❌ [GOBERNANZA PLAYBOOK] Operación bloqueada: No se permite omitir puntos de control ("sin consultar") en entornos desatendidos sin confirmación interactiva.'
      );
    });
  });

  describe('directive builders (byte-parity with historical Pi behavior)', () => {
    it('renders the headless canonical redirect directive', () => {
      const directive = buildHeadlessRedirectDirective(
        'crea un handler http en cmd/server',
        'CANONICAL-HTTP',
        'El handler no vive en la superficie canonica',
        'internal/adapters/http'
      );
      expect(directive).toBe(
        '[ADVERTENCIA DE GOBERNANZA PLAYBOOK]: El requerimiento entra en conflicto con la regla [CANONICAL-HTTP]: El handler no vive en la superficie canonica. ' +
          'En modo desatendido se aplica la arquitectura canónica: implementa el feature solicitado ("crea un handler http en cmd/server") ' +
          'ubicando el código exclusivamente en "internal/adapters/http" y sin usar las tecnologías prohibidas. Detalla esta decisión al inicio de tu respuesta.'
      );
    });

    it('renders the headless ask default directive', () => {
      const directive = buildAskDefaultDirective('crear endpoint /login', 'RATE-LIMIT', 'Continue without rate limiting');
      expect(directive).toBe(
        '[DIRECTIVA DE GOBERNANZA PLAYBOOK]: Ejecución desatendida. Para la regla [ASK:RATE-LIMIT], aplica la acción por defecto: "Continue without rate limiting". ' +
          'Implementa completamente el requerimiento base solicitado ("crear endpoint /login") respetando este default.'
      );
    });
  });

  describe('matchesAgentToolSurface', () => {
    it('matches tools:all, the exact tool, write/edit aliases and bare tools', () => {
      expect(matchesAgentToolSurface('tools:all', 'write')).toBe(true);
      expect(matchesAgentToolSurface('tools:write', 'edit')).toBe(true);
      expect(matchesAgentToolSurface('tools:edit', 'write')).toBe(true);
      expect(matchesAgentToolSurface('tools:write', 'write')).toBe(true);
      expect(matchesAgentToolSurface('tools', 'write')).toBe(true);
      expect(matchesAgentToolSurface('tools:delete', 'write')).toBe(false);
      expect(matchesAgentToolSurface(undefined, 'write')).toBe(false);
    });

    it('supports comma-separated surfaces case-insensitively', () => {
      expect(matchesAgentToolSurface('Tools:Write, git:push', 'write')).toBe(true);
      expect(matchesAgentToolSurface('git:push', 'write')).toBe(false);
    });
  });

  describe('write-barrier block reason builders', () => {
    it('renders agent never block reason', () => {
      const reason = buildAgentNeverBlockReason({ id: 'never-write', description: 'no writes allowed' } as any);
      expect(reason).toBe('Operación bloqueada por prohibición de agente [NEVER-WRITE]: no writes allowed');
    });

    it('renders agent ask headless block reason', () => {
      const reason = buildAgentAskHeadlessBlockReason({
        id: 'ask-confirm',
        defaultAction: 'Detener y pedir instrucciones',
      } as any);
      expect(reason).toBe(
        'Operación bloqueada en modo desatendido por punto de control [ASK-CONFIRM]: Detener y pedir instrucciones'
      );
    });

    it('renders agent invariant headless block reason naming the tool', () => {
      const reason = buildAgentInvariantHeadlessBlockReason(
        { id: 'inv-approval', description: 'requires approval' } as any,
        'write'
      );
      expect(reason).toBe(
        'Operación bloqueada: la acción "write" requiere autorización interactiva según la regla [INV-APPROVAL]: requires approval'
      );
    });

    it('renders path violation block reason pointing to the canonical surface', () => {
      const reason = buildPathViolationBlockReason('cmd/server/main.go', {
        rule: { id: 'canonical-http', description: 'handlers live in the http layer', surface: 'internal/adapters/http' },
        reason: 'fuera de la superficie canonica',
      } as any);
      expect(reason).toBe(
        'Operación bloqueada: la ruta "cmd/server/main.go" viola la regla [CANONICAL-HTTP]: handlers live in the http layer. ' +
          'Debes ubicar este código exclusivamente dentro de "internal/adapters/http".'
      );
    });
  });
});
