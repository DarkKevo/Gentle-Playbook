import { describe, it, expect } from 'vitest';
import { parsePlaybook, serializePlaybook, formatPlaybookForSystemPrompt } from '../src/core/parser.js';
import { Playbook } from '../src/core/schema.js';

describe('Playbook Parser & Serializer', () => {
  const canonicalMarkdown = `<!-- gentle-playbook:v1 lang=go updated=2025-02-18 -->
# Playbook: Go

## Topology: Hexagonal (Ports & Adapters)
- \`cmd/api/\`
- \`internal/core/domain/\`
- \`internal/core/ports/\`
- \`internal/adapters/handlers/\`
- \`internal/adapters/storage/\`

## Invariants

### [INVARIANT:null-byte-sanitizer] Middleware Sanitización Bytes Nulos
- **Surface:** \`internal/adapters/handlers/\`
- **Rule:** Todo payload entrante HTTP debe ser sanitizado antes de llegar a los DTOs para evitar inyecciones por byte nulo.

### [INVARIANT:dto-notblank] Validación NotBlank en DTOs
- **Surface:** \`internal/adapters/handlers/dto/\`
- **Rule:** Campos string requeridos deben usar el tag validate:"notblank" y el tipo custom que rechaza espacios vacíos.

## Ask Catalog

### [ASK:rate-limiting] Rate Limiting en Endpoints Sensibles
- **Surface:** \`internal/adapters/handlers/\`
- **Trigger:** Creación de endpoints públicos sin autenticación (/login, /register, webhooks).
- **Anti-Trigger:** Rutas privadas con JWT, tareas CLI o gRPC interno.
- **Prompt:** "Detecto un endpoint público sensible. ¿Le aplicamos el middleware de Rate Limit estándar?"
- **Default:** Solo aplicar sanitización estándar sin límite de tasa.
- **Recipe:** \`canonical-rate-limiter\`

## Canonical Snippets

### [SNIPPET:canonical-rate-limiter] Rate Limiter Middleware
\`\`\`go
func RateLimiter() gin.HandlerFunc {
    return func(c *gin.Context) {
        c.Next()
    }
}
\`\`\`
`;

  it('should parse a canonical playbook correctly', () => {
    const playbook = parsePlaybook(canonicalMarkdown);

    expect(playbook.language).toBe('go');
    expect(playbook.version).toBe(1);
    expect(playbook.updatedAt).toBe('2025-02-18');
    expect(playbook.topology.pattern).toBe('Hexagonal (Ports & Adapters)');
    expect(playbook.topology.directories).toEqual([
      'cmd/api/',
      'internal/core/domain/',
      'internal/core/ports/',
      'internal/adapters/handlers/',
      'internal/adapters/storage/',
    ]);

    expect(playbook.invariants).toHaveLength(2);
    expect(playbook.invariants[0].id).toBe('null-byte-sanitizer');
    expect(playbook.invariants[0].surface).toBe('internal/adapters/handlers/');
    expect(playbook.invariants[0].description).toContain('Todo payload entrante');

    expect(playbook.askRules).toHaveLength(1);
    expect(playbook.askRules[0].id).toBe('rate-limiting');
    expect(playbook.askRules[0].trigger).toContain('Creación de endpoints públicos');
    expect(playbook.askRules[0].antiTrigger).toContain('Rutas privadas con JWT');
    expect(playbook.askRules[0].prompt).toBe(
      'Detecto un endpoint público sensible. ¿Le aplicamos el middleware de Rate Limit estándar?'
    );
    expect(playbook.askRules[0].defaultAction).toContain('Solo aplicar sanitización estándar');
    expect(playbook.askRules[0].recipeSnippetId).toBe('canonical-rate-limiter');

    expect(playbook.snippets).toHaveLength(1);
    expect(playbook.snippets[0].id).toBe('canonical-rate-limiter');
    expect(playbook.snippets[0].language).toBe('go');
    expect(playbook.snippets[0].code).toContain('func RateLimiter()');
  });

  it('should serialize a playbook matching canonical markdown format', () => {
    const playbook = parsePlaybook(canonicalMarkdown);
    const serialized = serializePlaybook(playbook);

    // Re-parsing serialized output must be identical
    const reparsed = parsePlaybook(serialized);
    expect(reparsed).toEqual(playbook);
  });

  it('should format playbook for system prompt injection', () => {
    const playbook = parsePlaybook(canonicalMarkdown);
    const promptText = formatPlaybookForSystemPrompt(playbook);

    expect(promptText).toContain('ACTIVE ARCHITECTURAL PLAYBOOK: Go');
    expect(promptText).toContain('## INVARIANTS (MANDATORY & NON-NEGOTIABLE)');
    expect(promptText).toContain('null-byte-sanitizer');
    expect(promptText).toContain('## CONDITIONAL RECIPES [ASK CATALOG]');
    expect(promptText).toContain('rate-limiting');
    expect(promptText).toContain('Anti-Trigger: Rutas privadas con JWT');
  });

  it('should parse, serialize and format agents-preferences playbook', () => {
    const md = `<!-- gentle-playbook:v1 lang=agents-preferences updated=2025-02-18 -->
# Playbook: Agents Preferences

## Invariants

### [INVARIANT:require-write-approval] Aprobación previa de escritura
- **Surface:** \`tools:write,tools:edit\`
- **Rule:** No ejecutar herramientas de escritura sin presentar primero el approach y contar con aprobación explícita.

## Ask Catalog

### [ASK:ask-before-bash] Confirmar comandos bash destructivos
- **Surface:** \`tools:bash\`
- **Trigger:** Comandos destructivos o rm
- **Anti-Trigger:** Comandos de lectura como ls o git status
- **Prompt:** "¿Deseas ejecutar este comando destructivo?"
- **Default:** Cancelar ejecución
`;

    const parsed = parsePlaybook(md);
    expect(parsed.language).toBe('agents-preferences');
    expect(parsed.invariants).toHaveLength(1);
    expect(parsed.invariants[0].id).toBe('require-write-approval');
    expect(parsed.askRules).toHaveLength(1);
    expect(parsed.askRules[0].id).toBe('ask-before-bash');

    const promptText = formatPlaybookForSystemPrompt(parsed);
    expect(promptText).toContain('ACTIVE AGENT GOVERNANCE & SUPERVISION PLAYBOOK');
    expect(promptText).toContain('require-write-approval');
    expect(promptText).toContain('tools:write,tools:edit');

    const serialized = serializePlaybook(parsed);
    expect(serialized).toContain('# Playbook: Agents Preferences');
    const reparsed = parsePlaybook(serialized);
    expect(reparsed.invariants[0].description).toBe(parsed.invariants[0].description);
  });
});
