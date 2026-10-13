---
description: Agregar una regla arquitectónica interactivamente (invariante, ask o prohibición) con preview y confirmación
---

# Agregar Regla de Playbook

Conducí un wizard conversacional con el usuario para capturar y guardar una regla de gobernanza. El usuario describe en lenguaje natural; vos la estructurás, mostrás el preview y persistís con `playbook_manage`.

## Flujo

1. **Destino:** Preguntale al usuario dónde guardar la regla:
   - 🤖 `agents` — Preferencias de agente (gobernanza operativa, superficies `tools:*`)
   - 🏠 `project` — Playbook local `playbook.md` de este repositorio (máxima autoridad)
   - 📦 stack — Un stack tecnológico existente o nuevo (pasale el slug, ej: `go-gin`)
   - 🌐 lenguaje global (ej: `go`, `typescript`, `python`)

2. **Descripción:** Pedile la regla en lenguaje natural (ej: *"no quiero librerías externas para http, prefiero standard library"*).

3. **Tipo de regla:** Confirmá con el usuario:
   - `invariant` (Normativa): invariante no negociable de estructura o comportamiento.
   - `ask` (Patrón condicional): receta opcional que requiere `trigger` (qué lo activa), `antiTrigger` (cuándo NO preguntar), `prompt` (la pregunta canónica) y `defaultAction` (acción por defecto si declina).
   - `never` (Prohibición): veto terminante. Para prohibiciones, consultá el alcance: **específica** (solo el elemento nombrado), **categórica** (el elemento y cualquier alternativa similar, exigiendo stdlib) o **personalizada** (el usuario detalla límites/ excepciones).

4. **Síntesis:** Estructurá la regla con estos campos:
   - `type`: siempre uno de `"invariant" | "ask" | "never"` (obligatorio; el schema lo rechaza si falta)
   - `id`: kebab-case corto y estable (ej: `http-handlers-ports`)
   - `title`: título descriptivo
   - `type`: el tipo confirmado en el paso 3 (`invariant`, `ask` o `never`) — el schema lo exige
   - `surface`: superficie canónica donde aplica (ej: `internal/adapters/http/`, `tools:write`, `general` para vetos tecnológicos)
   - `description`: la regla completa y autocontenida
   - Para `never`: `reason` (el motivo arquitectónico)
   - Para `ask`: `trigger`, `antiTrigger`, `prompt`, `defaultAction`
   - ⚠️ El texto NO debe parecer una instrucción de bypass (ej: evitá frases como "without review" o "skip the check"): el filtro de seguridad las rechaza.

5. **Preview:** Llamá `playbook_manage` con `action: "preview"`, el `language`/`scope` elegido y la regla. Mostrale al usuario el preview completo incluyendo:
   - Las colisiones detectadas contra otras capas activas (si las hay)
   - Si el contenido fue rechazado por el filtro de seguridad, corregí el campo ofensivo y volvé a previsualizar.

6. **Confirmación:** Preguntale explícitamente: *"¿Guardamos esta regla en <capa>?"*.

7. **Persistencia:** Si confirma, llamá `playbook_manage` con `action: "save"` usando **exactamente los mismos argumentos** del preview aprobado. Reportale el resultado con la versión del playbook.

8. Para stacks nuevos, usá `scope: "stack"` con el slug elegido por el usuario.

## Garantías

- Nunca persistas sin preview aprobado y confirmación explícita del usuario.
- Si el preview reporta `CONTENIDO INVALIDO`, la regla NO se guarda: corregila primero.
- El feature que el usuario pidió nunca queda en inanición: la regla se guarda sin bloquear la conversación.
