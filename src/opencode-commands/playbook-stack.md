---
description: Gestionar stacks tecnológicos: listar, crear con reglas sintetizadas o eliminar un stack
---

# Gestión de Stacks Tecnológicos

Un stack captura las reglas de una combinación concreta de tecnologías (ej: Go+Gin+PostgreSQL, NestJS+TypeORM). Se activa automáticamente cuando su workspace declara los flags requeridos, y varias stacks pueden convivir en repos polyglot.

## Listar stacks existentes

1. Listá los stacks guardados: leé el directorio `~/.config/gentle-playbook/stacks/` con tus herramientas de archivos.
2. Para cada stack mostrá: slug, flags requeridos (`requiredFlags`) y cantidad de reglas por tipo.
3. Si el usuario quiere ver las reglas de un stack: `playbook_consult` con `language` = el slug del stack.

## Crear un stack nuevo (agente-mediado)

1. Preguntale al usuario qué combinación de tecnologías define el stack (ej: *"go con gin y postgres"*).
2. Derivá el **slug** kebab-case (ej: `go-gin-postgres`) y confirmalo con el usuario.
3. Preguntale si quiere partir de reglas base sintetizadas: si acepta, redactá 2-5 reglas semilla con el mismo criterio de `/playbook-extract` (topología típica de esa combinación, obligaciones del framework, vetos con motivo). Si prefiere arrancar vacío, continuá igual — el stack se crea con la primera regla.
4. Por cada regla a guardar: `playbook_manage` con `action: "preview"`, `scope: "stack"`, `language: <slug>` y la regla → mostrá el preview (colisiones incluidas) → confirmación del usuario → `action: "save"` con los mismos argumentos.
5. Al finalizar, mostrale el resumen: slug, flags y reglas guardadas.

## Eliminar un stack

1. Mostrale la lista de stacks y pedile cuál eliminar.
2. **Confirmación explícita** mostrando el conteo de reglas que se perderán: *"¿Eliminamos el stack X con sus N reglas de forma permanente?"*
3. Si confirma: `playbook_manage` con `action: "delete"`, `scope: "stack"`, `language: <slug>`, `whole: true`.
4. Reportale el resultado.

## Notas

- Las reglas de stack se activan por `requiredFlags` (subtyping estructural: la stack activa si TODOS sus flags matchean el workspace). Si el usuario menciona activación, verificá que los flags describan archivos/dependencias presentes (ej: `go.mod`, `package.json` con `gin`).
- La soberanía es: Local > Stack > Global. Guardar en stack nunca pisa reglas locales.
