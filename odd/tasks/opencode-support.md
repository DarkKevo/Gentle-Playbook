# Feature: OpenCode Runtime Support

## Context & Objectives

Community demand: gentle-playbook currently targets Pi only (and el Gentleman via Pi).
OpenCode users ask for the same 4-layer governance (Local > Stack > Global > Agent)
with pre-flight, write-barrier enforcement, and on-demand consultation.

**Verified investigation (2026-10-11):**

- `src/core/*` and `src/extract/*` have zero Pi imports — fully runtime-agnostic.
- Only `src/index.ts` (59 KB) is Pi-specific: it declares a structural `ExtensionAPI`
  interface and registers Pi hooks/commands/tools with thin glue over core modules.
- OpenCode Plugin API (`@opencode-ai/plugin`): `Plugin = async ({project, client, $,
  directory, worktree, serverUrl}) => Hooks` with hooks `event`, `chat.message`
  (mutate UserMessage parts), `tool.execute.before` (throw = block), `chat.params`,
  `permission.ask`, `experimental.chat.system.transform`, `experimental.session.compacting`,
  and custom tools via `tool: { [name]: tool({description, args, execute}) }` (Zod).
- OpenCode commands (`~/.config/opencode/command/*.md`) are markdown prompt templates
  with frontmatter — no TypeScript handlers. There is no plugin UI API
  (select/confirm/input), so interactive wizards must be **agent-mediated**:
  command templates orchestrate, the agent asks the user, tools execute.

**Decisions (user-confirmed):**

1. Fork-first implementation, then PR upstream (DarkKevo/Gentle-Playbook).
2. Agent-mediated interactivity model for add/extract/delete flows.

## Non-Goals

- No change to existing Pi behavior (Pi tests must stay green, byte-for-byte semantics).
- No npm publication in v1 (installer-copy distribution to `~/.config/opencode/plugins/`).
- The heavy `runAgentExtraction` pipeline stays Pi-only; OpenCode extract is
  agent-mediated (the agent explores the reference repo with its own tools).

## Tasks

- [x] Task 1: Shared governance module. Extract runtime-agnostic logic from
  `src/index.ts` into `src/core/governance.ts`: system-guidance pointer builder,
  deterministic pre-flight directive builder (evaluatePromptFull → directive text,
  no interactive branches), agent-preferences tool-surface matching
  (neverRules/askRules/invariants over `tools:*`), and path-violation barrier
  decision. Refactor `src/index.ts` to consume it with **no behavior change**.
  All existing tests stay green. — Commit: `refactor(core): extract runtime-agnostic governance module shared by Pi and OpenCode runtimes` (229/229 tests, tsc clean; 18 new parity tests in tests/governance.test.ts)
- [x] Task 2: OpenCode plugin entry (`src/opencode.ts`). Register `playbook_consult`
  tool (Zod args: language, surface) reusing core formatting; `experimental.chat.system.transform`
  guidance pointer; `chat.message` pre-flight (transform path: append governance
  directive to user message parts, verify blocking behavior of throw empirically);
  `tool.execute.before` write barrier for write/edit (fail-closed);
  `experimental.session.compacting` playbook-context injection (OpenCode-only bonus);
  `event` session.created active-playbook notification. — Commit: `feat(opencode): add OpenCode plugin entry with consult tool, pre-flight and write barrier`.
  Empirical findings baked into the design: `throw` in `chat.message` does NOT cancel
  the message (upstream opencode issue #30434), so bypass attempts become visible
  governance directives (`buildBypassGovernanceDirective`) while the write barrier
  keeps real enforcement; parts are mutated in-place instead of pushed (upstream
  issue #23440); write/edit/patch tools targeted via `filePath` args; zod 4.1.8
  devDependency matching @opencode-ai/plugin. Structural types follow the repo's
  ExtensionAPI precedent (no @opencode-ai/plugin dependency). 247/247 tests, tsc clean.
- [x] Task 3: `playbook_manage` tool (agent-mediated mutations). Two-phase actions:
  `preview` (collision check + formatted preview, no write) and `save` (persist via
  core storage), plus `delete` (rule or whole playbook). The agent synthesizes rules
  conversationally (LLM = the agent itself; no headless modelRegistry needed) and
  drives confirmation with the user between preview and save. — Commit: `feat(opencode): add agent-mediated playbook_manage tool with preview/save/delete`.
  Hardening over the Pi flow: injection-like rule content is validated loudly via
  validateRuleContent before persisting (never silently dropped by the storage
  sanitizer — the T2 gotcha became a feature); deletes support global/stack/agents/
  project targets; whole-playbook delete refuses project (edit playbook.md directly).
- [ ] Task 4: Command templates (Spanish, repo convention) in
  `src/opencode-commands/`: `playbook.md` (list/show/inspect),
  `playbook-add.md` (agent-mediated add wizard using playbook_manage),
  `playbook-extract.md` (agent-mediated essence extraction + 1-a-1 triage),
  `playbook-stack.md` (stack management guidance),
  `playbook-delete.md` (agent-mediated delete wizard).
- [ ] Task 5: Build & installer. Single-file esbuild bundle of the OpenCode entry
  (`dist/opencode.js`), `install.sh` gains an OpenCode path: copy bundle to
  `~/.config/opencode/plugins/gentle-playbook.js` and command templates to
  `~/.config/opencode/command/`. Idempotent (overwrite on re-install).
- [ ] Task 6: Tests. Vitest suite for governance module (Pi + OpenCode parity),
  OpenCode hooks with mocked `PluginInput`/Hooks harness, `playbook_manage`
  preview/save/delete round-trip, command template files exist with valid
  frontmatter. Run full `npm test` + `tsc --noEmit`.
- [ ] Task 7: Docs. README (Spanish) section "Soporte OpenCode": architecture,
  install, command usage, parity table (what maps, what is agent-mediated),
  and the compaction-context bonus. Task doc evidence updated with commits.

## Verification (per task)

- `npm test` (vitest) — all green, including pre-existing suites.
- `npx tsc --noEmit` — type-check clean.
- Manual smoke: load plugin in OpenCode from a scratch config dir, verify
  `playbook_consult` answers, `tool.execute.before` blocks a violating write,
  system transform injects the pointer, commands expand.

## Evidence

(to be filled with work-unit commits on `feat/opencode-support`)

