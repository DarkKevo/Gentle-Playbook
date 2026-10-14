import * as path from 'node:path';
import { PlaybookStorage } from './storage.js';
import {
  Playbook,
  InvariantRule,
  AskRule,
  NeverRule,
  RuleType,
} from './schema.js';
import { detectActiveStacks } from './stack-detector.js';
import { heuristicFallbackStack } from './stack-synthesizer.js';
import { findCollidingRules } from './stack-handler.js';
import { detectPromptInjection } from './security.js';

export interface ExtractTriageOptions {
  draft: Playbook;
  detectedLang: string;
  projectPath: string;
  storage: PlaybookStorage;
  ctx: any;
  pi: any;
  completePrompt: (prompt: string) => Promise<string>;
  autoConfirm?: boolean;
}

export interface TriageSummary {
  savedToGlobal: number;
  savedToStack: Record<string, number>;
  savedToProject: number;
  modified: number;
  discarded: number;
}

type AnyRule = InvariantRule | AskRule | NeverRule;

interface TriageItem {
  type: RuleType;
  rule: AnyRule;
}

/**
 * Ejecuta el wizard de Triage interactivo 1 a 1 para clasificar y procesar
 * las reglas extraídas por el explorador de esencia.
 */
export async function runExtractTriage(
  options: ExtractTriageOptions
): Promise<TriageSummary> {
  const {
    draft,
    detectedLang,
    projectPath,
    storage,
    ctx,
    pi,
    completePrompt,
    autoConfirm,
  } = options;

  const summary: TriageSummary = {
    savedToGlobal: 0,
    savedToStack: {},
    savedToProject: 0,
    modified: 0,
    discarded: 0,
  };

  // Recolectar todas las reglas a procesar
  const items: TriageItem[] = [];
  for (const inv of draft.invariants || []) {
    items.push({ type: 'invariant', rule: { ...inv } });
  }
  for (const ask of draft.askRules || []) {
    items.push({ type: 'ask', rule: { ...ask } });
  }
  for (const nev of draft.neverRules || []) {
    items.push({ type: 'never', rule: { ...nev } });
  }

  if (items.length === 0) {
    ctx.ui?.notify('No se detectaron nuevas reglas para clasificar.', 'info');
    return summary;
  }

  // Fail-safe: Sin confirmación interactiva y sin --yes, no se escribe en disco
  if (!ctx.ui?.confirm && !autoConfirm) {
    ctx.ui?.notify(
      'Extracción completada sin guardar: se requiere confirmación interactiva o el flag --yes para escribir en disco.',
      'warning'
    );
    pi.sendMessage?.({
      customType: 'gentle-playbook-draft',
      content: `⚠️ **Extracción finalizada (Solo Lectura):**\nNo hay interfaz interactiva de confirmación y no se pasó \`--yes\`. No se modificó el disco.`,
      display: true,
    });
    return summary;
  }

  // Si hay confirmación interactiva, consultar al usuario si desea proceder
  if (ctx.ui?.confirm) {
    const confirmed = await ctx.ui.confirm(
      'Aprobar guardado de playbook',
      `¿Deseas clasificar y guardar las ${items.length} reglas extraídas para ${detectedLang}?`
    );
    if (!confirmed) {
      ctx.ui?.notify('Guardado cancelado por el usuario. No se modificó el playbook en disco.', 'info');
      return summary;
    }
  }

  // Modo desatendido / Headless / autoConfirm o sin select: guardar en Global como fallback
  if (!ctx.ui?.select || autoConfirm) {
    let globalPb = await storage.getPlaybook(detectedLang);
    if (!globalPb) {
      globalPb = {
        language: detectedLang,
        scope: 'global',
        version: 1,
        updatedAt: new Date().toISOString().split('T')[0],
        topology: draft.topology || { pattern: 'Standard Layout', directories: ['src/'] },
        invariants: [],
        askRules: [],
        snippets: [],
      };
    }
    for (const item of items) {
      upsertRuleInPlaybook(globalPb, item.rule);
      summary.savedToGlobal++;
    }
    globalPb.version += 1;
    globalPb.updatedAt = new Date().toISOString().split('T')[0];
    await storage.savePlaybook(globalPb);
    ctx.ui?.notify(`Playbook para ${detectedLang} actualizado: ${summary.savedToGlobal} nuevas.`, 'info');
    return summary;
  }

  // Pre-cargar stacks activos para sugerencias inteligentes
  const allStackSlugs = await storage.listStacks();
  const allStackPbs: Playbook[] = [];
  for (const sSlug of allStackSlugs) {
    const sPb = await storage.getStack(sSlug);
    if (sPb) allStackPbs.push(sPb);
  }
  const activeStacks = await detectActiveStacks(projectPath, allStackPbs);

  ctx.ui?.notify(`Iniciando Triage Interactivo de ${items.length} regla(s)...`, 'info');

  // Procesar regla por regla (1 a 1)
  for (let idx = 0; idx < items.length; idx++) {
    let currentItem = items[idx];
    let resolved = false;

    // Loop interno para permitir modificar regla y volver a presentar opciones
    while (!resolved) {
      const r = currentItem.rule;
      const typeLabel =
        currentItem.type === 'invariant'
          ? '🛡️ NORMATIVA'
          : currentItem.type === 'ask'
          ? '❓ ASK CHECKPOINT'
          : '🚫 PROHIBICIÓN (NEVER)';

      const rulePresentation =
        `[${typeLabel} — Regla ${idx + 1} de ${items.length}]\n` +
        `ID: \`${r.id}\`\n` +
        `Título: ${r.title}\n` +
        `Surface: \`${r.surface}\`\n` +
        `Descripción: ${r.description}` +
        (currentItem.type === 'never' && (r as NeverRule).reason
          ? `\nMotivo: ${(r as NeverRule).reason}`
          : '');

      pi.sendMessage?.({
        customType: 'gentle-playbook-triage-card',
        content: `### 📋 Regla ${idx + 1} de ${items.length} en Triage\n\n${rulePresentation}`,
        display: true,
      });

      const triageChoice = await ctx.ui.select(
        `Regla [${r.id}]: ¿Dónde deseas procesarla?`,
        [
          `🌐 1. Global (Lenguaje: ${detectedLang.toUpperCase()})`,
          `📦 2. Stack Tecnológico (Framework / Librerías)`,
          `🏠 3. Proyecto Local (playbook.md en este repositorio)`,
          `✏️ 4. Modificar regla (ajustar con IA)`,
          `🗑️ 5. Descartar regla`,
        ]
      );

      // Si el usuario canceló la selección, omitir esta regla limpiamente (sin bucle infinito)
      if (!triageChoice) {
        summary.discarded++;
        resolved = true;
        ctx.ui?.notify(`Regla [${r.id}] omitida.`, 'info');
        break;
      }

      // --- 1. GLOBAL ---
      if (triageChoice.includes('Global')) {
        let globalPb = await storage.getPlaybook(detectedLang);
        if (!globalPb) {
          globalPb = {
            language: detectedLang,
            scope: 'global',
            version: 1,
            updatedAt: new Date().toISOString().split('T')[0],
            topology: draft.topology || { pattern: 'Standard Layout', directories: ['src/'] },
            invariants: [],
            askRules: [],
            snippets: [],
          };
        }

        const proceed = await resolveLayerConflictIfNeeded(
          `GLOBAL: ${detectedLang.toUpperCase()}`,
          globalPb,
          r,
          ctx,
          pi
        );
        if (proceed) {
          upsertRuleInPlaybook(globalPb, r);
          globalPb.version += 1;
          globalPb.updatedAt = new Date().toISOString().split('T')[0];
          await storage.savePlaybook(globalPb);
          summary.savedToGlobal++;
          ctx.ui?.notify(`✓ Regla [${r.id}] guardada en Global (${detectedLang.toUpperCase()})`, 'info');
        } else {
          summary.discarded++;
        }
        resolved = true;
        break;
      }

      // --- 2. STACK ---
      if (triageChoice.includes('Stack')) {
        let chosenStackSlug = '';

        const stackOptions: string[] = [];
        if (activeStacks.length > 0) {
          for (const s of activeStacks) {
            stackOptions.push(`⭐ Activo: ${s.stackName || s.stackId} (\`${s.stackId}\`)`);
          }
        }
        for (const sSlug of allStackSlugs) {
          if (!activeStacks.some((as) => as.stackId === sSlug)) {
            stackOptions.push(`📦 ${sSlug}`);
          }
        }
        stackOptions.push('➕ Crear nuevo Stack...');

        const stackPick = await ctx.ui.select('Selecciona el Stack de destino:', stackOptions);
        if (!stackPick) {
          // Si cancela la selección de stack, regresa al menú de opciones de la regla
          continue;
        }

        if (stackPick.includes('Crear nuevo')) {
          const newStackDesc = ctx.ui?.input
            ? await ctx.ui.input(
                'Describe el nuevo Stack (ej: "go con gin", "nest con typeorm"):',
                `${detectedLang}-stack`
              )
            : `${detectedLang}-stack`;
          if (!newStackDesc) continue;
          const synth = heuristicFallbackStack(newStackDesc);
          chosenStackSlug = synth.slug;

          const newStackPb: Playbook = {
            language: synth.slug,
            stackId: synth.slug,
            stackName: synth.name,
            requiredFlags: synth.requiredFlags,
            scope: 'stack',
            version: 1,
            updatedAt: new Date().toISOString().split('T')[0],
            topology: { pattern: 'Standard Stack Layout', directories: ['src/'] },
            invariants: [],
            askRules: [],
            snippets: [],
          };
          await storage.saveStack(newStackPb);
          allStackSlugs.push(synth.slug);
        } else {
          const match = stackPick.match(/`([^`]+)`/) || stackPick.match(/📦\s*([^\s]+)/);
          chosenStackSlug = match ? match[1] : stackPick.replace(/^[^a-zA-Z0-9_-]+/, '').trim();
        }

        let stackPb = await storage.getStack(chosenStackSlug);
        if (!stackPb) {
          stackPb = {
            language: chosenStackSlug,
            stackId: chosenStackSlug,
            scope: 'stack',
            version: 1,
            updatedAt: new Date().toISOString().split('T')[0],
            topology: { pattern: 'Standard Stack Layout', directories: ['src/'] },
            invariants: [],
            askRules: [],
            snippets: [],
          };
        }

        const proceed = await resolveLayerConflictIfNeeded(
          `STACK: ${chosenStackSlug}`,
          stackPb,
          r,
          ctx,
          pi
        );
        if (proceed) {
          upsertRuleInPlaybook(stackPb, r);
          stackPb.version += 1;
          stackPb.updatedAt = new Date().toISOString().split('T')[0];
          await storage.saveStack(stackPb);
          summary.savedToStack[chosenStackSlug] = (summary.savedToStack[chosenStackSlug] || 0) + 1;
          ctx.ui?.notify(`✓ Regla [${r.id}] guardada en Stack [${chosenStackSlug}]`, 'info');
        } else {
          summary.discarded++;
        }
        resolved = true;
        break;
      }

      // --- 3. PROYECTO LOCAL ---
      if (triageChoice.includes('Proyecto Local')) {
        let localPb = await storage.getLocalProjectPlaybook(projectPath);
        if (!localPb) {
          localPb = {
            language: 'project',
            scope: 'project',
            version: 1,
            updatedAt: new Date().toISOString().split('T')[0],
            topology: { pattern: 'Project Custom Layout', directories: ['src/'] },
            invariants: [],
            askRules: [],
            snippets: [],
          };
        }

        const proceed = await resolveLayerConflictIfNeeded(
          'LOCAL (playbook.md)',
          localPb,
          r,
          ctx,
          pi
        );
        if (proceed) {
          upsertRuleInPlaybook(localPb, r);
          localPb.version += 1;
          localPb.updatedAt = new Date().toISOString().split('T')[0];
          await storage.saveLocalProjectPlaybook(localPb, projectPath);
          summary.savedToProject++;
          ctx.ui?.notify(`✓ Regla [${r.id}] guardada en playbook.md local del proyecto`, 'info');
        } else {
          summary.discarded++;
        }
        resolved = true;
        break;
      }

      // --- 4. MODIFICAR REGLA ---
      if (triageChoice.includes('Modificar')) {
        const userAdjustment = ctx.ui?.input
          ? await ctx.ui.input(
              `Ajustar regla [${r.id}]: Describe qué cambio deseas realizar:`,
              'Ej: cambiar superficie a internal/handlers, hacerla más estricta...'
            )
          : '';

        if (!userAdjustment || !userAdjustment.trim()) {
          ctx.ui?.notify('Modificación cancelada, volviendo a opciones.', 'info');
          continue;
        }

        // Hardening: Pre-check against prompt injection / jailbreak patterns
        const check = detectPromptInjection(userAdjustment.trim());
        if (check.isSuspicious) {
          ctx.ui?.notify(
            `❌ Ajuste rechazado: se detectaron patrones de meta-instrucción o inyección (${check.reason}).`,
            'error'
          );
          continue;
        }

        ctx.ui?.notify('Refinando regla con el modelo...', 'info');
        try {
          const refinePrompt =
            `Eres un arquitecto de software de Gentle-Playbook. Ajusta la siguiente regla arquitectónica según las instrucciones del usuario.\n\n` +
            `REGLA ACTUAL:\n` +
            `- Tipo: ${currentItem.type}\n` +
            `- ID: ${r.id}\n` +
            `- Título: ${r.title}\n` +
            `- Surface: ${r.surface}\n` +
            `- Descripción: ${r.description}\n\n` +
            `INSTRUCCIÓN DEL USUARIO:\n"${userAdjustment}"\n\n` +
            `Devuelve ÚNICAMENTE un JSON con este formato:\n` +
            `{\n  "title": "nuevo titulo",\n  "surface": "nueva surface",\n  "description": "nueva descripcion"\n}`;

          const rawResponse = await completePrompt(refinePrompt);
          let cleaned = rawResponse.trim();
          const jsonMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
          if (jsonMatch) cleaned = jsonMatch[1].trim();

          const parsed = JSON.parse(cleaned);
          if (parsed.title) r.title = parsed.title;
          if (parsed.surface) r.surface = parsed.surface;
          if (parsed.description) r.description = parsed.description;
          summary.modified++;
          ctx.ui?.notify(`✓ Regla refinada. Volviendo al menú de clasificación...`, 'info');
        } catch {
          // Fallback manual si no hay modelo o falla el parseo
          r.description = `${r.description} (Ajuste: ${userAdjustment.trim()})`;
          summary.modified++;
          ctx.ui?.notify(`✓ Ajuste aplicado como nota. Volviendo al menú...`, 'info');
        }
        // Vuelve al inicio del while para clasificarla con los ajustes
        continue;
      }

      // --- 5. DESCARTAR ---
      if (triageChoice.includes('Descartar')) {
        summary.discarded++;
        ctx.ui?.notify(`Regla [${r.id}] descartada.`, 'info');
        resolved = true;
        break;
      }
    }
  }

  return summary;
}

/**
 * Inserta o actualiza una regla en un Playbook respetando su tipo.
 */
export function upsertRuleInPlaybook(pb: Playbook, rule: AnyRule): void {
  const normId = rule.id.trim().toLowerCase();

  if (rule.type === 'invariant') {
    const idx = pb.invariants.findIndex((i) => i.id.toLowerCase() === normId);
    if (idx >= 0) pb.invariants[idx] = rule as InvariantRule;
    else pb.invariants.push(rule as InvariantRule);
  } else if (rule.type === 'ask') {
    const idx = pb.askRules.findIndex((a) => a.id.toLowerCase() === normId);
    if (idx >= 0) pb.askRules[idx] = rule as AskRule;
    else pb.askRules.push(rule as AskRule);
  } else if (rule.type === 'never') {
    if (!pb.neverRules) pb.neverRules = [];
    const idx = pb.neverRules.findIndex((n) => n.id.toLowerCase() === normId);
    if (idx >= 0) pb.neverRules[idx] = rule as NeverRule;
    else pb.neverRules.push(rule as NeverRule);
  }
}

/**
 * Verifica si hay conflicto en la capa destino y le da al usuario la decisión.
 */
async function resolveLayerConflictIfNeeded(
  targetLayerLabel: string,
  targetPb: Playbook,
  incomingRule: AnyRule,
  ctx: any,
  pi?: any
): Promise<boolean> {
  const collisions = findCollidingRules(
    incomingRule,
    [{ scopeLabel: targetLayerLabel, playbook: targetPb }],
    { sameLayer: true }
  );

  if (collisions.length === 0) return true;

  const col = collisions[0];
  const msg =
    `⚠️ Conflicto detectado en [${col.scopeLabel}] (${col.reason}):\n\n` +
    `**[REGLA EXISTENTE en ${col.scopeLabel}]**\n` +
    `- **ID:** \`${col.rule.id}\`\n` +
    `- **Título:** ${col.rule.title}\n` +
    `- **Surface:** \`${col.rule.surface}\`\n` +
    `- **Descripción:** ${col.rule.description}` +
    (col.ruleType === 'never' && (col.rule as NeverRule).reason
      ? `\n- **Motivo:** ${(col.rule as NeverRule).reason}`
      : '') +
    `\n\n` +
    `**VS**\n\n` +
    `**[REGLA ENTRANTE (Extract)]**\n` +
    `- **ID:** \`${incomingRule.id}\`\n` +
    `- **Título:** ${incomingRule.title}\n` +
    `- **Surface:** \`${incomingRule.surface}\`\n` +
    `- **Descripción:** ${incomingRule.description}` +
    (incomingRule.type === 'never' && (incomingRule as NeverRule).reason
      ? `\n- **Motivo:** ${(incomingRule as NeverRule).reason}`
      : '');

  pi?.sendMessage?.({
    customType: 'gentle-playbook-layer-conflict',
    content: `### ⚔️ Conflicto de Reglas Detectado\n\n${msg}`,
    display: true,
  });

  if (ctx.ui?.select) {
    const existingDesc = col.rule.description || col.rule.title;
    const incomingDesc = incomingRule.description || incomingRule.title;
    const truncate = (s: string, max = 80) =>
      s.length > max ? s.slice(0, max - 3) + '...' : s;

    const choice = await ctx.ui.select(
      `Conflicto en ${col.scopeLabel} para superficie \`${incomingRule.surface}\`:`,
      [
        `📥 1. Adoptar nueva: "${truncate(incomingDesc)}"`,
        `🛡️ 2. Conservar existente: "${truncate(existingDesc)}"`,
      ]
    );
    if (choice?.includes('Conservar')) {
      return false; // Descartar entrante
    }
    return true; // Reemplazar
  }

  return true;
}
