# 📘 Gentle-Playbook

> **Architectural Essence & Opinionated Language Playbook Manager for Pi & el Gentleman**

`gentle-playbook` es una extensión nativa y CLI para **Pi** diseñada para capturar, almacenar, hacer cumplir y evolucionar las normas de arquitectura de software personalizadas por lenguaje de programación.

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
- Enlazar el binario CLI en `~/.local/bin/gentle-playbook`.
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

### 1. Detección Automática & Inyección en Runtime (Zero-Friction)
Cuando abrís una sesión de Pi en cualquier proyecto:
1. **Notificación de inicio (`session_start`):** Inspecciona los archivos raíz (`go.mod` ➔ Go, `package.json` ➔ TypeScript, `Cargo.toml` ➔ Rust). Si existe un playbook guardado para ese lenguaje, te notifica que está activo.
2. **Inyección en System Prompt (`before_agent_start`):** Antes de cada turno, la extensión inyecta una sección estructurada `<gentle_playbook>` directamente en las directivas del sistema del LLM.

**Beneficio clave:** El modelo conoce tus normas no negociables (invariantes) y sus condiciones de activación (ask) **desde el token #0**, sin necesidad de ejecutar herramientas (`read`, `grep`, etc.), ahorrando turnos y tokens de contexto. El agente programa con tu estilo de inmediato.

---

### 2. Comando Interactivo en Pi: `/gentle-playbook-add`
Agregá nuevas preferencias arquitectónicas o de gobernanza mediante un flujo interactivo guiado:

1. **Pregunta 1 (Categoría):** Elegís entre:
   - 🤖 **Preferencias de Agente** (Supervisión y Gobernanza de IA)
   - 💻 **Regla de Arquitectura de Lenguaje** (Go, TypeScript, Python, Rust, etc.)
2. **Pregunta 2:** Escribís en lenguaje natural tu preferencia o límite operativo:
   > *"no se hace write si no yo lo apruebo, primero el approach del cambio con código y luego mi aprobación"*
3. **Clasificación:** Elegís si es:
   - 🛡️ **[NORMATIVA]**: Límite operativo o invariante no negociable.
   - 💡 **[ASK]**: Punto de control condicional o receta con pregunta previa.
4. **Síntesis con LLM & Preview de Confirmación:**
   El modelo estructurará la regla y te mostrará una confirmación con `Yes / No` en la terminal antes de guardarla en el playbook.

---

### 3. 🤖 Agents Preferences: Gobernanza y Supervisión de Agente

Además de reglas arquitectónicas de código por lenguaje, `gentle-playbook` permite registrar **Preferencias de Agente** (`agents-preferences`):
- **Límites Operativos (Normativas/Invariants):** Restricciones estrictas y no negociables sobre herramientas y comportamiento del agente (ej: requerir aprobación previa del enfoque y código antes de cualquier `write`/`edit`).
- **Puntos de Control (Ask Catalog):** Momentos donde el agente debe detenerse y pedir confirmación antes de actuar (ej: comandos destructivos en bash, migraciones de base de datos).

#### Uso y Comandos Directos:
```bash
/gentle-playbook add agents
/gentle-playbook show agents
```
O desde la terminal:
```bash
gentle-playbook show agents
```

#### Enforcement Transversal en Runtime:
A través del hook `before_agent_start`, las preferencias de agente se cargan **siempre y en cualquier proyecto** en el system prompt, supervisando las acciones del agente sin alterar su filosofía base.

---

### 4. Extracción de Esencia desde un Repositorio: `extract`
Si ya tenés un proyecto de referencia donde programaste con tu estilo (por ejemplo un backend en Go, un servicio en TypeScript, Rust o Python):

```bash
# Dentro de Pi (Recomendado: Agente Explorador con Evidencia y Confirmación)
/gentle-playbook extract /ruta/a/mi-backend

# O desde la terminal (CLI)
gentle-playbook extract /ruta/a/mi-backend [--lang go]
```

#### 🧠 ¿Cómo funciona la extracción inteligente con Agente en Pi?
A diferencia de herramientas que buscan palabras fijas o aplican linters genéricos, `/gentle-playbook extract` despliega un **Agente Explorador de Esencia** que aplica ingeniería inversa bajo una metodología rigurosa de 4 fases:

1. **Reconocimiento y Detección de Monorepos:** Identifica el tipo de proyecto (`api-http`, `cli`, `frontend`, `worker/pipeline`, etc.). Si coexisten múltiples manifiestos (`go.mod`, `package.json`), pondera automáticamente por el conteo real de archivos de código para determinar el lenguaje predominante (respetando `--lang` si lo especificás).
2. **La Regla de Oro: "Elección vs Imposición":** El agente evalúa si existía una alternativa razonable en ese stack y qué eligió el autor consistentemente. Descarta lo obvio impuesto por el lenguaje/framework y captura la verdadera huella digital arquitectónica.
3. **Verificación Cuantitativa (Evidencia Contada):** No generaliza por intuición. Cuenta casos reales (`cumple / total`) y busca activamente contraejemplos:
   - **≥ 90% y ≥ 5 casos:** Se registra como **Normativa Invariante (`INVARIANT`)**.
   - **60-89% o condicional a contexto:** Se registra como **Punto de Control / Receta (`ASK_RULE`)**.
   - **< 60% o < 3 casos:** Se descarta como ruido.
4. **Ausencias Deliberadas (`Nunca`):** Identifica lo que el proyecto evita sistemáticamente cuando era una opción disponible (ej: "No usar ORM; queries en SQL explícito", "No usar globals", "Sin `any`").
5. **Reporte de Evidencia & Confirmación Previa:** Antes de tocar el disco, Pi te muestra una tabla de evidencia con `archivo:línea` de cada regla detectada y te pide confirmación explícita (`Yes / No`) para guardar o fusionar los cambios con tu playbook existente.

*(Nota: En modo CLI sin LLM activo, `gentle-playbook extract` utiliza un motor estático de topología y patrones de referencia para Go).*

---

### 4. Comandos de Terminal (CLI)

```bash
# Listar todos los playbooks y cantidad de reglas registradas
gentle-playbook list

# Ver el resumen de normas y preguntas condicionales de un lenguaje
gentle-playbook show go

# Ver el playbook completo incluyendo los snippets de código fuente
gentle-playbook show go --full

# Agregar una regla individual (invariante, ask o nunca)
gentle-playbook add go --type invariant --title "No Null Bytes" --surface "internal/http/" --description "Rechazar caracteres nulos"
gentle-playbook add go --type ask --title "Rate Limit" --trigger "Rutas públicas" --prompt "¿Aplicar rate limiter?"
gentle-playbook add go --type never --description "No usar ORMs pesados; SQL explícito con pgx"

# Extraer y actualizar un playbook desde un repositorio
gentle-playbook extract /ruta/al/repo [--lang go]

# Borrado quirúrgico de una regla específica por su ID
gentle-playbook delete go --rule dto-notblank-validation

# Eliminar un playbook completo (con confirmación de seguridad interactiva o --yes)
gentle-playbook delete python [--yes]
```

---

### 5. Slash Commands en Pi

| Comando | Descripción |
|---|---|
| `/gentle-playbook` | Abre el selector interactivo para auditar el playbook activo. |
| `/gentle-playbook show <lang>` | Muestra las normativas e invariantes del lenguaje en el chat. |
| `/gentle-playbook-add` | Flujo interactivo guiado para agregar una nueva regla con síntesis LLM. |
| `/gentle-playbook extract <path>` | Lanza la extracción desde Pi. |

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

## 📄 Licencia

MIT © [DarkKevo](https://github.com/DarkKevo)
