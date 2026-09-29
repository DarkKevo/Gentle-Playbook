# 📘 Gentle-Playbook

> **Architectural Essence & Opinionated Language Playbook Manager for Pi & el Gentleman**

`gentle-playbook` es una extensión nativa para **Pi (TUI-First)** diseñada para capturar, almacenar, hacer cumplir y evolucionar las normas de arquitectura de software personalizadas por lenguaje de programación. Toda la interacción, extracción agéntica y gestión se realiza interactivamente dentro de Pi.

---

## 🎯 El Problema que Resuelve

Cuando desarrollás software con agentes de IA, cada nuevo repositorio o proyecto suele sufrir de tres problemas recurrentes:

1. **Amnesia Arquitectónica & Quema de Tokens:** El agente no sabe cómo estructurás tus proyectos en cada lenguaje (por ejemplo, Arquitectura Hexagonal en Go, middleware de bytes nulos para PostgreSQL, validaciones custom en DTOs o envelopes universales de respuesta). Tenés que explicarle todo desde cero en cada sesión, quemando miles de tokens de contexto.
2. **Fatiga de Contexto & Consulta entre Repositorios:** Tenés que abrir repositorios antiguos para copiar cómo habías implementado cierta validación o estructura para que el agente la replique.
3. **Improvisación de Librerías y "AI-Slop":** Ante la falta de directivas claras, los modelos suelen improvisar librerías externas innecesarias o sugerir preguntas irrelevantes en cada archivo (ej: meter Redis o Rate Limiting en scripts que no lo necesitan).

---

## 🏛️ Modelo Mental & Taxonomía de Reglas

`gentle-playbook` divide las preferencias arquitectónicas en dos categorías estrictas:

```
                    ┌─────────────────────────┐
                    │     GENTLE PLAYBOOK     │
                    └────────────┬────────────┘
                                 │
         ┌───────────────────────┴───────────────────────┐
         ▼                                               ▼
┌─────────────────────────┐             ┌─────────────────────────┐
│       INVARIANTS        │             │       ASK CATALOG       │
│   (Normativas Duras)    │             │ (Patrones Condicionales)│
├─────────────────────────┤             ├─────────────────────────┤
│ • No negociables        │             │ • Opcionales/Recetas    │
│ • Aplicadas en silencio │             │ • Requieren Trigger     │
│ • Cero preguntas        │             │ • Poseen Anti-Trigger   │
│ • Ej: Bytes nulos, DTOs │             │ • Ej: Cache, Rate-Limit │
└─────────────────────────┘             └─────────────────────────┘
```

### 1. Invariants (Normativa Global - No negociable)
* Se aplican **incondicionalmente y en silencio**.
* El agente jamás te pregunta si querés usarlas; las implementa por defecto al crear código en ese lenguaje.
* *Ejemplo en Go:* Todo endpoint HTTP entrante pasa por el middleware de sanitización de bytes nulos (`\x00` y `%00`) para proteger PostgreSQL (SQLSTATE 22021). Todo DTO string obligatorio lleva el tag `validate:"notblank"`.

### 2. Ask Catalog (Patrones Condicionales & Recetas)
* Son bloques de arquitectura opcionales pero estandarizados.
* **Coordenadas Deterministas de Activación:**
  * **Surface:** Capa o directorio donde aplica (ej: `internal/adapters/handlers/`).
  * **Trigger:** Condición técnica exacta que activa la consulta (ej: creación de endpoints públicos sin auth como `/login` o `/register`).
  * **Anti-Trigger:** Condición de veto donde está **terminantemente prohibido preguntar** (ej: rutas privadas con JWT, tareas batch o gRPC interno).
  * **Pregunta Canónica:** La formulación exacta para el usuario.
  * **Receta:** Si el usuario acepta, el agente utiliza el snippet canónico registrado sin inventar librerías de terceros.

---

## 🚀 Instalación

### Método 1: One-Liner con `curl` (Recomendado)

Ejecutá este comando en cualquier terminal para instalar todo automáticamente sin necesidad de clonar manualmente:

```bash
curl -fsSL https://raw.githubusercontent.com/DarkKevo/Gentle-Playbook/master/install.sh | bash
```

El script se encarga de:
- Descargar la última versión en `~/.local/share/gentle-playbook`.
- Instalar dependencias npm y compilar TypeScript.
- Registrar el paquete nativo en Pi (`pi install`).
- Crear el directorio de almacenamiento `~/.config/gentle-playbook/languages/`.

---

### Método 2: Instalación Directa desde Pi

Si ya tenés Pi abierto o preferís instalarlo vía su gestor de paquetes:

```bash
pi install git:github.com/DarkKevo/Gentle-Playbook
```

---

### Método 3: Instalación Local (Desarrollo)

Si preferís clonar el código para modificarlo:

```bash
git clone https://github.com/DarkKevo/Gentle-Playbook.git ~/Proyectos/Gentle-playbook
cd ~/Proyectos/Gentle-playbook
./install.sh
```

---

## 🛠️ Modos de Uso

### 1. Detección Automática & Directiva On-Demand en Runtime (Zero-Friction & Zero-Bloat)
A partir de la versión v0.6.0, `gentle-playbook` desacopla el almacenamiento del system prompt mediante un modelo **On-Demand asistido por Tool**:

1. **Notificación de inicio (`session_start`):** Inspecciona los archivos raíz (`go.mod` ➔ Go, `package.json` ➔ TypeScript, `Cargo.toml` ➔ Rust). Si existe un playbook guardado para ese lenguaje o preferencias de agente, te notifica que están disponibles.
2. **Puntero Liviano en System Prompt (`before_agent_start`):** En lugar de volcar miles de tokens de markdown en cada turno, Pi inyecta una directiva ligera en `systemPromptOptions.sections.playbook_guidance` (~30 tokens) que orienta al modelo a consultar obligatoriamente la herramienta `playbook_consult` antes de generar, estructurar o modificar código.
3. **Herramienta Nativa `playbook_consult`:** El modelo invoca la tool bajo demanda con filtrado por lenguaje (`go`, `typescript`, `agents`) o por superficie (`internal/ports`, `tools:write`, `git:push`), recuperando datos pasivos de referencia con total aislamiento de seguridad.

---

### 2. Gobernanza Semántica y Prevención de Violaciones (Issue #12)
Para garantizar que el modelo no desobedezca las reglas cuando el prompt contradice el reglamento o intenta usar tecnologías prohibidas:

1. **Pre-vuelo Semántico en `input`:**
   - Cuando el usuario ingresa un prompt, el Agente/LLM evalúa semánticamente el significado de la petición contra las reglas activas del playbook (`evaluatePromptSemantically`).
   - Si detecta que el usuario pide usar una tecnología prohibida (por nombre, sinónimo o familia), eludir un checkpoint (`"sin preguntar"`), o colocar código fuera de la topología exclusiva, salta un diálogo interactivo en el TUI:
     ```text
     ⚠️ Conflicto con Playbook
     Esta acción entra en conflicto con GO:
     Regla [NO-GIN]: No usar el framework Gin; usar net/http de la biblioteca estándar.
     Motivo: El prompt solicita usar una librería externa para la capa web.

     ¿Deseas continuar permitiendo esta excepción? (Sí / No)
     ```
   - Si el usuario elige **No**: la acción se cancela de inmediato, protegiendo las normas del proyecto.
   - Si elige **Sí**: se autoriza la excepción conscientemente para ese turno.

2. **Aprobación Semántica en Checkpoints de Código:**
   - Si el usuario solicita explícitamente una funcionalidad sujeta a un `AskRule` (ej: *"hacé el login y ponele rate limiter"*), el agente reconoce la **aprobación semántica anticipada** y procede a implementar la feature utilizando el snippet/receta canónica sin formular preguntas redundantes.
   - En **Gobernanza de Agente** (`agents-preferences`) o **Prohibiciones** (`NeverRules`), cualquier intento de elusión por texto (*"sin consultar"*, *"no preguntes"*) es interceptado obligatoriamente por el TUI.

3. **Cinturón de Seguridad en `tool_call`:**
   - Antes de ejecutar cualquier herramienta de escritura (`write` o `edit`), `checkPathViolation` valida que la ruta de destino no viole la superficie exclusiva de una regla invariante o superficie vetada.
   - Neutraliza automáticamente intentos de *Path Traversal* (`../../`) y desvíos por rutas absolutas mediante resolución canónica contra el workspace.

---

### 3. Comando Interactivo en Pi: `/playbook add` (o `/gentle-playbook-add`)
Agregá nuevas preferencias arquitectónicas, prohibiciones o de gobernanza mediante un flujo interactivo guiado:

1. **Pregunta 1 (Categoría):** Elegís entre:
   - 🤖 **Preferencias de Agente** (Supervisión y Gobernanza de IA)
   - 💻 **Regla de Arquitectura de Lenguaje** (Go, TypeScript, Python, Rust, etc.)
2. **Pregunta 2:** Escribís en lenguaje natural tu preferencia, norma o prohibición:
   > *"no quiero usar librerías externas para http, prefiero standard library"*
3. **Clasificación Automática o Manual:** Elegís si es:
   - 🛡️ **[NORMATIVA]**: Límite operativo o invariante no negociable.
   - 💡 **[ASK]**: Punto de control condicional o receta con pregunta previa.
   - 🚫 **[PROHIBICIÓN / NEVER]**: Restricción terminante de no hacer o veto tecnológico.
4. **Selector de Alcance en Prohibiciones:**
   Si la regla es prohibitiva, podés definir su cobertura para evitar que el LLM recurra a alternativas afines:
   - `🎯 1. Específica`: Solo este elemento puntual (ej: únicamente `Gin`).
   - `🌐 2. Categórica / Familia`: Veta la herramienta y cualquier alternativa similar (ej: `Gin` y cualquier otro router como `Chi`, `Echo`, `Fiber`, exigiendo `net/http`).
   - `✍️ 3. Personalizado`: Input interactivo para detallar excepciones o condiciones particulares con sanitización anti-inyección.
5. **Síntesis con LLM & Preview de Confirmación:**
   El modelo estructurará la regla y te mostrará una confirmación con `Yes / No` en la terminal antes de guardarla en el playbook.

---

### 4. 🤖 Agents Preferences: Gobernanza y Supervisión de Agente

Además de reglas arquitectónicas de código por lenguaje, `gentle-playbook` permite registrar **Preferencias de Agente** (`agents-preferences`):
- **Límites Operativos (Normativas/Invariants):** Restricciones estrictas y no negociables sobre herramientas y comportamiento del agente (ej: requerir aprobación previa del enfoque y código antes de cualquier `write`/`edit`).
- **Puntos de Control (Ask Catalog):** Momentos donde el agente debe detenerse y pedir confirmación antes de actuar (ej: comandos destructivos en bash, migraciones de base de datos).

#### Uso y Comandos Directos en Pi:
```bash
/playbook add agents
/playbook show agents
/playbook delete agents
```

#### Enforcement Transversal en Runtime:
A través del puntero de runtime en `before_agent_start` y la herramienta `playbook_consult`, las preferencias de agente supervisan las acciones del agente sin alterar su filosofía base ni sobrecargar el contexto.

---

### 5. Extracción de Esencia desde un Repositorio: `/playbook extract`
Si ya tenés un proyecto de referencia donde programaste con tu estilo (por ejemplo un backend en Go, un servicio en TypeScript, Rust o Python):

```bash
# Dentro de Pi (TUI: Agente Explorador con CodeGraph, Diff Semántico y Arbitraje 1 a 1)
/playbook extract [/ruta/al/repo] [--lang <lenguaje>]
```

#### 🧠 ¿Cómo funciona la extracción y el arbitraje agéntico en Pi?
A diferencia de herramientas que buscan palabras fijas o linters de juguete, `/playbook extract` despliega un **Agente Explorador de Esencia** respaldado por **CodeGraph**:

1. **Exploración Profunda con CodeGraph & Fallback Nativo:**
   - Si `codegraph` está disponible en tu sistema (`CODEGRAPH_BIN`), el agente indexa el repositorio completo (`codegraph ensureIndex`) y extrae el mapa integral de símbolos, interfaces, handlers, middlewares y tipos con sus números de línea exactos.
   - Si CodeGraph no está presente, inspecciona el árbol de archivos y manifiestos de dependencias (`package.json`, `go.mod`, `Cargo.toml`, etc.) de forma nativa.
2. **La Regla de Oro: "Elección vs Imposición":** El agente evalúa si existía una alternativa razonable en ese stack y qué eligió el autor consistentemente. Descarta lo obvio impuesto por el framework y captura la verdadera huella digital arquitectónica.
3. **Verificación Cuantitativa (Evidencia Contada):** No generaliza por intuición. Cuenta casos reales (`cumple / total`) y busca activamente contraejemplos:
   - **≥ 90% y ≥ 5 casos:** Se registra como **Normativa Invariante (`INVARIANT`)**.
   - **60-89% o condicional a contexto:** Se registra como **Punto de Control / Receta (`ASK_RULE`)**.
   - **< 60% o < 3 casos:** Se descarta como ruido.
4. **Ausencias Deliberadas (`Nunca`):** Identifica lo que el proyecto evita sistemáticamente cuando era una opción disponible (ej: *"No usar ORM; queries en SQL explícito"*, *"No usar globals"*, *"Sin `any`"*).
5. **Arbitraje Semántico con IA (Sin comparaciones fijas por ID):**
   - Cuando ya existe un playbook previo para ese lenguaje, el modelo compara conceptualmente el borrador extraído con tus reglas guardadas.
   - Detecta **redundancias semánticas** (reglas que dicen lo mismo con palabras distintas, como *"No usar interfaces Any"* vs *"No usar una interfaz que reciba cualquier tipo de dato"*) y **contradicciones directas** (ej: *"Usar Enums obligatorios"* vs *"Prohibir Enums"*).
   - Si el agente se interrumpe o falla, aborta limpiamente sin corromper el playbook.
6. **Resolución Interactiva de Conflictos 1 a 1 en el TUI:**
   Para cada conflicto detectado, Pi te muestra una tarjeta comparativa de la versión actual guardada vs la nueva propuesta y te permite elegir:
   - `🛡️ 1. Conservar versión actual`
   - `📥 2. Reemplazar por la nueva versión`
   - `💡 3. Convertir en regla condicional (Ask Rule)`
   - `🤖 4. Instruir a la IA para fusionar/resolver` *(le das una indicación en lenguaje natural y la IA redacta la síntesis definitiva entre A y B)*
   - `❌ Cancelar todo el merge` *(aborta de inmediato sin tocar el disco)*
7. **Persistencia con Confirmación Previa:** Nada se escribe en disco sin que vos confirmes explícitamente el guardado final.

---

### 6. Gestión y Eliminación Quirúrgica: `/playbook delete`

Administrá y depurá tus normas directamente desde el TUI de Pi con asistentes interactivos guiados:

```bash
# Modo interactivo asistido por menús (ui.select)
/playbook delete

# O especificar directamente el lenguaje / agents
/playbook delete go
/playbook delete agents

# Borrado quirúrgico de una regla específica por su ID
/playbook delete go --rule dto-notblank-validation
```

- **Borrado de Regla Individual:** Podés seleccionar una regla específica de la lista o pasar `--rule <id>`. La extensión te pedirá confirmación (`ui.confirm`) antes de removerla y actualizar la versión del playbook.
- **Borrado de Playbook Completo:** Si elegís borrar el playbook entero, requiere una **doble confirmación explícita** para prevenir pérdidas accidentales.

---

## ⌨️ Slash Commands en Pi (TUI-First)

Toda la funcionalidad de `gentle-playbook` está integrada de forma nativa en Pi, sin necesidad de binarios de consola ni cambios de ventana:

| Comando | Alias | Descripción |
|---|---|---|
| `/playbook` | `/gentle-playbook` | Menú interactivo: auditar playbooks guardados, inventario de reglas y estado. |
| `/playbook show <lang\|agents>` | `/gentle-playbook show` | Despliega en el chat las normas, checkpoints y prohibiciones del lenguaje (con `--full` incluye snippets de código). |
| `/playbook extract [path]` | `/gentle-playbook extract` | Lanza el **Agente de Esencia** con CodeGraph, diff semántico de IA y arbitraje 1 a 1 en el TUI. |
| `/playbook add [lang\|agents]` | `/gentle-playbook-add` | Flujo interactivo guiado para agregar una nueva regla sintetizada con LLM y validación anti-inyección. |
| `/playbook delete [lang\|agents]` | `/gentle-playbook delete` | Menú interactivo para eliminar reglas individuales quirúrgicamente o borrar playbooks completos. |

---

## 📂 Formato de Almacenamiento

Los playbooks se almacenan como archivos Markdown limpios en `~/.config/gentle-playbook/languages/<lang>.md`. Podés editarlos tanto desde la herramienta como a mano con tu editor favorito.

Ejemplo de `~/.config/gentle-playbook/languages/go.md`:

```markdown
<!-- gentle-playbook:v2 lang=go updated=2026-09-24 -->
# Playbook: Go

## Topology: Modular Hexagonal (Ports & Adapters)
- `src/adapters/drivers/`
- `src/adapters/drivens/`
- `src/core/ports/`
- `src/core/entities/`
- `src/shared/`

## Invariants

### [INVARIANT:null-byte-sanitizer] Middleware de Sanitización de Bytes Nulos
- **Surface:** `src/shared/middlewares/`
- **Rule:** Intercepta y rechaza peticiones HTTP con caracteres nulos (\x00 o %00) en URI, Query params o Body JSON para evitar excepciones de encoding en PostgreSQL (SQLSTATE 22021).

### [INVARIANT:dto-notblank-validation] Validación NotBlank en DTOs
- **Surface:** `src/shared/validators/`
- **Rule:** Campos string obligatorios en DTOs deben validar que no contengan bytes nulos ni estén compuestos únicamente de espacios en blanco utilizando la regla custom `validate:"notblank"`.

## Ask Catalog

### [ASK:rbac-authorization] Middleware de Autorización RBAC (Roles)
- **Surface:** `src/shared/middlewares/`
- **Trigger:** Creación de endpoints protegidos que requieren privilegios de administración o roles específicos.
- **Anti-Trigger:** Rutas públicas (/auth/login, /health) o endpoints accesibles a cualquier usuario autenticado sin distinción de rol.
- **Prompt:** "Este endpoint requiere restricción de privilegios. ¿Le aplicamos el middleware de control de roles (RBAC) estándar?"
- **Default:** Montar solo AuthMiddleware estándar sin restricción de roles específicos.
- **Recipe:** `canonical-rbac-middleware`

## Canonical Snippets

### [SNIPPET:canonical-null-byte-sanitizer] Middleware Sanitizador de Bytes Nulos
```go:null_byte_sanitizer.go
// [Código fuente canónico real]
```
```

---

## ⚙️ Variables de Entorno

| Variable | Descripción | Valor por Defecto |
|---|---|---|
| `CODEGRAPH_BIN` | Ruta al binario de CodeGraph para indexación y consultas AST | `codegraph` (resuelto vía `$PATH`) |
| `GENTLE_PLAYBOOK_DIR` | Directorio de almacenamiento de playbooks y preferencias | `~/.config/gentle-playbook/languages` |

---

## 🧪 Testing

El proyecto cuenta con una suite completa de pruebas unitarias y de integración desarrolladas con **Vitest**:

```bash
cd Gentle-playbook
npm test
```

Incluye tests de:
- Parsing y serialización bidireccional idempotente.
- Almacenamiento y persistencia en sistema de archivos.
- Motor de cálculo de Diff y resolución de conflictos.
- Catálogo oficial de lenguajes y normalización de alias.
- Síntesis de reglas mediante prompts estructurados.
- Extracción en vivo contra repositorios reales usando CodeGraph.

---

## 🛡️ Seguridad, Desacople de Contexto & Blindaje

Los playbooks y preferencias operan bajo un modelo de **datos pasivos de referencia bajo demanda** y gobernanza activa:

1. **Desacople del System Prompt (`playbook_consult` Tool):**
   A partir de la versión v0.6.0, el contenido completo de los playbooks no se inyecta en el prompt del sistema. Se expone como una herramienta TypeBox (`playbook_consult`) consultada por el modelo bajo demanda, eliminando la sobrecarga innecesaria de tokens y garantizando aislamiento estricto.
2. **Defensa contra Inyecciones & Turn-Hijacking:**
   Toda regla (manual o extraída) pasa por `validateRuleContent` y un catálogo de 17 categorías de detección de inyecciones de prompt (ChatML, delimitadores de rol, directivas de olvido en 5 idiomas y escape de entidades XML).
3. **Gobernanza Semántica en Tiempo Real:**
   El Agente evalúa en pre-vuelo (`input`) si el prompt busca eludir normas, requiriendo confirmación interactiva en TUI. En `tool_call`, se neutraliza cualquier intento de escritura fuera de superficies canónicas o mediante saltos de directorio (*path traversal*).
4. **Consentimiento Humano Obligatorio:**
   Ningún comando persiste reglas en disco de forma automática sin confirmación previa del usuario (o flag `--yes` explícito en entornos desatendidos).

---

## 📄 Licencia

MIT © [DarkKevo](https://github.com/DarkKevo)
