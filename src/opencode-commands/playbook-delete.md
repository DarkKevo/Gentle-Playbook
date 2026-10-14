---
description: Eliminar una regla específica o un playbook completo de forma guiada y con confirmación explícita
---

# Eliminación Guiada de Reglas y Playbooks

Conducí con el usuario una eliminación quirúrgica: primero mostrar, después confirmar, recién entonces borrar. Nada se elimina sin confirmación explícita.

## Flujo

1. **Destino:** Preguntale al usuario de qué capa eliminar:
   - 🌐 lenguaje global (ej: `go`, `typescript`)
   - 📦 stack (slug, ej: `go-gin`)
   - 🤖 `agents` — preferencias de agente
   - 🏠 `project` — el `playbook.md` local

2. **Mostrar contenido:** Usá `playbook_consult` con el `language` correspondiente y presentale la lista completa de reglas con sus IDs:
   - `[INVARIANT] <id> — título`
   - `[ASK] <id> — título`
   - `[NEVER] <id> — descripción corta`
   - `[SNIPPET] <id> — título`

3. **Alcance:** Preguntale si quiere:
   - **Una regla específica** → que te diga el ID (o elija de la lista)
   - **El playbook completo** → advertile con el conteo exacto: *"Se eliminarán N invariantes, M asks y K prohibiciones de <capa>. ¿Confirmás?"*

4. **Ejecución:**
   - Regla específica: `playbook_manage` con `action: "delete"`, `language: <capa>`, `ruleId: <id>`.
   - Playbook completo: `playbook_manage` con `action: "delete"`, `language: <capa>`, `whole: true`.

5. **Reporte:** Confirmale qué se eliminó (ID + tipo, o playbook completo) y mostrale el estado restante de la capa con `playbook_consult`.

## Reglas del flujo

- **Nunca borres el playbook local (`project`) con `whole: true`**: `playbook.md` es un archivo del repositorio bajo control de versiones — si el usuario quiere eliminarlo, decíselo y que lo borre o edite directamente; así queda en el historial de git.
- Si la regla o el playbook no existen, `playbook_manage` lo reporta: retransmitilo sin intentos extra.
- La eliminación es inmediata y permanente (sin papelera): la confirmación del paso 3 es obligatoria, nunca la asumas de un mensaje previo.
