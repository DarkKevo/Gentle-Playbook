# Feature: Decouple Playbook from System Prompt via Tool (Issue #10 - Check 1)

## Context & Objectives
Issue #10 identified that injecting playbooks into `event.systemPromptOptions` (the System Prompt) leaves the LLM vulnerable to prompt injection and behavioral hijacking because the System Prompt is a privileged channel.
Check 1 requires decoupling the playbook from the system prompt:
- Expose the playbook and agent supervision preferences as a model-callable Pi tool (`playbook_consult`).
- Remove the `before_agent_start` system prompt injection entirely.
- Eliminate dead code related to system prompt formatting and injection.
- Keep the test suite hermetic, updated, and 100% green.

## Tasks

- [x] Task 1: Design and register `playbook_consult` tool in Pi extension (`src/index.ts`) using TypeBox schema.
- [x] Task 2: Remove `before_agent_start` system prompt injection and eliminate dead code in `src/index.ts` and `src/core/parser.ts`.
- [x] Task 3: Update extension tests and parser/security test suites to verify tool-based retrieval and assert no system prompt pollution.
- [x] Task 4: Full verification (`npm test` and `npx tsc --noEmit`) and work-unit commit.
- [x] Task 5: Unify entry security policy across extract, manual Markdown parsing, and storage (Issue #10 - Check 2).
