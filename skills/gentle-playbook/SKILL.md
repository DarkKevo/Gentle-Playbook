---
name: gentle-playbook
description: Consult and apply opinionated language architecture playbooks (~/.config/gentle-playbook/languages/). Triggers: playbook, normas del lenguaje, extraer playbook, gentle-playbook, arquitectura go, hexagono go, invariants de codigo, essence de programacion.
---

# Gentle Playbook: Essence & Architecture Enforcement

## Mental Model
Every developer has an architectural "essence" for each programming language (e.g. Hexagonal topology in Go, null-byte sanitization middleware, custom `notblank` DTO validation, universal response envelopes, and specific delegation of database constraints).

`gentle-playbook` stores and enforces these standards from `~/.config/gentle-playbook/languages/<lang>.md`.

## Rule Hierarchy

### 1. Invariants (Normativa Global - Non-negotiable)
- **Execution:** Silently and unconditionally applied.
- When generating files, endpoints, or structs in that language, adhere strictly to these invariants without prompting the user.
- Examples in Go:
  - Rejecting `\x00` and `%00` via input sanitization middleware.
  - Applying `validate:"notblank"` to DTO string fields.
  - Wrapping responses in standard envelopes (`Data`, `Error`, `Success`).

### 2. Ask Catalog (Conditional Patterns & Recipes)
- **Execution:** Evaluated ONLY at boundary surfaces when their explicit **Trigger** fires and their **Anti-Trigger** does NOT match.
- Never spam the user with speculative questions.
- If the trigger fires:
  - Formulate the single exact question specified in the rule.
  - If approved, apply the associated canonical recipe snippet without improvising third-party libraries.
  - If declined, fall back to the rule's documented `Default`.

## Commands & Operations

### Inspecting Active Playbook
When working in a project with an active language (e.g. `go.mod`), inspect `~/.config/gentle-playbook/languages/<language>.md`. Read the topology and invariants before planning or creating files.

### Extracting a New Playbook from a Reference Repo
Run the extraction command:
```bash
gentle-playbook extract <path-to-repo> [--lang <lang>]
```
This runs CodeGraph to analyze topology, detect invariants, extract canonical snippets, and compute a semantic diff against any existing playbook for that language.
