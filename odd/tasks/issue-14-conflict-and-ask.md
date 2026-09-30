# Feature: Governance Conflict Resolution, Interactive Asks & Categorical Bans (Issue #14)

## Context & Objectives
Issue #14 highlights residual governance issues from #12 under `--print` and interactive runs:
1. **Silent Abort on Conflict**: When the prompt or tool contradicts topology or never rules, the session dies silently (exit 0) with no files and no explanation.
2. **Ask Catalog Starvation**: When an Ask rule triggers (e.g. rate limit on public login), the agent only asks the question and fails to generate the requested base feature.
3. **Interactive Ask Routing**: Ask rules must trigger TUI confirmation (`ctx.ui.confirm`). If Yes -> build with the extra. If No -> build without the extra (default). In both cases, the base feature MUST be built. In headless -> build base with default.
4. **Enforce Interactive TUI on Bypass**: Bypassing checkpoints ("sin consultar", "no preguntes") strictly requires interactive TUI confirmation; fails safe in headless.
5. **Categorical / Family Prohibitions (Never)**: When a rule demands standard library or bans a framework family, analogous libraries (e.g. Chi, Echo, Fiber when stdlib net/http is demanded) must be caught semantically and categorically.

## Tasks

- [x] Task 1: Ask Catalog Interactive TUI & Feature Delivery. Detect Ask triggers, activate `ctx.ui.confirm` in `src/index.ts`, append directive to implement base feature with/without extra, never starving base feature generation.
- [x] Task 2: Conflict Resolution & Anti-Silent Exit. On topology/kit conflict in `src/index.ts` / `checker.ts`, offer TUI redirect/exception/cancel; in headless never exit 0 silently—redirect canonically with visible notice or reject visibly.
- [x] Task 3: Checkpoint Bypass Defense. Require interactive TUI on "sin consultar" / "no preguntes"; fail safe with explicit diagnostic in headless environments.
- [x] Task 4: Categorical & Family Prohibitions in Never Rules. Update semantic evaluation and checker pattern matching to identify family members and stdlib-exclusivity violations (e.g. Chi/Echo when Gin is banned and net/http is mandated).
- [x] Task 5: Unit Tests, Hermetic Integration Verification & Docs. Write tests in `tests/checker.test.ts` and `tests/extension.test.ts` covering all 4 aspects; verify `tsc --noEmit` and `npm test`.
- [x] Task 6: Red Team Hardening & Blindajes. Mitigate prefix boundary spoofing in `checkPathViolation`, expand infinitive bypass regexes, filter preposition false-positives (`por`/`como por ejemplo`), prevent login token auth suppression in asks, and contextualize `echo`/`mux` detection. Verified with 5 dedicated red-team regression tests.
- [x] Task 7: Blind Audit Structural Remediation (JD-A-001 to JD-A-011).
  - JD-A-001: Return `{ action: 'transform', text: event.text }` in `pi.on('input')` when prompt is modified.
  - JD-A-002: Enforce agent governance rules (`tools:write`, `tools:edit`, `tools:all`) in `pi.on('tool_call')`.
  - JD-A-003: Bidirectional surface matching in `formatPlaybookForTool` / `formatAgentPreferencesForTool`.
  - JD-A-004: Preserve semantic `triggeredAskId` in `evaluatePromptSemantically` via `evaluatePromptFull`.
  - JD-A-005: Expand `checkPathViolation` beyond hardcoded HTTP keywords to cover all domain/service source files.
  - JD-A-006: Support comma-separated surfaces in `checkPathViolation`.
  - JD-A-007: Exclude recommended "usar/salvo" tokens inside parentheses from never rules.
  - JD-A-008: Escape regex characters in `idSubject` and target words.
  - JD-A-010: Display `neverRules` for Agent Preferences in `formatPlaybookForDisplay`.
  - JD-A-011: Guard against accidental full playbook deletion when `--rule` is passed without rule ID in `/playbook delete`.
- [x] Task 8: Blind Audit Structural Remediation Round B (JD-B-001 to JD-B-006).
  - JD-B-001: Dynamic multi-layer surface affinity in `checkPathViolation` to prevent cross-layer write deadlock.
  - JD-B-002: Comprehensive agent supervision in `tool_call` covering `neverRules`, `askRules`, and `invariants`.
  - JD-B-003: Strongly-typed `ViolationKind` on `ViolationMatch` and LLM JSON output to eliminate substring matching.
  - JD-B-004: Strict Fail-Closed policy on unexpected exceptions in `tool_call`.
  - JD-B-005: Idempotent round-trip serialization and parsing of `NeverRule.reason` in markdown storage.
  - JD-B-006: Generalized intent-based `bypassPattern` covering Spanish/English phrasing.
