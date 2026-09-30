import * as path from 'node:path';
import { Playbook, InvariantRule, NeverRule, AskRule } from './schema.js';

export type ViolationKind =
  | 'checkpoint_bypass'
  | 'playbook_bypass'
  | 'surface_conflict'
  | 'prohibited_dependency'
  | 'agent_governance_violation';

export interface ViolationMatch {
  rule: InvariantRule | NeverRule | AskRule;
  reason: string;
  source: 'never' | 'invariant' | 'ask';
  kind: ViolationKind;
}

export interface AskTriggerMatch {
  rule: AskRule;
  prompt: string;
  defaultAction: string;
}

/**
 * Familias tecnológicas para reconocer análogos y alternativas cuando
 * una regla veta una tecnología o exige el uso exclusivo de la biblioteca estándar (stdlib).
 */
export const TECHNOLOGY_FAMILIES: Record<
  string,
  { family: string; members: string[]; stdlib?: string; description?: string }
> = {
  gin: {
    family: 'go-http-frameworks',
    members: ['gin', 'chi', 'echo', 'fiber', 'gorilla/mux', 'gorilla mux', 'beego', 'iris', 'fasthttp', 'revel'],
    stdlib: 'net/http',
    description: 'routers o frameworks HTTP externos en Go',
  },
  express: {
    family: 'node-http-frameworks',
    members: ['express', 'fastify', 'koa', 'nestjs', 'nest', 'hapi', 'restify'],
    stdlib: 'node:http',
    description: 'frameworks HTTP externos en Node/TypeScript',
  },
  flask: {
    family: 'python-http-frameworks',
    members: ['flask', 'django', 'fastapi', 'tornado', 'bottle', 'sanic', 'pyramid', 'falcon'],
    stdlib: 'http.server',
    description: 'frameworks HTTP externos en Python',
  },
  gorm: {
    family: 'go-orms',
    members: ['gorm', 'ent', 'sqlboiler', 'xorm', 'beego orm'],
    description: 'ORMs pesados en Go',
  },
  prisma: {
    family: 'node-orms',
    members: ['prisma', 'typeorm', 'sequelize', 'mongoose', 'mikro-orm', 'drizzle'],
    description: 'ORMs en Node/TypeScript',
  },
  sqlalchemy: {
    family: 'python-orms',
    members: ['sqlalchemy', 'django-orm', 'peewee', 'tortoise-orm', 'tortoise'],
    description: 'ORMs en Python',
  },
  lodash: {
    family: 'js-fp-utils',
    members: ['lodash', 'underscore', 'ramda'],
    description: 'librerías externas de utilidades funcionales',
  },
};

export interface PromptEvaluationResult {
  violation: ViolationMatch | null;
  triggeredAsk: AskTriggerMatch | null;
}

/**
 * Realiza una evaluación completa (semántica con LLM o heurística determinística)
 * detectando tanto violaciones a la arquitectura como puntos de control condicionales (ASK).
 */
export async function evaluatePromptFull(
  promptText: string,
  playbook: Playbook,
  completePrompt?: (prompt: string) => Promise<string>
): Promise<PromptEvaluationResult> {
  if (!promptText || !promptText.trim()) {
    return { violation: null, triggeredAsk: null };
  }

  const invariants = playbook?.invariants || [];
  const askRules = playbook?.askRules || [];
  const neverRules = playbook?.neverRules || [];

  if (completePrompt && (invariants.length > 0 || askRules.length > 0 || neverRules.length > 0)) {
    const rulesList: string[] = [];
    for (const inv of invariants) {
      rulesList.push(`- [INVARIANT:${inv.id}] (Surface: ${inv.surface}) ${inv.description || ''}`);
    }
    for (const ask of askRules) {
      rulesList.push(`- [ASK:${ask.id}] (Surface: ${ask.surface}) Trigger: ${ask.trigger} | Prompt: "${ask.prompt}"`);
    }
    for (const never of neverRules) {
      rulesList.push(`- [NEVER:${never.id}] (Surface: ${never.surface || 'dependencies'}) ${never.description || ''}`);
    }

    const prompt = `# Misión: Evaluación Semántica de Intención de Prompt vs Playbook

Eres el motor de gobernanza semántica de Gentle-Playbook.
Tu tarea es analizar el significado real (semántica) del prompt del usuario y determinar si CONTRADICE, ELUDE o PIDE UNA EXCEPCIÓN respecto a las reglas activas del playbook.

## REGLAS ACTIVAS (${(playbook.language || 'generic').toUpperCase()}):
${rulesList.join('\n')}

## MENSAJE / PROMPT DEL USUARIO:
"${promptText.trim()}"

## CRITERIOS DE JUICIO SEMÁNTICO:
1. CONFLICTO / VIOLACIÓN (conflict: true):
   - El usuario pide usar una tecnología, herramienta o práctica prohibida por una regla NEVER (por nombre, sinónimo, familia o paráfrasis, ej: Chi/Echo cuando se prohíbe Gin y se exige net/http; Fastify/Koa cuando se prohíbe Express y se exige node:http; FastAPI/Django cuando se prohíbe Flask y se exige http.server; ORMs cuando se prohíbe GORM/Prisma/SQLAlchemy; lodash en FP).
   - El usuario pide colocar código, handlers, SQL o lógica en rutas contrarias a una regla INVARIANT de exclusividad (ej: en main.go, pkg/, cmd/, src/routes/, app/views/, internal/core/, etc.).
   - El usuario modela con class cuando la regla de arquitectura lo prohíbe expresamente.
   - El usuario pide explícitamente ignorar, apagar o no usar el playbook ("sin playbook", "olvidate de las reglas", etc.).
   - El usuario intenta forzar la implementación eludiendo un punto de control ("sin preguntar", "no consultes", "sin consultar", "hacelo de una sin confirmación"). Todo intento de bypass de checkpoint es SIEMPRE conflicto.

2. COMPATIBLE / SIN CONFLICTO (conflict: false):
   - Consultas informativas, lectura, preguntas conceptuales o peticiones que cumplen la arquitectura.
   - Peticiones ordinarias de implementación que se ubican en las superficies permitidas.

3. DETECCIÓN DE REGLAS ASK CONDICIONALES (triggeredAskId):
   - Si el requerimiento activa la condición/trigger de una regla ASK (ej: endpoint público como /login o /signup, migraciones de esquema, o estado mutable) y NO coincide con su anti-trigger (health checks, rutas autenticadas, funciones puras), reporta "triggeredAskId": "id-del-ask".

Responde ÚNICAMENTE con un bloque JSON con esta estructura exacta:
\`\`\`json
{
  "conflict": true,
  "kind": "checkpoint_bypass" | "playbook_bypass" | "surface_conflict" | "prohibited_dependency" | "agent_governance_violation",
  "ruleId": "id-de-la-regla",
  "reason": "Explicación breve del conflicto"
}
\`\`\`
O si no hay conflicto:
\`\`\`json
{
  "conflict": false,
  "triggeredAskId": "id-del-ask-si-aplica"
}
\`\`\`
`;

    try {
      const rawResponse = await completePrompt(prompt);
      const blockMatches = Array.from(rawResponse.matchAll(/```(?:json)?\r?\n([\s\S]*?)\r?\n```/g));
      let jsonText = '';

      if (blockMatches.length > 0) {
        jsonText = blockMatches[blockMatches.length - 1][1].trim();
      } else {
        const conflictMatch = rawResponse.match(/\{[\s\S]*?"conflict"\s*:\s*(?:true|false)[\s\S]*?\}/);
        if (conflictMatch) {
          jsonText = conflictMatch[0].trim();
        } else {
          const generalMatch = rawResponse.match(/\{[\s\S]*\}/);
          if (generalMatch) jsonText = generalMatch[0].trim();
        }
      }

      if (jsonText) {
        const parsed = JSON.parse(jsonText);

        if (parsed.conflict && parsed.ruleId) {
          const rawId = String(parsed.ruleId)
            .trim()
            .replace(/^[\[\(]?(?:never|invariant|ask):\s*/i, '')
            .replace(/[\]\)\.]+$/, '')
            .trim()
            .toLowerCase();

          const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
          const targetClean = clean(rawId);

          const matchedRule =
            neverRules.find((n) => n.id.toLowerCase() === rawId || clean(n.id) === targetClean) ||
            invariants.find((i) => i.id.toLowerCase() === rawId || clean(i.id) === targetClean) ||
            askRules.find((a) => a.id.toLowerCase() === rawId || clean(a.id) === targetClean);

          if (matchedRule) {
            let kind: ViolationKind = 'surface_conflict';
            if (
              parsed.kind === 'checkpoint_bypass' ||
              parsed.kind === 'playbook_bypass' ||
              parsed.kind === 'surface_conflict' ||
              parsed.kind === 'prohibited_dependency' ||
              parsed.kind === 'agent_governance_violation'
            ) {
              kind = parsed.kind;
            } else if (matchedRule.type === 'never') {
              kind = 'prohibited_dependency';
            } else if (matchedRule.type === 'ask') {
              kind = 'checkpoint_bypass';
            }

            return {
              violation: {
                rule: matchedRule,
                reason: parsed.reason || `Conflicto semántico detectado con la regla [${matchedRule.id.toUpperCase()}].`,
                source: matchedRule.type,
                kind,
              },
              triggeredAsk: null,
            };
          }
        }

        if (parsed.conflict === false) {
          let triggeredAsk: AskTriggerMatch | null = null;
          if (parsed.triggeredAskId) {
            const rawAskId = String(parsed.triggeredAskId).trim().toLowerCase().replace(/^[\[\(]?ask:\s*/i, '').replace(/[\]\)\.]+$/, '');
            const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
            const matchedAsk = askRules.find(
              (a) => a.id.toLowerCase() === rawAskId || clean(a.id) === clean(rawAskId)
            );
            if (matchedAsk) {
              triggeredAsk = {
                rule: matchedAsk,
                prompt: matchedAsk.prompt,
                defaultAction: matchedAsk.defaultAction || 'No aplicar',
              };
            }
          }
          if (!triggeredAsk) {
            triggeredAsk = checkAskTrigger(promptText, playbook);
          }
          return { violation: null, triggeredAsk };
        }
      }
    } catch {
      // Si falla la llamada LLM, cae al evaluador determinístico abajo
    }
  }

  const violation = checkPromptViolation(promptText, playbook);
  const isQuery = isQueryOrExploratoryPrompt(promptText);
  const triggeredAsk = violation || isQuery ? null : checkAskTrigger(promptText, playbook);
  return { violation, triggeredAsk };
}

/**
 * Detects if a prompt is an informational, exploratory, or migration query
 * rather than an implementation command requesting the prohibited technology.
 */
export function isQueryOrExploratoryPrompt(promptText: string): boolean {
  if (!promptText) return false;
  const lower = promptText.toLowerCase().trim();

  // 1. Preguntas directas sobre justificación arquitectónica o reglas
  if (
    /\b(?:por\s+qu[eé]|why)\s+(?:no\s+usamos|no\s+se\s+usa|est[aá]\s+prohibido|se\s+proh[ií]be|evitamos|se\s+evita|est[aá]\s+vetado|se\s+veta|no\s+est[aá]\s+permitido)\b/i.test(lower) ||
    /\b(?:why\s+(?:don't\s+we\s+use|is\s+it\s+forbidden|is\s+\w+\s+forbidden|do\s+we\s+avoid|not\s+use))\b/i.test(lower) ||
    /\b(?:cu[aá]l\s+es\s+la\s+raz[oó]n|cu[aá]l\s+es\s+el\s+motivo|what\s+is\s+the\s+reason)\s+(?:de\s+no\s+usar|para\s+no\s+usar|de\s+evitar|de\s+prohibir|for\s+not\s+using|to\s+avoid)\b/i.test(lower)
  ) {
    return true;
  }

  // 2. Comparativas, pros y contras, alternativas o debate teórico
  if (
    /\b(?:diferencias?\s+entre|difference\s+between|pros\s+y\s+contras|pros\s+and\s+cons|comparar|comparativa|versus|\bvs\.?\b)\b/i.test(lower) ||
    /\b(?:qu[eé]\s+ventajas?\s+tiene|what\s+are\s+the\s+benefits)\b/i.test(lower) ||
    /\b(?:qu[eé]\s+opin[aá]s\s+de|qu[eé]\s+te\s+parece|what\s+do\s+you\s+think\s+(?:of|about))\b/i.test(lower) ||
    /\b(?:alternativas?\s+a|alternatives?\s+to)\b/i.test(lower)
  ) {
    return true;
  }

  // 3. Migración de salida (alejarse de la tecnología prohibida hacia la recomendada)
  if (
    /\b(?:c[oó]mo\s+migrar\s+(?:de|desde)|how\s+to\s+migrate\s+from|migrando\s+(?:de|desde)|migraci[oó]n\s+(?:de|desde))\b/i.test(lower) ||
    /\b(?:reemplazar|eliminar|remover|quitar|deprecar|sacar)\s+(?:el\s+|la\s+|a\s+)?(?:framework|librer[ií]a|orm|paquete)?\s*[a-zA-Z0-9_\-\/]+\s+(?:por|para\s+usar)\b/i.test(lower)
  ) {
    return true;
  }

  return false;
}

/**
 * Evaluates semantically via LLM agent whether a user prompt conflicts with,
 * contradicts, or attempts to bypass any active playbook rules.
 */
export async function evaluatePromptSemantically(
  promptText: string,
  playbook: Playbook,
  completePrompt: (prompt: string) => Promise<string>
): Promise<ViolationMatch | null> {
  const result = await evaluatePromptFull(promptText, playbook, completePrompt);
  return result.violation;
}

/**
 * Checks if a user prompt explicitly requests a prohibited technology/action
 * or requests an explicit deviation from an invariant or bypass of the playbook.
 */
export function checkPromptViolation(
  promptText: string,
  playbook: Playbook
): ViolationMatch | null {
  if (!promptText) return null;
  const lowerPrompt = promptText.toLowerCase();

  // 1. Check explicit bypass requests ("ignora el playbook", "no uses el playbook", "skip playbook")
  const bypassPattern =
    /\b(?:ignor(?:[aá]|ar|e)?|salte(?:[aá]|ar|ate|tate)?|omit(?:[eé]|ir)?|desestim(?:[aá]|ar)?|olvid(?:[aá]|ar|ate|[ií]date)?|prescind(?:[eé]|ir)?|no\s+(?:uses?|utilices?|seguir)|don't\s+use|bypass|skip|apagar|desactivar)\s+(?:de\s+|del\s+|el\s+|the\s+)?playbook\b|\b(?:hacelo|hazlo|hacer|do\s+it)?\s*(?:sin|without)\s+(?:el\s+|the\s+)?playbook\b/i;
  if (bypassPattern.test(lowerPrompt)) {
    const firstRule = playbook.invariants[0] || (playbook.neverRules && playbook.neverRules[0]);
    if (firstRule) {
      return {
        rule: firstRule,
        reason: 'El prompt solicita explícitamente ignorar las reglas del playbook.',
        source: firstRule.type,
        kind: 'playbook_bypass',
      };
    }
  }

  // 2. Check bypass attempts on Confirmation Checkpoints (Caso 21: "no preguntes", "sin consultar")
  const bypassCheckpoints =
    /\b(?:sin\s+(?:preguntar|consultar|confirmar|confirmaci[oó]n|pedir\s+confirmaci[oó]n)|no\s+(?:me\s+)?(?:preguntes|consultes|pidas\s+confirmaci[oó]n)|without\s+asking|don't\s+ask|no\s+confirm|without\s+confirm(?:ation)?|skip\s+confirm(?:ation)?|auto-confirm)\b/i;
  if (bypassCheckpoints.test(lowerPrompt)) {
    const isAgent = playbook.language === 'agents-preferences' || playbook.language === 'agents';
    const targetAsk =
      playbook.askRules[0] || (playbook.neverRules && playbook.neverRules[0]) || playbook.invariants[0];
    if (targetAsk) {
      return {
        rule: targetAsk,
        reason: isAgent
          ? 'El prompt intenta omitir un punto de control de gobernanza obligatorio ("sin consultar"). Las reglas de supervisión exigen confirmación interactiva obligatoria.'
          : `El prompt intenta forzar la implementación eludiendo el punto de control [${targetAsk.id.toUpperCase()}]. Se requiere confirmación interactiva.`,
        source: targetAsk.type,
        kind: 'checkpoint_bypass',
      };
    }
  }

  // Si el prompt es una consulta puramente exploratoria o teórica (preguntas de por qué, comparativas, migración de salida),
  // no debe tratarse como una orden de implementación que viole neverRules o invariants.
  if (isQueryOrExploratoryPrompt(promptText)) {
    return null;
  }

  // 3. Check Never Rules (Deliberate prohibitions and categorical targets)
  if (playbook.neverRules && playbook.neverRules.length > 0) {
    for (const never of playbook.neverRules) {
      // 3.1 ID subject with optional plurals
      const idSubject = never.id.toLowerCase().replace(/^(?:no-|never-|sin-)/, '').trim();

      if (idSubject && idSubject.length >= 3) {
        const idEscaped = idSubject.replace(/[\/\\^$*+?.()|[\]{}]/g, '\\$&');
        const regex = new RegExp(`\\b${idEscaped}(?:s|es)?\\b`, 'i');
        if (regex.test(lowerPrompt)) {
          return {
            rule: never,
            reason: `El prompt solicita usar "${idSubject}", prohibido por la regla [${never.id.toUpperCase()}].`,
            source: 'never',
            kind: 'prohibited_dependency',
          };
        }
      }

      // 3.2 Extract categorical alternative targets in parentheses (e.g. "(Chi, Echo, Fiber, Gorilla Mux)")
      const parenMatch = never.description.match(/\(([^)]+)\)/);
      if (parenMatch) {
        const tokens = parenMatch[1]
          .split(/[,;]|\bo\b|\by\b|\bor\b|\band\b/)
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean);
        for (const token of tokens) {
          const cleanToken = token.replace(/[^a-z0-9_\-\/\s]/g, '').trim().replace(/\s+/g, ' ');
          if (cleanToken.length >= 3 && !['etc', 'como', 'otros', 'otras', 'salvo', 'excepto'].includes(cleanToken)) {
            // Ignorar tokens de recomendación o exclusión dentro de paréntesis (ej: "usar net/http", "salvo testing")
            if (/\b(?:usar|usa|utilizar|salvo|excepto|permitid[oa]|recomendad[oa]|ver)\b/i.test(cleanToken)) {
              continue;
            }

            // Guard para evitar colisión de "echo" como sustantivo/verbo
            if (cleanToken === 'echo') {
              const isEchoFramework = /\b(?:con\s+echo|usando\s+echo|framework\s+echo|router\s+echo|labstack\/echo|echo\s+(?:framework|router))\b/i.test(lowerPrompt);
              if (!isEchoFramework) continue;
            }

            const tokenPattern = cleanToken.includes(' ')
              ? cleanToken.split(' ').map((p) => p.replace(/[\/\\^$*+?.()|[\]{}]/g, '\\$&')).join('\\s+')
              : cleanToken.replace(/[\/\\^$*+?.()|[\]{}]/g, '\\$&') + '(?:s|es)?';

            const tokenRegex = new RegExp(`\\b${tokenPattern}\\b`, 'i');
            if (tokenRegex.test(lowerPrompt)) {
              return {
                rule: never,
                reason: `El prompt solicita "${cleanToken}", vetado en la categoría de la regla [${never.id.toUpperCase()}].`,
                source: 'never',
                kind: 'prohibited_dependency',
              };
            }
          }
        }
      }

      // 3.3 Match words following keywords like "no usar", "prohibido", "evitar", "vetar"
      const matchWords = never.description.matchAll(
        /(?:no\s+usar|prohibido|evitar|vetar|alternativas?|(?:como|e\.g\.)(?:\s+por\s+ejemplo)?)\s+(?:el\s+framework\s+|la\s+librer[ií]a\s+|el\s+paquete\s+|el\s+orm\s+|el\s+router\s+)?([a-zA-Z0-9_\-\/]+)/gi
      );
      const stopWords = new Set([
        'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas',
        'cualquier', 'otros', 'otras', 'otro', 'otra',
        'por', 'para', 'de', 'del', 'con', 'en', 'ejemplo', 'ejemplos', 'salvo', 'excepto',
        'usar', 'uso', 'utilizar', 'utilices', 'meter', 'poner', 'agregar', 'instalar',
        'framework', 'frameworks', 'libreria', 'librerias', 'librería', 'librerías',
        'paquete', 'paquetes', 'herramienta', 'herramientas', 'modulo', 'modulos', 'módulo', 'módulos',
        'externo', 'externos', 'externa', 'externas', 'pesado', 'pesados', 'pesada', 'pesadas'
      ]);
      for (const m of matchWords) {
        const targetWord = m[1].toLowerCase();
        if (targetWord.length >= 3 && !stopWords.has(targetWord)) {
          const targetEscaped = targetWord.replace(/[\/\\^$*+?.()|[\]{}]/g, '\\$&');
          const regex = new RegExp(`\\b${targetEscaped}(?:s|es)?\\b`, 'i');
          if (regex.test(lowerPrompt)) {
            return {
              rule: never,
              reason: `El prompt solicita "${targetWord}", prohibido por la regla [${never.id.toUpperCase()}].`,
              source: 'never',
              kind: 'prohibited_dependency',
            };
          }
        }
      }

      // 3.4 Categorical Family Prohibitions (e.g. Gin banned + net/http required -> bans Chi, Echo, Fiber, etc.)
      const descLower = (never.description || '').toLowerCase();
      const reasonsLower = (never.reason || '').toLowerCase();
      const mentionsStdlib =
        descLower.includes('biblioteca estándar') ||
        descLower.includes('biblioteca estandar') ||
        descLower.includes('stdlib') ||
        descLower.includes('standard library') ||
        descLower.includes('net/http') ||
        descLower.includes('node:http') ||
        descLower.includes('http.server') ||
        descLower.includes('sql puro') ||
        descLower.includes('acceso sql explícito') ||
        descLower.includes('funciones nativas') ||
        reasonsLower.includes('stdlib');

      for (const [key, fam] of Object.entries(TECHNOLOGY_FAMILIES)) {
        const matchesKey =
          never.id.toLowerCase().includes(key) ||
          descLower.includes(key) ||
          idSubject === key;

        if (matchesKey) {
          // Si la regla exige stdlib, o veta la categoría ("otros orm", "otros frameworks", etc.)
          if (
            mentionsStdlib ||
            descLower.includes('otros orm') ||
            descLower.includes('otros frameworks') ||
            descLower.includes('otro framework') ||
            descLower.includes('cualquier orm')
          ) {
            for (const member of fam.members) {
              if (member === key) continue; // ya evaluado en 3.1

              // Exclusiones de contexto para falsos positivos de palabras comunes:
              // a) "echo": Si se usa como sustantivo o verbo en inglés ("hacer echo", "echo payload", "echo endpoint")
              if (member === 'echo') {
                const isEchoFramework = /\b(?:con\s+echo|usando\s+echo|framework\s+echo|router\s+echo|labstack\/echo|echo\s+(?:framework|router))\b/i.test(lowerPrompt);
                if (!isEchoFramework) continue;
              }

              const memberEscaped = member.replace(/[\/\\^$*+?.()|[\]{}]/g, '\\$&');
              const memberRegex = new RegExp(`\\b${memberEscaped}(?:s|es)?\\b`, 'i');
              if (memberRegex.test(lowerPrompt)) {
                return {
                  rule: never,
                  reason: `El prompt solicita "${member}", vetado por la regla [${never.id.toUpperCase()}] al pertenecer a la categoría de ${fam.description}.`,
                  source: 'never',
                  kind: 'prohibited_dependency',
                };
              }
            }
          }
        }
      }
    }
  }

  // 4. Check Invariant Surface Deviations (e.g. prompt specifies an unauthorized folder or pattern)
  for (const inv of playbook.invariants) {
    const desc = inv.description.toLowerCase();
    if (inv.surface) {
      const forbiddenPathPhrases: Array<{ regex: RegExp; forbiddenInDesc: string }> = [
        { regex: /\b(?:en\s+main\.go|en\s+la\s+ra[ií]z)\b/i, forbiddenInDesc: 'en main.go' },
        { regex: /\b(?:en\s+main\.py)\b/i, forbiddenInDesc: 'en main.py' },
        { regex: /\b(?:en\s+src\/index\.ts|en\s+index\.ts)\b/i, forbiddenInDesc: 'en src/index.ts' },
        { regex: /\b(?:en\s+pkg[\w\/-]*)\b/i, forbiddenInDesc: 'ni en pkg/' },
        { regex: /\b(?:en\s+cmd[\w\/-]*)\b/i, forbiddenInDesc: 'ni en cmd/' },
        { regex: /\b(?:en\s+src\/routes[\w\/-]*)\b/i, forbiddenInDesc: 'src/routes' },
        { regex: /\b(?:en\s+src\/controllers[\w\/-]*)\b/i, forbiddenInDesc: 'src/controllers' },
        { regex: /\b(?:en\s+app\/views[\w\/-]*)\b/i, forbiddenInDesc: 'app/views' },
        { regex: /\b(?:en\s+app\/api[\w\/-]*)\b/i, forbiddenInDesc: 'app/api' },
        { regex: /\b(?:en\s+internal\/core[\w\/-]*)\b/i, forbiddenInDesc: 'internal/core' },
      ];

      for (const phrase of forbiddenPathPhrases) {
        if (phrase.regex.test(lowerPrompt) && desc.includes(phrase.forbiddenInDesc)) {
          return {
            rule: inv,
            reason: `El prompt solicita colocar código fuera de la superficie autorizada "${inv.surface}".`,
            source: 'invariant',
            kind: 'surface_conflict',
          };
        }
      }

      // 4.2 Prohibición de modelar dominio con class (FP)
      if (desc.includes('no modelar el dominio con class') || desc.includes('no modelar con class')) {
        const mentionsClass = /\b(?:class\s+\w+|con\s+class|usando\s+class)\b/i.test(lowerPrompt);
        if (mentionsClass) {
          return {
            rule: inv,
            reason: `El prompt solicita modelar con "class", prohibido por la regla de programación funcional [${inv.id.toUpperCase()}].`,
            source: 'invariant',
            kind: 'surface_conflict',
          };
        }
      }
    }
  }

  return null;
}

/**
 * Checks if a file path proposed for write or edit violates any invariant or topology restriction.
 * Resolves path traversal (../), absolute paths, Windows backslashes, and whitespace padding canonically.
 */
export function checkPathViolation(
  filePath: string,
  playbook: Playbook,
  cwd?: string
): ViolationMatch | null {
  if (typeof filePath !== 'string' || !filePath.trim()) return null;
  const cleanPath = filePath.trim();

  // Canonicalize relative to cwd if absolute path provided
  const baseCwd = cwd || process.cwd();
  const relPath = path.isAbsolute(cleanPath)
    ? path.relative(baseCwd, cleanPath)
    : cleanPath;

  // Normalize path traversal (e.g. internal/ports/../../pkg/ -> pkg/)
  const normalized = path.normalize(relPath).replace(/\\/g, '/').replace(/^\.?\//, '');

  const invariants = playbook?.invariants || [];
  const neverRules = playbook?.neverRules || [];

  // Afinidad dinámica de superficies: recolectar todas las superficies declaradas en el playbook
  const otherDeclaredSurfaces = invariants
    .map((other) => other.surface)
    .filter(Boolean)
    .flatMap((s) => s.split(',').map((p) => p.trim().replace(/^\.?\//, '').replace(/\/$/, '')))
    .filter(Boolean);

  for (const inv of invariants) {
    const desc = (inv.description || '').toLowerCase();
    if (!inv.surface) continue;

    const allowedPrefixes = inv.surface
      .split(',')
      .map((s) => s.trim().replace(/^\.?\//, '').replace(/\/$/, ''))
      .filter(Boolean);

    if (allowedPrefixes.length === 0) continue;

    const isExclusiveRule =
      desc.includes('exclusivamente en') ||
      desc.includes('exclusivo en') ||
      desc.includes('only in') ||
      desc.includes('no crear handlers en') ||
      desc.includes('viven exclusivamente') ||
      desc.includes('solo en');

    if (!isExclusiveRule) continue;

    // Verificar si es un archivo de código relevante
    const isSourceCode = /\.(?:go|ts|tsx|js|jsx|py|rs|java|c|cpp|rb|php)$/i.test(normalized);
    if (!isSourceCode) continue;

    const isAllowed = allowedPrefixes.some(
      (prefix) => normalized === prefix || normalized.startsWith(prefix + '/')
    );
    if (isAllowed) continue;

    // Extraer menciones explícitas de rutas vetadas en la descripción (ej: "no crear en main.go ni en pkg/ ni en cmd/")
    const forbiddenMentions = Array.from(
      desc.matchAll(/(?:no\s+crear|no\s+escribir|no\s+poner|ni\s+en|no\s+en)\s+([a-zA-Z0-9_\-\.\/]+)/gi)
    ).map((m) => m[1].toLowerCase().replace(/^\.?\//, '').replace(/\/$/, ''));

    const isExplicitlyForbiddenHere = forbiddenMentions.some((f) => {
      const cleanF = f.replace(/\/$/, '');
      return normalized === cleanF || normalized.startsWith(cleanF + '/') || (cleanF.includes('.') && normalized.endsWith(cleanF));
    });

    // 1. Si escribe en una ruta explícitamente vetada por la regla en su texto
    if (isExplicitlyForbiddenHere) {
      return {
        rule: inv,
        reason: `La ruta "${normalized}" escribe en una ubicación prohibida por la regla [${inv.id.toUpperCase()}].`,
        source: 'invariant',
        kind: 'surface_conflict',
      };
    }

    // 3. Evaluar si pertenece a OTRA capa arquitectónica declarada en el playbook
    const belongsToOtherDeclaredLayer = otherDeclaredSurfaces
      .filter((otherSurface) => !allowedPrefixes.includes(otherSurface))
      .some((otherSurface) => normalized === otherSurface || normalized.startsWith(otherSurface + '/'));

    if (belongsToOtherDeclaredLayer) {
      // Pertenece legítimamente a otra capa de la arquitectura (evita deadlock de JD-B-001)
      continue;
    }

    // 4. Si no está en otra capa declarada, verificar si el archivo coincide con el scope dinámico de la regla
    const scopeTokens = `${inv.surface} ${inv.title} ${desc.split('.')[0]}`
      .toLowerCase()
      .split(/[\/,\s_.-]+/)
      .filter((t) => t.length >= 3 && !['internal', 'src', 'app', 'pkg', 'lib', 'los', 'las', 'del', 'para', 'con', 'una', 'uno'].includes(t));

    const isHttpTransportRule = scopeTokens.some((t) => t.includes('handler') || t.includes('port') || t.includes('http') || t.includes('transport'));

    const matchesScope =
      scopeTokens.some((t) => normalized.toLowerCase().includes(t)) ||
      (isHttpTransportRule && /(?:handler|controller|route|endpoint|http|server|transport|api)/i.test(normalized)) ||
      !normalized.includes('/');

    if (matchesScope) {
      return {
        rule: inv,
        reason: `La ruta "${normalized}" viola la ubicación exclusiva en "${inv.surface}".`,
        source: 'invariant',
        kind: 'surface_conflict',
      };
    }
  }

  // Check Never Rules for surface restrictions
  for (const never of neverRules) {
    if (never.surface && never.surface !== 'general' && never.surface !== 'dependencies') {
      const forbiddenSurfaces = never.surface
        .split(',')
        .map((s) => s.trim().replace(/^\.?\//, '').replace(/\/$/, ''))
        .filter(Boolean);

      for (const forbiddenSurface of forbiddenSurfaces) {
        const isForbidden = normalized === forbiddenSurface || normalized.startsWith(forbiddenSurface + '/');
        if (isForbidden) {
          return {
            rule: never,
            reason: `La ruta "${normalized}" escribe dentro de la superficie prohibida "${never.surface}".`,
            source: 'never',
            kind: 'surface_conflict',
          };
        }
      }
    }
  }

  return null;
}

/**
 * Evaluates whether a user prompt triggers a conditional AskRule in the playbook.
 * Honors anti-triggers (e.g. health checks, authenticated routes, pure functions, simple SQL),
 * checks for trigger keywords/patterns, and ignores if the decision was already explicitly made.
 */
export function checkAskTrigger(
  promptText: string,
  playbook: Playbook
): AskTriggerMatch | null {
  if (!promptText || !playbook?.askRules || playbook.askRules.length === 0) return null;
  const lowerPrompt = promptText.toLowerCase();

  for (const ask of playbook.askRules) {
    const trigger = (ask.trigger || '').toLowerCase();
    const antiTrigger = (ask.antiTrigger || '').toLowerCase();

    // 1. Anti-trigger evaluation
    if (antiTrigger) {
      // Health checks
      const isHealth = /\b(?:health|healthz|salud|ping)\b/i.test(lowerPrompt);
      if (isHealth && (antiTrigger.includes('health') || antiTrigger.includes('health checks'))) {
        continue;
      }

      // Rutas autenticadas, tokens, bearer, me
      // Excluir endpoints de emisión de credenciales (login, signup, register, oauth, token) para no suprimir falsamente los asks públicos
      const isCredentialIssuing = /\b(?:login|signup|register|registro|iniciar\s+sesi[oó]n|oauth|token)\b/i.test(lowerPrompt);
      const isAuth =
        !isCredentialIssuing &&
        /\b(?:autenticad[oa]s?|bearer|jwt|token|auth|privad[oa]s?|intern[ao]s?|\/me)\b/i.test(lowerPrompt);
      if (isAuth && (antiTrigger.includes('autenticad') || antiTrigger.includes('internas') || antiTrigger.includes('authenticated'))) {
        continue;
      }

      // Funciones puras (FP)
      const isPure = /\b(?:funciones?\s+puras?|pure\s+functions?|funci[oó]n\s+pura)\b/i.test(lowerPrompt);
      if (isPure && antiTrigger.includes('pura')) {
        continue;
      }

      // Consultas SQL simples de lectura/escritura (que no migran esquema)
      const isSimpleSql =
        /\b(?:select|insert|update|delete|leer|guardar|fetch|buscar|usuario|users)\b/i.test(lowerPrompt) &&
        !/\b(?:migra(?:r|ci[oó]n|ciones)|schema|esquema|create\s+table|alter\s+table)\b/i.test(lowerPrompt);
      if (isSimpleSql && antiTrigger.includes('consultas sql')) {
        continue;
      }
    }

    // 2. Si el prompt ya tomó la decisión explícita (aprobó o declinó el extra específico)
    const explicitApproval = /\b(?:con\s+(?:rate\s*limit|ratelimit|x-request-id|cors|goose)|con\s+la\s+receta\s+de\s+migraciones)\b/i.test(lowerPrompt);
    const explicitDecline = /\b(?:sin\s+(?:rate\s*limit|ratelimit|x-request-id|cors|goose)|sin\s+herramienta\s+de\s+migraciones)\b/i.test(lowerPrompt);

    if (explicitApproval || explicitDecline) {
      continue;
    }

    // 3. Evaluar si activa el Trigger
    let matchesTrigger = false;

    // a) Ejemplos entre paréntesis en el trigger (e.g. "POST /login o POST /register", "goose, golang-migrate")
    const examplesMatch = trigger.match(/\((?:por ejemplo\s+|e\.g\.\s+)?([^)]+)\)/i);
    if (examplesMatch) {
      const examples = examplesMatch[1].split(/[,;/]|\bo\b|\bor\b/).map((s) => s.trim().toLowerCase());
      for (const ex of examples) {
        if (ex && ex.length >= 3 && lowerPrompt.includes(ex)) {
          matchesTrigger = true;
          break;
        }
      }
    }

    // b) Patrones específicos de cada tipo de Ask
    // HTTP: rutas públicas no autenticadas (login, signup, register, público)
    if (
      !matchesTrigger &&
      (trigger.includes('públic') ||
        trigger.includes('public') ||
        trigger.includes('autenticación') ||
        trigger.includes('authentication'))
    ) {
      const isPublicEndpoint = /\b(?:login|signup|register|registro|iniciar\s+sesi[oó]n|p[uú]blic[ao]s?)\b/i.test(
        lowerPrompt
      );
      if (isPublicEndpoint) {
        matchesTrigger = true;
      }
    }

    // Migraciones de esquema
    if (
      !matchesTrigger &&
      (trigger.includes('migra') || trigger.includes('esquema') || trigger.includes('schema'))
    ) {
      const isMigration = /\b(?:migra(?:r|ci[oó]n|ciones)|goose|golang-migrate|migrate|flyway|liquibase)\b/i.test(
        lowerPrompt
      );
      if (isMigration) {
        matchesTrigger = true;
      }
    }

    // Store mutable compartido
    if (
      !matchesTrigger &&
      (trigger.includes('mutable') ||
        trigger.includes('store') ||
        trigger.includes('singleton') ||
        trigger.includes('estado'))
    ) {
      const isMutable = /\b(?:store\s+global|estado\s+mutable|singleton|shared\s+state|global\s+state|let\s+\w+\s*=)\b/i.test(
        lowerPrompt
      );
      if (isMutable) {
        matchesTrigger = true;
      }
    }

    // c) Mención de keywords de prompt o trigger
    if (!matchesTrigger && ask.prompt) {
      const pLow = ask.prompt.toLowerCase();
      if (pLow.includes('rate limit') && /\brate\s*limit\b/i.test(lowerPrompt)) matchesTrigger = true;
      if (pLow.includes('x-request-id') && /\brequest[\s-]?id\b/i.test(lowerPrompt)) matchesTrigger = true;
      if (pLow.includes('cors') && /\bcors\b/i.test(lowerPrompt)) matchesTrigger = true;
      if (pLow.includes('migraciones') && /\bmigra/i.test(lowerPrompt)) matchesTrigger = true;
    }

    if (matchesTrigger) {
      return {
        rule: ask,
        prompt: ask.prompt,
        defaultAction: ask.defaultAction || 'No aplicar',
      };
    }
  }

  return null;
}
