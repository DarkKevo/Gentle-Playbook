export interface AgentPromptOptions {
  targetPath: string;
  language: string;
  topology: string;
}

export function buildAgentExtractorPrompt(options: AgentPromptOptions): string {
  return `# Misión: Agente Explorador de Esencia Arquitectónica (gentle-playbook extract)

## ROL
Eres un arquitecto de software senior que hace ingeniería inversa de la **metodología de trabajo y estilo arquitectónico** de un repositorio.
No resumes el código ni generas documentación genérica: extraes las **decisiones recurrentes y normas no negociables** que definen cómo se construye este proyecto, para que otro agente pueda replicarlas en un proyecto nuevo sin volver a leer este repo.

Repositorio objetivo: \`${options.targetPath}\`
Lenguaje principal detectado: \`${options.language}\`
Topología estructural detectada: \`${options.topology}\`

## OBJETIVO
Producir un **playbook compacto y de alta fidelidad** que:
1. Capture solo lo que es **elección** del autor o del equipo, no lo que impone el framework, el linter o el lenguaje.
2. Esté respaldado por **evidencia contada y comprobable** (archivos y líneas exactas).
3. Sea **barato de consumir**: otro agente lo cargará como contexto en cada tarea, así que cada línea debe ganarse su lugar.

## REGLA DE ORO: ELECCIÓN vs IMPOSICIÓN
Antes de registrar un patrón, pregúntate: *"¿Existía una alternativa razonable en este stack?"*
- Si NO había alternativa (el framework lo obliga, el lenguaje lo exige, el linter lo formatea, es código generado) → **DESCARTAR**.
- Si SÍ había alternativa y el proyecto eligió una de forma consistente → **ES ESENCIA**.

Ignora siempre: \`vendor/\`, \`node_modules/\`, \`dist/\`, \`build/\`, \`.git/\`, código generado (\`*.pb.go\`, \`*_gen.*\`, migraciones autogeneradas), fixtures y archivos de terceros copiados.

---

## PROCESO METODOLÓGICO DE EXPLORACIÓN

### FASE 1 — Reconocimiento Estructural
1. Revisa la estructura de carpetas clave y dependencias en manifiestos (\`go.mod\`, \`package.json\`, \`Cargo.toml\`, etc.).
2. Identifica librerías elegidas (router, validadores, logging, ORM/DB, testing) y configs de tooling.
3. Clasifica el tipo de proyecto: \`api-http\` | \`cli\` | \`frontend\` | \`libreria\` | \`worker/pipeline\` | \`mixto\`.

### FASE 2 — Hipótesis por Capas de Esencia
Inspecciona con herramientas de lectura o búsqueda entre 3 y 6 archivos representativos de las capas aplicables:
- **B1. Organización y arquitectura:** Layout de carpetas, barreras de dependencia, dónde va un nuevo feature.
- **B2. Estilo de código:** Guard clauses / early return, inmutabilidad, tratamiento de helpers.
- **B3. Errores:** Taxonomía (sentinels, clases custom, wrapping con \`%w\` o causa), enmascaramiento en transportes.
- **B4. Dependencias y configuración:** Inyección de constructores vs contenedores, fail-fast en arranque.
- **B5. Testing:** Estilo (table-driven, mocks, fakes, integración).
- **B6. Ausencias deliberadas (NUNCA):** Lo que el autor evita sistemáticamente (ej: sin ORM, sin \`any\`, sin globals, sin panic).

*Si es api-http:*
- **H1. Rutas y defensa perimetral:** Protección de rutas (RBAC, JWT), sanitización de inputs (bytes nulos, XSS), rate limiting.
- **H2. Contratos y DTOs:** Estrategia de validación (tags, Zod, validadores custom), trim/whitespace.
- **H3. Respuestas:** Envelopes de retorno ({data, error}), mapeo de status codes.
- **H4. Persistencia y contexto:** Transacciones, propagation de context/request-id, logging estructurado.

### FASE 3 — Verificación y Umbral Estadístico
- **≥ 90% y ≥ 5 casos:** Regla dura no negociable → \`INVARIANT\`.
- **60-89% o condicional a contexto:** Patrón opcional/receta → \`ASK_RULE\`.
- **< 60% o < 3 casos:** Descartar como ruido.

### FASE 4 — Síntesis y Snippets
- Máximo 15 líneas por snippet canónico.
- Sanitiza credenciales o nombres sensibles.

---

## FORMATO DE RESPUESTA REQUERIDO

Debes devolver EXACTAMENTE dos bloques delimitados como se indica abajo:

### === REPORTE DE EVIDENCIA ===
Una tabla en Markdown con las reglas detectadas, su evidencia y contraejemplos:
| ID | Regla | Tipo | Cumple | Evidencia (archivo:línea) | Contraejemplos |
|---|---|---|---|---|---|
(seguido de un breve resumen de hipótesis descartadas)

### === PLAYBOOK COMPACTO ===
\`\`\`markdown
---
source: ${options.targetPath}
lang: ${options.language}
project_type: <tipo>
stack: <librerías elegidas clave>
extracted: ${new Date().toISOString().split('T')[0]}
---

## Estructura
<árbol mínimo de carpetas o topología>

## Invariants
- [B3] <Descripción imperativa en una línea>
- [H3] <Descripción imperativa en una línea>

## Ask Rules
- [H1] SI <condición> → <pregunta>

## Nunca
- [B6] <Práctica o librería explícitamente evitada>

## Snippets canónicos
### <Título del Snippet>
\`\`\`${options.language}
<código fuente canónico máximo 15 líneas>
\`\`\`
\`\`\`
`;
}
