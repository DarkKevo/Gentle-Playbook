# 📘 Gentle-Playbook

> **Architectural Essence & Opinionated Language Playbook Manager for Pi, el Gentleman & OpenCode**

`gentle-playbook` es una extensión nativa para **Pi (TUI-First)** — y desde v0.9 un plugin nativo para **OpenCode** — diseñada para capturar, almacenar, hacer cumplir y evolucionar las normas de arquitectura de software personalizadas por lenguaje de programación. Toda la interacción, extracción agéntica y gestión se realiza dentro de tu agente, con wizards interactivos en Pi y flujos agente-mediados en OpenCode. Ambos runtimes comparten el mismo almacenamiento, las mismas reglas y enforcement idéntico byte a byte.

---

## 🎯 El Problema que Resuelve

Cuando desarrollás software con agentes de IA, cada nuevo repositorio o proyecto suele sufrir de tres problemas recurrentes:

1. **Amnesia Arquitectónica & Quema de Tokens:** El agente no sabe cómo estructurás tus proyectos en cada lenguaje (por ejemplo, Arquitectura Hexagonal en Go, middleware de bytes nulos para PostgreSQL, validaciones custom en DTOs o envelopes universales de respuesta). Tenés que explicarle todo desde cero en cada sesión, quemando miles de tokens de contexto.
2. **Fatiga de Contexto & Consulta entre Repositorios:** Tenés que abrir repositorios antiguos para copiar cómo habías implementado cierta validación o estructura para que el agente la replique.
3. **Improvisación de Librerías y "AI-Slop":** Ante la falta de directivas claras, los modelos suelen improvisar librerías externas innecesarias o sugerir preguntas irrelevantes en cada archivo (ej: meter Redis o Rate Limiting en scripts que no lo necesitan).

---

## 🏛️ Modelo Mental & Gobernanza Multicapa

`gentle-playbook` organiza las preferencias arquitectónicas y de gobernanza a través de una **jerarquía estricta de 4 capas de autoridad**:

```
┌─────────────────────────────────────────────────────────────┐
│ 1. LOCAL (./playbook.md en la raíz del repositorio)         │  ◄── Máxima autoridad soberana
├─────────────────────────────────────────────────────────────┤
│ 2. STACK (~/.config/gentle-playbook/stacks/<slug>.md)       │  ◄── Go+Gin, Nest+TypeORM, etc.
├─────────────────────────────────────────────────────────────┤
│ 3. GLOBAL (~/.config/gentle-playbook/languages/<lang>.md)   │  ◄── Go puro, TS puro, etc.
├─────────────────────────────────────────────────────────────┤
│ 4. AGENTE (~/.config/gentle-playbook/languages/agents_*.md) │  ◄── Gobernanza operativa de IA
└─────────────────────────────────────────────────────────────┘
```

> **Principio de Soberanía Local:** Las reglas definidas en `./playbook.md` tienen precedencia absoluta. Si una regla local gobierna una superficie (`surface`), enmascara automáticamente a cualquier regla subordinada de Stack o Global que toque esa misma superficie en los hooks de pre-vuelo (`input`) y de herramientas (`tool_call`).

---

## 🏷️ Taxonomía de Reglas

Dentro de cualquier ámbito (Local, Stack, Global o Agente), las reglas se clasifican en tres categorías estrictas:

```
                    ┌─────────────────────────┐
                    │     GENTLE PLAYBOOK     │
                    └────────────┬────────────┘
                                 │
         ┌───────────────────────┼───────────────────────┐
         ▼                       ▼                       ▼
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   INVARIANTS    │     │   ASK CATALOG   │     │   NEVER RULES   │
│(Normativas Duras│     │    (Patrones    │     │ (Prohibiciones  │
│  y Estructura)  │     │  Condicionales) │     │   Terminantes)  │
├─────────────────┤     ├─────────────────┤     ├─────────────────┤
│• Directa/silente│     │• Opcionales     │     │• Veto de kits   │
│  en conformidad │     │• Requieren      │     │  u ORMs         │
│• Confirmación o │     │  Trigger en     │     │• Prohibición    │
│  redirección    │     │  el contenido   │     │  categórica y   │
│  ante conflicto │     │• Anti-Trigger   │     │  cross-eco si   │
│• Ej: Bytes nulos│     │• Default seguro │     │  exige stdlib   │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

### 1. Invariants (Normativa Global - No negociable)
* Se aplican **directamente y en silencio cuando no hay conflicto**.
* Ante un conflicto de topología o superficie, el pre-vuelo interactivo solicita confirmación/redirección en TUI, o aplica redirección canónica visible en modo desatendido.
* *Ejemplo en Go:* Todo endpoint HTTP entrante pasa por el middleware de sanitización de bytes nulos (`\x00` y `%00`) para proteger PostgreSQL (SQLSTATE 22021). Todo DTO string obligatorio lleva el tag `validate:"notblank"`.

### 2. Ask Catalog (Patrones Condicionales & Recetas)
* Son bloques de arquitectura opcionales pero estandarizados.
* **Coordenadas de Activación:**
  * **Surface:** Superficie donde aplica la regla.
  * **Trigger:** Condición técnica en el texto del prompt que activa la consulta (ej: creación de endpoints públicos como `/login` o `/register`).
  * **Anti-Trigger:** Condición de veto donde **no corresponde preguntar** (ej: rutas privadas autenticadas o `/health` puro).
  * **Pregunta Canónica:** La formulación exacta para el usuario.
  * **Acción / Receta:** Si el usuario acepta, se instruye al modelo a incluir el extra aprobado junto con la implementación base. Si declina, se instruye a aplicar la acción por defecto sin omitir el feature base.

### 3. Never Rules (Prohibiciones Terminantes)
* Reglas de veto tecnológico y de dependencias (ej: prohibir Gin, Express, Flask, GORM o lodash).
* Si la regla exige la biblioteca estándar (`stdlib`), cualquier alternativa de terceros o de familias cross-ecosistema es interceptada categóricamente.

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
- **Si detecta OpenCode**: compilar el bundle del plugin (`dist/opencode.js`) e instalarlo en `~/.config/opencode/plugins/` junto con los comandos `/playbook*` en `~/.config/opencode/command/`.
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
2. **Puntero Liviano en System Prompt (`before_agent_start`):** En lugar de volcar miles de tokens de markdown en cada turno, Pi inyecta una directiva ligera en `systemPromptOptions.sections.playbook_guidance` (~60 tokens) que orienta al modelo a consultar obligatoriamente la herramienta `playbook_consult` antes de generar, estructurar o modificar código.
3. **Herramienta Nativa `playbook_consult`:** El modelo invoca la tool bajo demanda con filtrado por lenguaje (`go`, `typescript`, `agents`) o por superficie (`internal/ports`, `tools:write`, `git:push`), recuperando datos pasivos de referencia con total aislamiento de seguridad.

---

### 2. Gobernanza Determinística, Resolución de Conflictos y Asks Interactivos (Issue #12, #14, #15, #16)
Para garantizar que el modelo no desobedezca las reglas cuando el prompt contradice el reglamento o intenta usar tecnologías prohibidas, sin caer en salidas mudas ni canibalizar la entrega de código:

1. **Pre-vuelo Determinístico en `input` & Adopción en Pi:**
   - Cuando el usuario ingresa un prompt, el motor evalúa determinísticamente por patrones en memoria (<1ms) la intención contra las reglas activas del playbook (`evaluatePromptFull`).
   - El resultado clasifica formalmente la intención con tipado fuerte (`ViolationKind: checkpoint_bypass | playbook_bypass | surface_conflict | prohibited_dependency | agent_governance_violation`).
   - Salidas del hook `input`:
     - `{ action: 'transform', text: event.text }`: Cuando el texto es modificado con directivas de redirección canónica o resolución de Asks, garantizando adopción nativa en Pi.
     - `{ action: 'handled' }`: Cuando la operación es cancelada por el usuario o bloqueada ante un bypass en modo desatendido.
     - `{ action: 'continue' }`: Cuando el prompt no presenta conflictos, ante mensajes internos de la extensión, prompts vacíos, o excepciones atrapadas en el `catch`.

2. **Resolución de Conflictos sin Abortos Mudos (Anti-Silent Exit):**
   - **En modo interactivo (TUI):** Si el prompt entra en conflicto con una regla de topología o dependencia vetada, salta un selector estructurado o confirmación:
     1. `🛡️ Redirigir a la arquitectura canónica [Recomendado]`: Implementa el feature en la superficie permitida del playbook sin tecnologías prohibidas.
     2. `⚠️ Permitir excepción por esta única vez`: Autoriza conscientemente la desviación.
     3. `❌ Cancelar la operación`: Detiene la acción protegiendo las normas.
   - **En modo desatendido / headless (`--print`):** **Nunca se produce un aborto mudo (`exit 0` en blanco)**. El sistema inyecta una advertencia de gobernanza visible orientando al modelo a generar el feature en la superficie canónica y detallar la decisión al inicio de su respuesta.

3. **Manejo Interactivo de Asks sin Inanición del Feature Base:**
   - Si se activa una regla condicional (`AskRule`, ej: rate limiting en login público):
     - **En TUI**: Se activa la confirmación interactiva (`ctx.ui.confirm`). Si el usuario dice **Sí**, se instruye construir el feature con el extra aprobado. Si dice **No**, se instruye construirlo **sin el extra** (default).
     - **En Headless**: Se inyecta la directiva con la acción por defecto.
   - **Garantía de Entrega**: En todos los casos, **el feature base solicitado se implementa siempre**, eliminando el fallo donde el modelo solo preguntaba y dejaba el proyecto vacío.

4. **Defensa Estricta ante Bypass de Checkpoints:**
   - Intentos en el prompt de eludir controles (*"sin consultar"*, *"no preguntes"*, *"sin playbook"*) son catalogados como intentos de bypass.
   - Exigen confirmación interactiva en TUI y **fallan cerrado (Fail-Closed)** en entornos headless emitiendo un error explícito.

5. **Afinidad Dinámica de Superficies Multicapa (Sin Deadlock de Escritura):**
   - `checkPathViolation` evalúa las superficies declaradas en el playbook dinámicamente. Si un archivo pertenece legítimamente a otra capa de la arquitectura (ej: repositorios en `internal/adapters/db` vs lógica en `internal/domain`), el sistema no genera falsos positivos ni deadlocks cruzados.

6. **Supervisión de Herramientas de Agente en `tool_call` & Fail-Closed:**
   - Las reglas de `Agent Preferences` sobre herramientas (`tools:write`, `tools:edit`, `tools:all`) se ejecutan dinámicamente en tiempo de ejecución de la herramienta (`never` bloquea terminante, `ask` e `invariants` exigen autorización).
   - Ante cualquier excepción imprevista de runtime, la barrera aplica política **Fail-Closed**, bloqueando la ejecución para evitar escrituras no autorizadas.

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

### 5. Stacks Tecnológicos & Subtipado Estructural: `/playbook stack`
Los stacks permiten gobernar combinaciones de tecnologías (ej: `Go + Gin`, `NestJS + TypeORM`, `React + Tailwind`, `Solidity + Hardhat`) sin contaminar las normas del lenguaje global:

```bash
# Listar stacks instalados, sus banderas requeridas y cantidad de reglas
/playbook stack list

# Crear un stack sintetizado con IA a partir de lenguaje natural
/playbook stack "go con gin y gorm"
/playbook stack create "nest con typeorm y postgres"

# Eliminar un stack que ya no utilices
/playbook stack delete go-gin
```

#### 🧩 Subtipado Estructural (*Duck Typing*):
Un Stack se activa en un proyecto si y solo si el proyecto cumple con **todas** las banderas requeridas (`requiredFlags.every`). Si el proyecto incluye más tecnologías (ej: backend Go+Gin y frontend React), ambos stacks se activan en paralelo armoniosamente.

#### ⚔️ Resolución de Conflictos Multistack:
Si dos stacks activos tienen reglas que chocan en la misma superficie:
1. Se le presentan al desarrollador ambas reglas completas con sus contenidos en el TUI.
2. El usuario elige cuál adoptar o redacta una norma custom.
3. La decisión **se aterriza automáticamente en el `./playbook.md` local del repositorio**, cerrando el conflicto definitivamente.

---

### 6. Adición de Reglas en 4 Ámbitos: `/playbook add`
Al agregar una regla manual, podés dirigirla a cualquiera de las 4 capas de gobernanza:

```bash
/playbook add
```

1. 🤖 **Preferencias de Agente** (Supervisión y Gobernanza de IA)
2. 🏠 **Proyecto Local** (`./playbook.md` en la raíz del repositorio)
3. 📦 **Stack Tecnológico** (selecciona o crea un stack)
4. 🌐 **Lenguaje Global** (Go, TypeScript, Python, etc.)

*Alerta de colisión en vivo:* Si la regla choca con una regla existente en otra capa, el sistema te muestra el enfrentamiento y te permite elegir si sobreescribís, conservás la versión existente o reformulás la regla.

---

### 7. Extracción de Esencia y Triage 1 a 1: `/playbook extract`
Si ya tenés un proyecto de referencia donde programaste con tu estilo:

```bash
# Dentro de Pi (TUI: Agente Explorador con CodeGraph y Triage Interactivo 1 a 1)
/playbook extract [/ruta/al/repo] [--lang <lenguaje>]
```

#### 🎯 Wizard de Triage Regla por Regla (1 a 1):
A diferencia del volcado masivo en bloque, `/playbook extract` pasa **regla por regla** con una tarjeta interactiva en el TUI:

- 🌐 **1. Global:** guarda la regla en el lenguaje base (`languages/<lang>.md`).
- 📦 **2. Stack:** asigna la regla a un stack tecnológico existente o nuevo.
- 🏠 **3. Proyecto Local:** guarda la regla exclusivamente en el `./playbook.md` de este repositorio.
- ✏️ **4. Modificar regla:** ingresás un prompt en lenguaje natural, la IA refina la regla y te la vuelve a mostrar en el menú para clasificarla.
- 🗑️ **5. Descartar regla:** descarta la regla y avanza a la siguiente.

#### ⚔️ Resolución de Conflictos Humano-Legible:
Cuando una regla entrante coincide con un ID existente o entra en conflicto de soberanía:
1. **Tarjeta comparativa completa:** Se proyecta en Markdown la regla existente vs la regla entrante con sus IDs, superficies y descripciones detalladas.
2. **Opciones con texto explícito:** Las opciones del selector interactivo muestran la descripción literal de cada regla (`📥 Adoptar nueva: "..."` vs `🛡️ Conservar existente: "..."`), eliminando la incertidumbre de elegir por IDs abstractos.
3. **Convivencia no conflictiva en la misma capa:** Reglas independientes dentro del mismo playbook pueden gobernar legítimamente superficies compartidas (ej: `core/style`, `transport/http`) sin generar falsos positivos.

---

### 8. Gestión y Eliminación Quirúrgica: `/playbook delete`

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

## 🧩 Soporte OpenCode (v0.9)

`gentle-playbook` corre también como **plugin nativo de OpenCode**: mismo almacenamiento (`~/.config/gentle-playbook/`), mismas reglas y **enforcement idéntico byte a byte** al de Pi, porque ambos runtimes comparten el módulo de gobernanza (`src/core/governance.ts`).

### Arquitectura del adapter

El entry del plugin sigue el contrato **v2 de `@opencode/plugin`** (`@opencode/plugin@2.0.4`): el bundle exporta por default el objeto `Plugin.define({ id: "gentle-playbook", setup(ctx) })` y registra todo por dominio (`ctx.session.hook`, `ctx.tool.hook`, `ctx.tool.transform`).

| API Pi | Equivalente OpenCode 2.x | Función |
|---------|--------------------------|----------|
| `before_agent_start` (puntero en system prompt) | `ctx.session.hook("context")` (SystemPart por request) | Directiva liviana que orienta a consultar `playbook_consult` |
| Hook `input` (pre-vuelo) | `ctx.session.hook("prompt")` (muta `prompt.text` in-place) | Evaluación determinística (<1ms, sin LLM) del prompt contra las capas activas |
| Hook `tool_call` (barrera de escritura) | `ctx.tool.hook("execute.before")` (args en `call.input`) | Fail-closed para `write`/`edit`/`patch`; `throw` = bloqueo |
| `registerTool(playbook_consult)` | `ctx.tool.transform` → `editor.add({ name: "playbook_consult", input: zod })` | Datos pasivos de referencia on-demand |
| Wizards TUI (`/playbook add`...) | Comandos markdown + `playbook_manage` | Flujos **agente-mediados**: el agente pregunta, la tool ejecuta |
| — (exclusivo de OpenCode) | `ctx.session.hook("compaction")` | Las normas activas sobreviven a la compactación |

### Diferencias de runtime (por diseño)

- **OpenCode no permite cancelar un mensaje desde un plugin**: los intentos de bypass quedan como directiva visible (`[DIRECTIVA DE GOBERNANZA PLAYBOOK]: Se detectó un intento de eludir el control...`) y el bloqueo real vive en la barrera de herramientas.
- **No hay UI de plugin**: los wizards interactivos de Pi se convierten en flujos agente-mediados. El comando instruye al agente, el agente sintetiza la regla conversando con el usuario, y `playbook_manage` valida, previsualiza (colisiones incluidas), confirma y persiste. El contenido tipo inyección se rechaza ruidosamente ANTES de persistir (nunca se dropea en silencio).
- **Preguntas ASK**: en Pi saltan como confirmaciones TUI; en OpenCode la directiva aplica el default documentado sin inanición del feature base.

### Comandos en OpenCode

| Comando | Flujo |
|---------|-------|
| `/playbook` | Jerarquía activa del workspace (solo lectura) |
| `/playbook-add` | Wizard agente-mediado: capa → regla natural → tipo → síntesis → preview → confirmación → save |
| `/playbook-extract` | Extracción de esencia de un repo de referencia + triage 1 a 1 (Global/Stack/Local/Modificar/Descartar) |
| `/playbook-stack` | Listar, crear (`scope: "stack"`) y eliminar stacks |
| `/playbook-delete` | Eliminación quirúrgica de reglas o playbooks completos con confirmación explícita |

Las tools del modelo (`playbook_consult`, `playbook_manage`) también están disponibles sin comandos: cualquier agente puede consultar o gestionar normas en conversación directa.

### Instalación en OpenCode

El `install.sh` detecta OpenCode automáticamente (binario o `~/.config/opencode` existente), compila el bundle single-file y lo instala:

```text
~/.config/opencode/plugins/gentle-playbook.js   (bundle ESM: export default = { id, setup }; zod incluido, @opencode/plugin como peer del runtime)
~/.config/opencode/command/playbook*.md          (5 comandos)
```

Requiere **OpenCode 2.0.x** (contrato v2 de plugins). El bundle carga como módulo ESM: `import` del archivo devuelve un objeto `default` con `id: "gentle-playbook"` y una función `setup(ctx)`.

Si instalaste OpenCode después de gentle-playbook, re-ejecutá el install.

---

## ⌨️ Subcomandos de `/playbook` en Pi (TUI-First)

Toda la funcionalidad de `gentle-playbook` está integrada de forma nativa en Pi mediante el comando `/playbook` (o alias `/gentle-playbook`) y sus subcomandos:

| Subcomando | Alias directo | Descripción y Flags |
|---|---|---|
| `/playbook` [list] | `/gentle-playbook` | Menú interactivo: auditar playbooks guardados, inventario de reglas y estado. |
| `/playbook show <lang\|agents>` | `/gentle-playbook show` | Despliega en el chat las normas, checkpoints y prohibiciones del lenguaje (flag `--full` incluye snippets de código). |
| `/playbook extract [path]` | `/gentle-playbook extract` | Lanza el **Agente de Esencia** con CodeGraph y **Triage interactivo 1 a 1** (Global, Stack, Local, Modificar, Descartar). |
| `/playbook add [lang\|agents]` | `/gentle-playbook-add` | Flujo interactivo guiado para agregar una nueva regla en **4 ámbitos** (Agente, Local, Stack, Global) con alerta de colisiones. |
| `/playbook stack <list\|create\|delete>` | `/playbook-stack` | Crea, lista y gestiona Stacks Tecnológicos con detección estructural por banderas (`requiredFlags.every`). |
| `/playbook delete [lang\|agents]` | `/gentle-playbook delete` | Menú interactivo para eliminar reglas individuales quirúrgicamente (soporta flag `--rule <id>`) o borrar playbooks completos. |

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
   Toda regla (manual o extraída) pasa por `validateRuleContent` y un catálogo de 16 categorías de detección de inyecciones de prompt (`INJECTION_PATTERNS`: ChatML, delimitadores de rol, directivas de olvido en varios idiomas y escape de entidades XML).
3. **Gobernanza Determinística en Tiempo Real & Fail-Closed:**
   El motor evalúa en pre-vuelo (`input`) si el prompt busca eludir normas, requiriendo confirmación interactiva en TUI. En `tool_call`, se neutraliza cualquier intento de escritura fuera de superficies canónicas o mediante saltos de directorio (*path traversal*), aplicando política **Fail-Closed** en el hook de herramientas ante cualquier excepción imprevista.
4. **Consentimiento Humano Obligatorio:**
   Ningún comando persiste reglas en disco de forma automática sin confirmación previa del usuario (o flag `--yes` explícito en entornos desatendidos).

---

## 📄 Licencia

MIT © [DarkKevo](https://github.com/DarkKevo)
