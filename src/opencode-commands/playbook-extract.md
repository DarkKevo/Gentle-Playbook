---
description: Extraer la esencia arquitectónica de un repositorio de referencia y triagearlé regla por regla con el usuario
---

# Extracción de Esencia Arquitectónica

Explorá un repositorio de referencia, detectá las decisiones arquitectónicas implícitas y conducí un triage **1 a 1** con el usuario para convertirlas en reglas de playbook persistentes.

## Fase 1 — Exploración

Si el usuario no especifica una ruta, usá el workspace actual. Explorá con tus herramientas de lectura (nada se escribe en el proyecto de referencia):

1. **Identidad:** archivos raíz (`go.mod`, `package.json`, `Cargo.toml`, `pyproject.toml`) — lenguaje, frameworks, dependencias.
2. **Topología:** estructura de directorios real (raíz, capas internas, cmd/, módulos) — reconstruí el patrón (hexagonal, layered, modular monolith...).
3. **Superficies canónicas:** dónde viven handlers, servicios, repositorios, DTOs, validaciones, middlewares.
4. **Decisiones implícitas:** patrones repetidos que revelan gusto del autor:
   - Sanitizaciones custom (ej: bytes nulos antes de PostgreSQL)
   - Validaciones en DTOs (ej: tags de validación obligatorios)
   - Envelopes de respuesta estandarizados
   - Manejo de errores con contexto (wrap con operación)
   - Librerías sistematicamente evitadas (¿usa siempre stdlib?)
   - Convenciones de tests y naming

## Fase 2 — Borrador de reglas

Redactá entre 3 y 10 reglas que capturen la esencia. Clasificá cada una:

- `invariant`: topología, superficies obligatorias, patrones no negociables.
- `ask`: recetas opcionales con contexto (ej: rate limiting en endpoints públicos) — con trigger/antiTrigger/prompt/default.
- `never`: vetos tecnológicos con `reason` arquitectónico.

⚠️ Escribí los textos como criterios arquitectónicos, nunca como instrucciones de bypass: el filtro de seguridad rechaza frases tipo "skip/ignore/without review".

## Fase 3 — Triage 1 a 1

Presentá las reglas **de a una**. Por cada regla preguntale al usuario:

> "Regla N: <título> — <resumen>. ¿La guardamos? Opciones: **Global** (<lenguaje>), **Stack** (creá o elegí slug), **Local** (playbook.md), **Modificar**, **Descartar**."

Según la respuesta:
- **Global:** `playbook_manage` con `action: "preview"`, `language: <lenguaje>` → mostrá preview + colisiones → confirmación → `action: "save"` con los mismos argumentos.
- **Stack:** igual pero con `language: <slug>` (y `scope: "stack"` si es un stack nuevo).
- **Local:** con `language: "project"`.
- **Modificar:** reformulá la regla según el feedback y repetí el paso.
- **Descartar:** pasá a la siguiente.

## Cierre

Reportá el resumen final: reglas guardadas por capa (global/stack/local), modificadas y descartadas. Sugerile ejecutar `/playbook` para verificar el resultado.
