---
description: Inspeccionar los playbooks arquitectónicos activos en el workspace (jerarquía, capas y reglas)
---

# Inspección de Playbooks

Mostrá al usuario el estado arquitectónico activo de este workspace usando la herramienta `playbook_consult`.

## Pasos

1. Llamá `playbook_consult` sin argumentos para obtener la jerarquía completa del workspace (Local > Stack > Global > Agentes).
2. Presentale al usuario un resumen claro:
   - Qué capas están activas (playbook local `playbook.md`, stacks detectados, lenguajes globales, preferencias de agentes).
   - Cuántas reglas tiene cada capa (invariantes, asks, prohibiciones/never).
3. Preguntale si quiere ver alguna capa en detalle:
   - Para una capa específica: `playbook_consult` con `language` (ej: `go`, `typescript`, `agents`, un slug de stack, o `local`).
   - Para una superficie puntual: agregá el filtro `surface` (ej: `internal/ports`, `tools:write`).
4. Mostrá el resultado formateado, sin resumir las reglas: el usuario necesita los textos completos.

## Reglas del flujo

- Esta operación es de **solo lectura**: nunca escribas ni modifiques playbooks acá (para eso existen `/playbook-add`, `/playbook-delete` y `playbook_manage`).
- Si no hay playbooks activos, decíselo al usuario y explicale cómo crear el primero con `/playbook-add`.
