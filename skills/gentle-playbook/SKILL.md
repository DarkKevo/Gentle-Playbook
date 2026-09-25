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
When working in a project with an active language (e.g. `go.mod`), inspect `~/.config/gentle-playbook/languages/<language>.md`. Read the topology and invariants before planning or creating files.
If `agents-preferences.md` exists, its rules supervise and delimit agent tool execution across all projects.

### Adding Rules Interactively
Run:
```
/gentle-playbook-add [lang|agents]
```
Or `/gentle-playbook add [lang|agents]`.

- If no argument is provided, an interactive prompt will ask:
  - 🤖 **Preferencias de Agente** (Supervisión y Gobernanza de IA)
  - 💻 **Regla de Arquitectura de Lenguaje** (Go, TypeScript, Python, etc.)
- Next, prompts for the natural language description (e.g., *"no se hace write si no yo lo apruebo, primero el approach del cambio y luego mi aprobación"*).
- Lets the user select whether it is `[NORMATIVA]` (invariant) or `[ASK]` (checkpoint).
- Uses the model to synthesize the rule structure (action/surface, trigger, anti-trigger, prompt).
- Shows a confirmation preview and saves it to the playbook.

### Extracting a New Playbook from a Reference Repo
Run the extraction command:
```bash
gentle-playbook extract <path-to-repo> [--lang <lang>]
```
This runs CodeGraph to analyze topology, detect invariants, extract canonical snippets, and compute a semantic diff against any existing playbook for that language.
