---
name: gentle-playbook
description: "Consult and apply opinionated language architecture playbooks, technology stacks, and local project playbooks in Pi. Triggers: playbook, normas del lenguaje, extraer playbook, gentle-playbook, stack playbook, arquitectura go, hexagono go, invariants de codigo, essence de programacion, agent preferences, gobernanza de agente."
---

# Gentle Playbook: Essence & Architecture Enforcement

## Mental Model
Every developer has an architectural "essence" for each programming language (e.g. Hexagonal topology in Go, null-byte sanitization middleware, custom `notblank` DTO validation, universal response envelopes) as well as framework combinations (Stacks) and repository-specific standards.

`gentle-playbook` stores and enforces rules across **4 hierarchical layers of authority**:
1. **Local Project Playbook:** in `./playbook.md` (root of the workspace repository - supreme local authority).
2. **Technology Stack Playbooks:** in `~/.config/gentle-playbook/stacks/<slug>.md` (Go+Gin, NestJS+TypeORM, etc.).
3. **Language Architecture Standards:** in `~/.config/gentle-playbook/languages/<lang>.md` (Go, TypeScript, Python, etc.).
4. **Agent Supervision Preferences:** in `~/.config/gentle-playbook/languages/agents-preferences.md`.

> **Local Sovereignty:** Rules defined in `./playbook.md` have supreme authority. Any local rule governing a surface automatically masks subordinate stack and global rules for that surface during pre-flight (`input`) and tool execution (`tool_call`).

## Rule Hierarchy

### 1. Invariants (Normativa Global - Non-negotiable)
- **Execution:** Direct and silent when compliant. If a user prompt or tool call conflicts with an invariant, the governance layer intercepts it (presenting interactive confirmation/redirection in TUI, or visible canonical redirection/blocking in headless mode).
- **Language Invariants:** When generating files, endpoints, or structs in that language, adhere strictly to these invariants without prompting the user unless a conflict occurs.
  - Examples in Go:
    - Rejecting `\x00` and `%00` via input sanitization middleware.
    - Applying `validate:"notblank"` to DTO string fields.
    - Wrapping responses in standard envelopes (`Data`, `Error`, `Success`).
- **Agent Governance Invariants:** Mandatory limits and restrictions on agent behavior and tools (e.g., requiring user approval before `write` or `edit`).

### 2. Ask Catalog (Conditional Patterns & Checkpoints)
- **Execution:** Evaluated on incoming prompts when their explicit content **Trigger** fires and their **Anti-Trigger** does NOT match.
- Never spam the user with speculative questions.
- If the trigger fires:
  - Formulate the single exact question specified in the rule.
  - If approved, appends a directive instructing the model to include the approved extra alongside the base feature.
  - If declined, appends a directive instructing the model to fall back to the rule's documented `Default Action` while still delivering the base feature.
- **Agent Governance Asks:** Operational checkpoints where the agent must stop and ask before proceeding (e.g., asking before executing destructive bash commands, or asking before altering production configs).

### 3. Never Rules (Prohibiciones Terminantes)
- Categorical or specific bans on libraries, ORMs, and external frameworks (e.g., forbidding Gin, Express, Flask, GORM, or lodash).
- When a rule mandates standard library (`stdlib`), alternative and cross-ecosystem third-party frameworks are categorically flagged.

## Commands & Operations

### Inspecting Active Playbook
When working in a project with active technologies, inspect rules on-demand by calling the `playbook_consult` tool (or inspecting active files in `playbook.md` / `stacks/` / `languages/`). Consult topology, invariants, and agent rules before planning or creating files.

Model Tool:
- `playbook_consult`: Call with optional `language` (e.g. `'local'`, `'go'`, `'go-gin'`, `'agents'`) or `surface` (e.g. `'internal/ports'`, `'tools:write'`, `'git:push'`) to retrieve rules on-demand across all 4 layers without system prompt bloat.

Interactive commands in Pi:
- `/playbook` or `/gentle-playbook`: Interactive selector and detailed inventory of active playbooks.
- `/playbook show <lang|agents|stack>`: Displays the playbook's rules, triggers, and prohibitions in chat.

### Managing Stacks: `/playbook stack`
- `/playbook stack list`: Lists all installed stacks, their required flags, and rule counts.
- `/playbook stack <prompt>` (or `create`): Synthesizes a new stack from natural language (e.g., `/playbook stack "nest con typeorm y postgres"`).
- `/playbook stack delete <slug>`: Deletes a stack.
- **Structural Subtyping (*Duck Typing*):** A stack activates if and only if all its required flags match the workspace (`requiredFlags.every`). Multiple stacks can activate concurrently in polyglot repos.
- **Collision Resolution:** If two active stacks conflict on the same surface, the user resolves it interactively and the winning rule is persisted to `./playbook.md` as permanent local authority.

### Adding Rules Interactively
Run:
```
/playbook add [target]
```
Or `/gentle-playbook-add [target]`.

- Select from **4 destinations**:
  - 🤖 **Preferencias de Agente** (Supervisión y Gobernanza de IA)
  - 🏠 **Proyecto Local** (`playbook.md` en la raíz de este repositorio)
  - 📦 **Stack Tecnológico** (combinación de tecnologías/frameworks)
  - 🌐 **Lenguaje Global** (Go, TypeScript, etc.)
- Prompts for description, performs prompt injection pre-check, and allows selecting rule type (`INVARIANT`, `ASK`, `NEVER`).
- Live collision check against active layers with options to override, keep existing, or reformulate.
- Shows a confirmation preview and saves it to the chosen layer.

### Deterministic Pre-flight & Write Enforcement
- **Prompt Pre-flight (`input` hook):** Evaluates incoming prompts in-memory (<1ms) against all active layers in order (`Local > Stack > Global > Agent`), with local surface masking.
- **Write Barrier (`tool_call` hook):** Enforces canonical topology and intercept unauthorized paths or prefix spoofing (`../../`). Applies a strict **Fail-Closed** security policy.

### Managing & Deleting Rules Interactively
Run:
```
/playbook delete [lang|agents|stack] [--rule <id>]
```
- Interactive guided menus (`ui.select` and `ui.confirm`) to surgically delete a specific rule or safely erase an entire playbook.

### Extracting a New Playbook from a Reference Repo: Triage 1 a 1
Run:
```bash
/playbook extract [path-to-repo] [--lang <lang>]
```
Runs the Essence Explorer Agent backed by CodeGraph. Instead of a bulk dump, it guides the user through an **Interactive 1-on-1 Triage Wizard**:
- 🌐 **1. Global:** Save to global language playbook.
- 📦 **2. Stack:** Save to an existing or newly created stack.
- 🏠 **3. Proyecto Local:** Save strictly to `./playbook.md`.
- ✏️ **4. Modificar regla:** Refine the rule with AI prompt loop before classification.
- 🗑️ **5. Descartar regla:** Discard the rule and proceed.
