# Feature: Multistack Governance, Stacks and Local Project Playbook

Status: In Progress
Owner: el Gentleman
Branch: feat/multistack-governance

## Summary
Implement hierarchical multi-layer governance for Gentle-Playbook:
1. Stacks storage (`~/.config/gentle-playbook/stacks/<slug>.md`) with structural subtyping flag detection (`required_flags.every`).
2. Local Project Playbook (`./playbook.md`) as the supreme arbiter at the repository root.
3. `/playbook stack` commands (`list`, `create`, `delete`) with LLM-assisted synthesis.
4. `/playbook add` support for 4 destinations (Agent, Local Project, Stack, Global Language) with collision alerts.
5. `/playbook extract` 1-on-1 Interactive Triage Wizard (Global, Stack, Local, Modify with prompt loop, Discard).
6. Multi-stack collision resolution: prompt user with full conflicting rule bodies and persist choice to local `playbook.md`.
7. Comprehensive test coverage for all edge cases and user inputs.

## Tasks
- [ ] Task 1: Extend Schemas and Storage (`src/core/schema.ts`, `src/core/storage.ts`) for Stacks and Local `playbook.md`
- [ ] Task 2: Implement Stack Detection & Synthesis Engine (`src/core/stack-detector.ts`, `src/core/stack-synthesizer.ts`)
- [ ] Task 3: Implement `/playbook stack` CLI and integrate 4-scope dispatch in `/playbook add`
- [ ] Task 4: Implement 1-on-1 Interactive Triage Wizard in `/playbook extract` with LLM refinement loop
- [ ] Task 5: Integrate Hierarchy and Runtime Conflict Resolution into `playbook_consult`, `session_start` and input pre-flight
- [ ] Task 6: Unit and Integration Test Suite covering edge cases, multi-stack overlap, and user flows
