import {
  Playbook,
  InvariantRule,
  AskRule,
  NeverRule,
  Snippet,
} from './schema.js';
import {
  PlaybookDiffResult,
  InvariantDiff,
  AskDiff,
  NeverDiff,
  SnippetDiff,
  computePlaybookDiff,
} from './diff.js';
import { serializePlaybook } from './parser.js';

export interface SemanticDiffItemVerdict {
  incomingId: string;
  status: 'IDENTICAL' | 'NEW' | 'CONFLICT';
  existingId?: string;
  reason?: string;
}

export interface SemanticDiffResponse {
  invariants?: SemanticDiffItemVerdict[];
  askRules?: SemanticDiffItemVerdict[];
  neverRules?: SemanticDiffItemVerdict[];
  snippets?: SemanticDiffItemVerdict[];
}

export function buildSemanticDiffPrompt(
  incoming: Playbook,
  existing: Playbook
): string {
  return `# Misión: Arbitraje Semántico de Reglas Arquitectónicas (Playbook Diff)

Lenguaje: ${incoming.language}

Eres un arquitecto de software senior. Compara semánticamente dos playbooks de arquitectura: el que el usuario ya tiene guardado y el nuevo borrador extraído de un repositorio.
Tu meta es evitar duplicados, redundancias y contradicciones, identificando qué reglas dicen lo mismo en la práctica (aunque usen palabras distintas).

## 1. PLAYBOOK EXISTENTE DEL USUARIO (Guardado actualmente)
\`\`\`markdown
${serializePlaybook(existing)}
\`\`\`

## 2. NUEVO BORRADOR EXTRAÍDO (Propuesta de normas)
\`\`\`markdown
${serializePlaybook(incoming)}
\`\`\`

## INSTRUCCIONES DE COMPARACIÓN
Para cada regla en el NUEVO BORRADOR:
1. "IDENTICAL": Dice exactamente lo mismo que una regla existente (literalmente equivalente).
2. "CONFLICT": Hay redundancia semántica (ambas dicen la misma regla con diferentes palabras), o una contradice, altera la surface o propone un enfoque alternativo a una regla existente.
   - Debes indicar en "existingId" el ID exacto de la regla existente con la que choca o duplica.
   - En "reason" explica brevemente el motivo semántico (ej: "Redundancia semántica: ambas prohíben tipos any en interfaces").
3. "NEW": Es un concepto o patrón nuevo que no está cubierto por ninguna regla existente.

Responde ÚNICAMENTE un bloque JSON válido con este formato:
\`\`\`json
{
  "invariants": [
    { "incomingId": "id-en-borrador", "status": "IDENTICAL" | "NEW" | "CONFLICT", "existingId": "id-existente-opcional", "reason": "motivo si es conflict" }
  ],
  "askRules": [
    { "incomingId": "id-en-borrador", "status": "IDENTICAL" | "NEW" | "CONFLICT", "existingId": "id-existente-opcional", "reason": "motivo si es conflict" }
  ],
  "neverRules": [
    { "incomingId": "id-en-borrador", "status": "IDENTICAL" | "NEW" | "CONFLICT", "existingId": "id-existente-opcional", "reason": "motivo si es conflict" }
  ],
  "snippets": [
    { "incomingId": "id-en-borrador", "status": "IDENTICAL" | "NEW" | "CONFLICT", "existingId": "id-existente-opcional", "reason": "motivo si es conflict" }
  ]
}
\`\`\`
`;
}

export function parseSemanticDiffResponse(raw: string): SemanticDiffResponse | null {
  try {
    const jsonMatch = raw.match(/```json([\s\S]*?)```/) || raw.match(/```([\s\S]*?)```/);
    const toParse = jsonMatch ? jsonMatch[1].trim() : raw.trim();
    return JSON.parse(toParse);
  } catch {
    return null;
  }
}

function findExistingRule<T extends { id: string; title?: string; description?: string }>(
  list: T[],
  candidateId?: string
): T | undefined {
  if (!candidateId) return undefined;
  const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const target = clean(candidateId);

  // 1. Exact or normalized ID match
  let found = list.find((e) => e.id === candidateId || clean(e.id) === target);
  if (found) return found;

  // 2. Title match
  found = list.find((e) => e.title && clean(e.title) === target);
  if (found) return found;

  // 3. Substring match in title
  found = list.find(
    (e) => e.title && (clean(e.title).includes(target) || target.includes(clean(e.title)))
  );
  if (found) return found;

  return undefined;
}

export async function computeSemanticPlaybookDiff(
  incoming: Playbook,
  existing: Playbook | null,
  completePrompt?: (prompt: string) => Promise<string>
): Promise<PlaybookDiffResult> {
  if (!existing) {
    return computePlaybookDiff(incoming, null);
  }

  if (!completePrompt) {
    throw new Error('Ha habido un problema con tu agente, reintenta.');
  }

  try {
    const prompt = buildSemanticDiffPrompt(incoming, existing);
    const rawResponse = await completePrompt(prompt);
    const parsed = parseSemanticDiffResponse(rawResponse);

    if (!parsed) {
      throw new Error('Respuesta no estructurada');
    }

    const topologyChanged =
      incoming.topology.pattern !== existing.topology.pattern ||
      incoming.topology.directories.some((d) => !existing.topology.directories.includes(d));

    // 1. Invariants
    const invariantDiffs: InvariantDiff[] = [];
    const invVerdicts = parsed.invariants || [];
    for (const inc of incoming.invariants) {
      const v = invVerdicts.find((x) => x.incomingId === inc.id);
      if (v && v.status === 'IDENTICAL') {
        const match = findExistingRule(existing.invariants, v.existingId) ||
          findExistingRule(existing.invariants, inc.id);
        invariantDiffs.push({ status: 'identical', incoming: inc, existing: match });
      } else if (v && v.status === 'CONFLICT') {
        const match = findExistingRule(existing.invariants, v.existingId) ||
          findExistingRule(existing.invariants, inc.id);
        invariantDiffs.push({
          status: 'conflict',
          incoming: inc,
          existing: match,
          reason: v.reason || 'Conflicto o redundancia semántica detectada',
        });
      } else {
        // NEW or unlisted
        invariantDiffs.push({ status: 'new', incoming: inc });
      }
    }

    // 2. Ask Rules
    const askDiffs: AskDiff[] = [];
    const askVerdicts = parsed.askRules || [];
    for (const inc of incoming.askRules) {
      const v = askVerdicts.find((x) => x.incomingId === inc.id);
      if (v && v.status === 'IDENTICAL') {
        const match = findExistingRule(existing.askRules, v.existingId) ||
          findExistingRule(existing.askRules, inc.id);
        askDiffs.push({ status: 'identical', incoming: inc, existing: match });
      } else if (v && v.status === 'CONFLICT') {
        const match = findExistingRule(existing.askRules, v.existingId) ||
          findExistingRule(existing.askRules, inc.id);
        askDiffs.push({
          status: 'conflict',
          incoming: inc,
          existing: match,
          reason: v.reason || 'Conflicto o redundancia semántica detectada',
        });
      } else {
        askDiffs.push({ status: 'new', incoming: inc });
      }
    }

    // 3. Never Rules
    const neverDiffs: NeverDiff[] = [];
    const neverVerdicts = parsed.neverRules || [];
    const incNever = incoming.neverRules || [];
    const existNever = existing.neverRules || [];
    for (const inc of incNever) {
      const v = neverVerdicts.find((x) => x.incomingId === inc.id);
      if (v && v.status === 'IDENTICAL') {
        const match = findExistingRule(existNever, v.existingId) ||
          findExistingRule(existNever, inc.id);
        neverDiffs.push({ status: 'identical', incoming: inc, existing: match });
      } else if (v && v.status === 'CONFLICT') {
        const match = findExistingRule(existNever, v.existingId) ||
          findExistingRule(existNever, inc.id);
        neverDiffs.push({
          status: 'conflict',
          incoming: inc,
          existing: match,
          reason: v.reason || 'Conflicto o redundancia semántica detectada',
        });
      } else {
        neverDiffs.push({ status: 'new', incoming: inc });
      }
    }

    // 4. Snippets
    const snippetDiffs: SnippetDiff[] = [];
    const snippetVerdicts = parsed.snippets || [];
    for (const inc of incoming.snippets) {
      const v = snippetVerdicts.find((x) => x.incomingId === inc.id);
      if (v && v.status === 'IDENTICAL') {
        const match = findExistingRule(existing.snippets, v.existingId) ||
          findExistingRule(existing.snippets, inc.id);
        snippetDiffs.push({ status: 'identical', incoming: inc, existing: match });
      } else if (v && v.status === 'CONFLICT') {
        const match = findExistingRule(existing.snippets, v.existingId) ||
          findExistingRule(existing.snippets, inc.id);
        snippetDiffs.push({
          status: 'conflict',
          incoming: inc,
          existing: match,
          reason: v.reason || 'Divergencia de código en snippet',
        });
      } else {
        snippetDiffs.push({ status: 'new', incoming: inc });
      }
    }

    const allDiffs = [...invariantDiffs, ...askDiffs, ...neverDiffs, ...snippetDiffs];
    const newRules = allDiffs.filter((d) => d.status === 'new').length;
    const identicalRules = allDiffs.filter((d) => d.status === 'identical').length;
    const conflictRules = allDiffs.filter((d) => d.status === 'conflict').length;

    return {
      language: incoming.language,
      topologyChanged,
      incomingTopology: incoming.topology,
      existingTopology: existing.topology,
      invariants: invariantDiffs,
      askRules: askDiffs,
      neverRules: neverDiffs,
      snippets: snippetDiffs,
      stats: {
        newRules,
        identicalRules,
        conflictRules,
      },
    };
  } catch {
    throw new Error('Ha habido un problema con tu agente, reintenta.');
  }
}

export interface AIRuleResolutionResult {
  title: string;
  surface: string;
  description: string;
  prompt?: string;
  trigger?: string;
}

export async function resolveConflictWithAI(params: {
  ruleType: string;
  language: string;
  existingRule: any;
  incomingRule: any;
  userInstruction: string;
  completePrompt: (prompt: string) => Promise<string>;
}): Promise<AIRuleResolutionResult> {
  const { ruleType, language, existingRule, incomingRule, userInstruction, completePrompt } = params;

  const prompt = `# Misión: Fusión y Resolución Asistida de Conflicto de Regla

Eres un arquitecto de software experto en ${language}.
El usuario tiene dos versiones de una regla arquitectónica (${ruleType}) y te dio una instrucción específica para fusionarlas, refinarlas o resolver el conflicto.

## VERSIÓN A (Existente en Playbook):
- Título: ${existingRule?.title || 'N/A'}
- Surface: ${existingRule?.surface || 'N/A'}
- Descripción/Regla: ${existingRule?.description || existingRule?.prompt || existingRule?.code || 'N/A'}

## VERSIÓN B (Propuesta por el Extract):
- Título: ${incomingRule?.title || 'N/A'}
- Surface: ${incomingRule?.surface || 'N/A'}
- Descripción/Regla: ${incomingRule?.description || incomingRule?.prompt || incomingRule?.code || 'N/A'}

## INSTRUCCIÓN DEL USUARIO:
"${userInstruction}"

## INSTRUCCIONES
Genera la regla unificada final que cumpla con la directiva del usuario.
Responde ÚNICAMENTE en JSON con los campos resultantes:
\`\`\`json
{
  "title": "Título claro de la regla",
  "surface": "ruta/directorio de aplicación",
  "description": "Redacción técnica precisa de la norma resultante"
}
\`\`\`
`;

  const raw = await completePrompt(prompt);
  try {
    const jsonMatch = raw.match(/```json([\s\S]*?)```/) || raw.match(/```([\s\S]*?)```/);
    const toParse = jsonMatch ? jsonMatch[1].trim() : raw.trim();
    const parsed = JSON.parse(toParse);
    return {
      title: parsed.title || incomingRule?.title || existingRule?.title || 'Regla sintetizada',
      surface: parsed.surface || existingRule?.surface || incomingRule?.surface || '',
      description: parsed.description || userInstruction,
    };
  } catch {
    return {
      title: existingRule?.title || incomingRule?.title || 'Regla resuelta',
      surface: existingRule?.surface || incomingRule?.surface || '',
      description: userInstruction,
    };
  }
}
