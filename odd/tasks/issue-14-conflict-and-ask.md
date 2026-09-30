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
