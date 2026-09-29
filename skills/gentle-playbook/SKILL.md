---
name: gentle-playbook
description: "Consult and apply opinionated language architecture playbooks and agent supervision preferences in ~/.config/gentle-playbook/languages/. Triggers: playbook, normas del lenguaje, extraer playbook, gentle-playbook, arquitectura go, hexagono go, invariants de codigo, essence de programacion, agent preferences, gobernanza de agente."
---

# Gentle Playbook: Essence & Architecture Enforcement

## Mental Model
Every developer has an architectural "essence" for each programming language (e.g. Hexagonal topology in Go, null-byte sanitization middleware, custom `notblank` DTO validation, universal response envelopes, and specific delegation of database constraints) as well as **operational supervision preferences** for AI agents (guardrails, permissions, write approval, command checkpoints).

`gentle-playbook` stores and enforces:
1. **Language Architecture Standards:** in `~/.config/gentle-playbook/languages/<lang>.md`.
2. **Agent Supervision Preferences:** in `~/.config/gentle-playbook/languages/agents-preferences.md`.

## Rule Hierarchy

### 1. Invariants (Normativa Global - Non-negotiable)
- **Execution:** Silently and unconditionally applied.
- **Language Invariants:** When generating files, endpoints, or structs in that language, adhere strictly to these invariants without prompting the user.
  - Examples in Go:
    - Rejecting `\x00` and `%00` via input sanitization middleware.
    - Applying `validate:"notblank"` to DTO string fields.
    - Wrapping responses in standard envelopes (`Data`, `Error`, `Success`).
- **Agent Governance Invariants:** Mandatory limits and restrictions on agent behavior and tools (e.g., forbidding `write` or `edit` without presenting approach and getting user approval first).

### 2. Ask Catalog (Conditional Patterns & Checkpoints)
- **Execution:** Evaluated ONLY at boundary surfaces when their explicit **Trigger** fires and their **Anti-Trigger** does NOT match.
- Never spam the user with speculative questions.
- If the trigger fires:
  - Formulate the single exact question specified in the rule.
  - If approved, apply the associated canonical recipe or execute the requested action.
  - If declined, fall back to the rule's documented `Default`.
- **Agent Governance Asks:** Operational checkpoints where the agent must stop and ask before proceeding (e.g., asking before executing destructive bash commands, or asking before altering production configs).

## Commands & Operations

### Inspecting Active Playbook
When working in a project with an active language (e.g. `go.mod`), inspect rules on-demand by calling the `playbook_consult` tool (or inspecting `~/.config/gentle-playbook/languages/<language>.md`). Consult topology, invariants, and agent rules before planning or creating files.
If `agents-preferences.md` exists, its rules supervise and delimit agent tool execution across all projects.

Model Tool:
- `playbook_consult`: Call with optional `language` (e.g. `'go'`, `'agents'`) or `surface` (e.g. `'internal/ports'`, `'tools:write'`, `'git:push'`) to retrieve rules on-demand without system prompt bloat.

Interactive commands in Pi:
- `/playbook` or `/gentle-playbook`: Interactive selector and detailed inventory of active playbooks.
- `/playbook show <lang|agents> [--full]`: Displays the playbook's rules, triggers, and prohibitions in chat.

### Adding Rules Interactively
Run:
```
/playbook add [lang|agents]
```
Or `/gentle-playbook-add [lang|agents]`.

- If no argument is provided, an interactive prompt will ask:
  - 🤖 **Preferencias de Agente** (Supervisión y Gobernanza de IA)
  - 💻 **Regla de Arquitectura de Lenguaje** (Go, TypeScript, Python, etc.)
- Next, prompts for the natural language description (e.g., *"no usar librerías externas para http"* o *"no hacer write sin aprobacion"*).
- Pre-checks against hostile prompt injection or meta-instruction patterns.
- Lets the user select rule type:
  - `[NORMATIVA]` (invariante dura).
  - `[ASK]` (checkpoint condicional).
  - `[PROHIBICIÓN / NEVER]` (restricción terminante de no hacer).
- If it is a Never rule, prompts for scope:
  - 🎯 **Específica**: solo este elemento/librería.
  - 🌐 **Categórica / Familia**: este elemento y cualquier alternativa similar de terceros.
  - ✍️ **Personalizada**: alcance a medida con sanitización.
- Uses the model to synthesize the rule structure.
- Shows a confirmation preview and saves it to the playbook.

### Semantic Pre-flight & Write Enforcement
- **Prompt Pre-flight:** The agent semantically evaluates whether incoming user prompts violate active rules or attempt to bypass checkpoints (`"no preguntes"`), displaying interactive confirmation dialogs in TUI before proceeding.
- **Write Barrier:** Tool execution (`write`/`edit`) enforces canonical topology and intercepts unauthorized paths or path traversal (`../../`) before disk mutation.

### Managing & Deleting Rules Interactively
Run:
```
/playbook delete [lang|agents] [--rule <id>]
```
- Interactive guided menus (`ui.select` and `ui.confirm`) to surgically delete a specific rule or safely erase an entire language playbook with dual confirmation.

### Extracting a New Playbook from a Reference Repo
Run the extraction command in Pi:
```bash
/playbook extract [path-to-repo] [--lang <lang>]
```
This runs the Essence Explorer Agent backed by CodeGraph (or native file exploration fallback) to analyze topology, count empirical evidence (file:line), detect invariants, ask checkpoints and prohibitions, and perform AI-driven semantic diffing with 1-to-1 interactive conflict arbitration in the TUI before writing to disk.
