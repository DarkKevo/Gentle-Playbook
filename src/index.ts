import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { Type } from 'typebox';
import { PlaybookStorage } from './core/storage.js';
import { detectProjectLanguage, detectProjectLanguages } from './extract/extractor.js';
import { runAgentExtraction } from './extract/agent-extractor.js';
import { mergePlaybooks, RuleResolution, PlaybookDiffResult } from './core/diff.js';
import { computeSemanticPlaybookDiff, resolveConflictWithAI } from './core/semantic-diff.js';
import { formatPlaybookForDisplay, formatPlaybookForTool, formatAgentPreferencesForTool } from './core/parser.js';
import { detectPromptInjection } from './core/security.js';
import { InvariantRule, AskRule, NeverRule, RuleType, Playbook, AGENTS_PREFERENCES_ID } from './core/schema.js';
import { buildSynthesisPrompt, parseSynthesizedRule, SynthesizedRule, isProhibitionDescription, ProhibitionScope } from './core/synthesizer.js';
import {
  checkPathViolation,
  PromptEvaluationResult,
} from './core/checker.js';
import { getLanguageMenuLabels, resolveLanguage } from './core/languages.js';
import {
  handleStackCommand,
  findCollidingRules,
  checkAndResolveMultiStackConflicts,
  getActiveWorkspacePlaybooks,
  maskSubordinatePlaybooks,
} from './core/stack-handler.js';
import { detectActiveStacks } from './core/stack-detector.js';
import { heuristicFallbackStack } from './core/stack-synthesizer.js';
import { runExtractTriage } from './core/extract-triage.js';
import {
  buildSystemGuidance,
  playbookDisplayName,
  evaluateWorkspacePrompt,
  isBypassViolation,
  buildBypassBlockedMessage,
  buildHeadlessRedirectDirective,
  buildAskDefaultDirective,
  matchesAgentToolSurface,
  buildAgentNeverBlockReason,
  buildAgentAskHeadlessBlockReason,
  buildAgentInvariantHeadlessBlockReason,
  buildPathViolationBlockReason,
} from './core/governance.js';

export interface ExtensionAPI {
  registerCommand(
    name: string,
    options: {
      description: string;
      handler: (args: string, ctx: any) => Promise<void>;
    }
  ): void;
  sendMessage(message: any, options?: any): void;
  registerTool?(tool: any): void;
  on(event: string, handler: (event: any, ctx: any) => Promise<any>): void;
}

async function handleAddRule(
  args: string,
  ctx: any,
  storage: PlaybookStorage,
  pi: ExtensionAPI
): Promise<void> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  let targetLang: string | undefined = parts[0] === 'add' ? parts[1] : parts[0];
  const autoConfirm = parts.includes('--yes') || parts.includes('-y');
  if (targetLang === '--yes' || targetLang === '-y') {
    targetLang = undefined;
  }

  type TargetScope = 'agents' | 'project' | 'stack' | 'global';
  let targetScope: TargetScope = 'global';
  let targetIdentifier: string = 'go';
  let targetDisplayName = 'GO';

  // 1. Pregunta 1: ¿Dónde deseas registrar esta regla? (4 ámbitos)
  if (!targetLang) {
    if (ctx.ui?.select) {
      const categoryChoice = await ctx.ui.select(
        '¿Dónde deseas registrar esta regla?',
        [
          '🤖 Preferencias de Agente (Supervisión y Gobernanza de IA)',
          '🏠 Proyecto Local (playbook.md en la raíz de este repositorio)',
          '📦 Stack Tecnológico (combinación de tecnologías/frameworks)',
          '🌐 Lenguaje Global (Go, TypeScript, etc.)',
        ]
      );
      if (!categoryChoice) return;

      if (categoryChoice.includes('Agente')) {
        targetScope = 'agents';
        targetIdentifier = AGENTS_PREFERENCES_ID;
        targetDisplayName = 'Agents Preferences';
      } else if (categoryChoice.includes('Proyecto Local')) {
        targetScope = 'project';
        targetIdentifier = 'project';
        targetDisplayName = 'Proyecto Local (playbook.md)';
      } else if (categoryChoice.includes('Stack')) {
        targetScope = 'stack';
        const stacks = await storage.listStacks();
        if (stacks.length === 0) {
          const newStackPrompt = ctx.ui?.input
            ? await ctx.ui.input(
                'No hay stacks registrados. Escribe el stack a crear (ej: "go-gin" o "nest con typeorm"):',
                'go-gin'
              )
            : 'custom-stack';
          if (!newStackPrompt) return;
          const synth = heuristicFallbackStack(newStackPrompt);
          targetIdentifier = synth.slug;
          targetDisplayName = `Stack [${synth.name}]`;
        } else {
          const stackOptions = [...stacks, '➕ Crear nuevo Stack...'];
          const chosenStack = await ctx.ui.select('Selecciona el Stack para esta regla:', stackOptions);
          if (!chosenStack) return;
          if (chosenStack.includes('Crear')) {
            const newStackPrompt = ctx.ui?.input
              ? await ctx.ui.input('Escribe el nuevo stack a crear (ej: "go-gin"):', 'go-gin')
              : 'custom-stack';
            if (!newStackPrompt) return;
            const synth = heuristicFallbackStack(newStackPrompt);
            targetIdentifier = synth.slug;
            targetDisplayName = `Stack [${synth.name}]`;
          } else {
            targetIdentifier = chosenStack;
            targetDisplayName = `Stack [${chosenStack}]`;
          }
        }
      } else {
        targetScope = 'global';
        const selected = await ctx.ui.select(
          '¿Para qué lenguaje es esta regla de arquitectura?',
          getLanguageMenuLabels()
        );
        if (!selected) return;
        targetIdentifier = resolveLanguage(selected);
        targetDisplayName = targetIdentifier.toUpperCase();
      }
    } else {
      targetScope = 'global';
      targetIdentifier = 'go';
      targetDisplayName = 'GO';
    }
  } else {
    const low = targetLang.toLowerCase();
    if (low === AGENTS_PREFERENCES_ID || low === 'agents') {
      targetScope = 'agents';
      targetIdentifier = AGENTS_PREFERENCES_ID;
      targetDisplayName = 'Agents Preferences';
    } else if (low === 'project' || low === 'local') {
      targetScope = 'project';
      targetIdentifier = 'project';
      targetDisplayName = 'Proyecto Local (playbook.md)';
    } else if (low.startsWith('stack:') || (await storage.hasStack(low))) {
      targetScope = 'stack';
      targetIdentifier = low.replace('stack:', '');
      targetDisplayName = `Stack [${targetIdentifier}]`;
    } else {
      targetScope = 'global';
      targetIdentifier = resolveLanguage(targetLang);
      targetDisplayName = targetIdentifier.toUpperCase();
    }
  }

  const isAgent = targetScope === 'agents';

  // 2. Pregunta 2: La regla como tal
  if (!ctx.ui?.input) {
    ctx.ui?.notify('Error: UI no disponible para capturar la regla.', 'error');
    return;
  }

  const promptMsg = isAgent
    ? '[AGENTS PREFERENCES] Escribe la regla de supervisión o límite operativo para el agente:'
    : `[${targetDisplayName}] Escribe tu preferencia arquitectónica o norma:`;

  const promptPlaceholder = isAgent
    ? 'Ej: no se hace write si no yo lo apruebo, primero el approach del cambio y luego mi aprobación...'
    : 'Ej: me gusta colocar rate limit en situaciones donde son rutas peligrosas como logins...';

  const rawDescription = await ctx.ui.input(promptMsg, promptPlaceholder);

  if (!rawDescription || !rawDescription.trim()) {
    ctx.ui?.notify('Operación cancelada: No se ingresó ninguna descripción.', 'info');
    return;
  }

  // Pre-check for prompt injection or hostile meta-instructions
  const initialCheck = detectPromptInjection(rawDescription);
  if (initialCheck.isSuspicious) {
    ctx.ui?.notify(
      `❌ Regla rechazada: se detectaron patrones de meta-instrucción o inyección de prompt (${initialCheck.reason}).`,
      'error'
    );
    return;
  }

  // 3. Selection of Rule Type: Normativa vs Ask vs Prohibición (Never)
  let ruleType: RuleType = 'invariant';
  const looksLikeProhibition = isProhibitionDescription(rawDescription.trim());

  if (ctx.ui?.select) {
    let typeOptions: string[];
    if (isAgent) {
      typeOptions = looksLikeProhibition
        ? [
            '🚫 Prohibición / Never (Restricción terminante / Acción vetada)',
            '🛡️ Normativa (Límite operativo no negociable / Restricción estricta)',
            '💡 Ask (Punto de control / Preguntar al usuario antes de actuar)',
          ]
        : [
            '🛡️ Normativa (Límite operativo no negociable / Restricción estricta)',
            '💡 Ask (Punto de control / Preguntar al usuario antes de actuar)',
            '🚫 Prohibición / Never (Restricción terminante / Acción vetada)',
          ];
    } else {
      typeOptions = looksLikeProhibition
        ? [
            '🚫 Prohibición / Never (Restricción de no hacer o vetar tecnología/patrón)',
            '🛡️ Normativa (Invariante no negociable)',
            '💡 Ask (Patrón condicional / Receta con pregunta)',
          ]
        : [
            '🛡️ Normativa (Invariante no negociable)',
            '💡 Ask (Patrón condicional / Receta con pregunta)',
            '🚫 Prohibición / Never (Restricción de no hacer o vetar tecnología/patrón)',
          ];
    }

    const typeChoice = await ctx.ui.select(
      isAgent ? '¿Qué tipo de regla de supervisión es?' : '¿Qué tipo de regla es?',
      typeOptions
    );
    if (!typeChoice) return;
    if (typeChoice.includes('Ask')) {
      ruleType = 'ask';
    } else if (typeChoice.includes('Prohibición') || typeChoice.includes('Never')) {
      ruleType = 'never';
    }
  } else if (looksLikeProhibition) {
    ruleType = 'never';
  }

  // Si es una prohibición (Never), consultar el alcance en TUI
  let prohibitionScope: ProhibitionScope = 'specific';
  let customScopeText: string | undefined;

  if (ruleType === 'never' && ctx.ui?.select) {
    const scopeChoice = await ctx.ui.select(
      '¿Qué alcance debe tener esta prohibición?',
      [
        '🎯 1. Específica: Solo este elemento/librería puntual (ej: únicamente "Gin")',
        '🌐 2. Categórica / Familia: Este elemento y cualquier alternativa similar (ej: Gin y cualquier router externo; usar solo stdlib)',
        '✍️ 3. Definir alcance personalizado: (especificar excepciones, condiciones o límites)',
      ]
    );
    if (!scopeChoice) return;

    if (scopeChoice.includes('1. Específica')) {
      prohibitionScope = 'specific';
    } else if (scopeChoice.includes('2. Categórica')) {
      prohibitionScope = 'categorical';
    } else if (scopeChoice.includes('3. Definir alcance')) {
      prohibitionScope = 'custom';
      if (ctx.ui?.input) {
        const customInput = await ctx.ui.input(
          'Escribe el alcance detallado de la prohibición (límites o excepciones permitidas):',
          'Ej: prohibir todos los routers de terceros salvo net/http estándar'
        );
        if (customInput && customInput.trim()) {
          const check = detectPromptInjection(customInput.trim());
          if (check.isSuspicious) {
            ctx.ui?.notify(`❌ Alcance rechazado: patrón sospechoso detectado (${check.reason}).`, 'error');
            return;
          }
          customScopeText = customInput.trim();
        }
      }
    }
  }

  // 4. Synthesize with LLM via modelRegistry
  ctx.ui?.notify('Procesando y sintetizando regla con el modelo...', 'info');

  let synthesized: SynthesizedRule;
  try {
    const prompt = buildSynthesisPrompt(
      isAgent ? AGENTS_PREFERENCES_ID : targetIdentifier,
      rawDescription.trim(),
      ruleType,
      {
        prohibitionScope,
        customScopeText,
      }
    );
    let rawResponse = '';

    if (ctx.modelRegistry && ctx.model) {
      const completion = await ctx.modelRegistry.complete(ctx.model, {
        messages: [{ role: 'user', content: prompt }],
      });
      rawResponse =
        completion.content
          ?.filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('') || '';
    }

    if (!rawResponse.trim()) {
      synthesized = {
        type: ruleType,
        id: rawDescription.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 24),
        title: rawDescription.slice(0, 45),
        surface: isAgent ? 'tools:all' : (ruleType === 'never' ? 'dependencies' : 'src/'),
        description: rawDescription.trim(),
        trigger: isAgent ? 'Al intentar ejecutar acciones en esta superficie' : 'Al implementar esta funcionalidad',
        antiTrigger: isAgent ? 'En tareas de solo lectura' : 'En contextos no aplicables',
        prompt: `¿Deseas proceder con ${rawDescription.slice(0, 30)}?`,
        defaultAction: isAgent ? 'Detener la acción y pedir instrucciones' : 'Continuar sin esta regla',
        reason: 'Restricción obligatoria del usuario',
      };
    } else {
      synthesized = parseSynthesizedRule(rawResponse, ruleType, targetIdentifier);
    }
  } catch (err: any) {
    ctx.ui?.notify(`Error al sintetizar la regla: ${err.message}`, 'error');
    return;
  }

  // 4b. Chequeo de colisión entre capas activas
  const candidateLayers: Array<{ scopeLabel: string; playbook: Playbook }> = [];
  const cwd = ctx.cwd || process.cwd();

  if (targetScope !== 'project') {
    const localPb = await storage.getLocalProjectPlaybook(cwd);
    if (localPb) candidateLayers.push({ scopeLabel: 'LOCAL (playbook.md)', playbook: localPb });
  }

  const allStackSlugs = await storage.listStacks();
  const allStackPbs: Playbook[] = [];
  for (const sSlug of allStackSlugs) {
    const sPb = await storage.getStack(sSlug);
    if (sPb) allStackPbs.push(sPb);
  }
  const activeStacks = await detectActiveStacks(cwd, allStackPbs);
  for (const actStack of activeStacks) {
    if (targetScope !== 'stack' || actStack.stackId !== targetIdentifier) {
      candidateLayers.push({ scopeLabel: `STACK: ${actStack.stackId}`, playbook: actStack });
    }
  }

  if (targetScope !== 'global') {
    const detectedLang = await detectProjectLanguage(cwd);
    if (detectedLang && detectedLang !== 'generic') {
      const globPb = await storage.getPlaybook(detectedLang);
      if (globPb) candidateLayers.push({ scopeLabel: `GLOBAL: ${detectedLang}`, playbook: globPb });
    }
  }

  const collisions = findCollidingRules(synthesized, candidateLayers);
  if (collisions.length > 0 && ctx.ui?.select) {
    const c = collisions[0];
    const collisionMsg =
      `⚠️ Conflicto detectado con [${c.scopeLabel}]:\n\n` +
      `[EXISTENTE en ${c.scopeLabel}]\n` +
      `- Título: ${c.rule.title}\n` +
      `- Surface: \`${c.rule.surface}\`\n` +
      `- Descripción: ${c.rule.description}\n\n` +
      `[NUEVA en ${targetDisplayName}]\n` +
      `- Título: ${synthesized.title}\n` +
      `- Surface: \`${synthesized.surface}\`\n` +
      `- Descripción: ${synthesized.description}`;

    pi.sendMessage({
      customType: 'gentle-playbook-layer-conflict',
      content: `### ⚔️ Conflicto de Reglas Detectado\n\n${collisionMsg}`,
      display: true,
    });

    const truncate = (s: string, max = 80) =>
      s.length > max ? s.slice(0, max - 3) + '...' : s;
    const newDesc = synthesized.description || synthesized.title;
    const existDesc = c.rule.description || c.rule.title;

    const choice = await ctx.ui.select(
      `Conflicto en superficie \`${synthesized.surface}\` con [${c.scopeLabel}]:`,
      [
        `📥 1. Guardar nueva en ${targetDisplayName}: "${truncate(newDesc)}"`,
        `🛡️ 2. Conservar existente de ${c.scopeLabel}: "${truncate(existDesc)}"`,
        `✏️ 3. Modificar la regla a agregar (reformular)`,
      ]
    );

    if (choice?.includes('Conservar')) {
      ctx.ui?.notify(`Operación cancelada: Se conservó la regla existente de ${c.scopeLabel}.`, 'info');
      return;
    }
    if (choice?.includes('Modificar') && ctx.ui?.input) {
      const adjusted = await ctx.ui.input('Reformula la descripción de la regla:', synthesized.description);
      if (!adjusted || !adjusted.trim()) {
        ctx.ui?.notify('Operación cancelada.', 'info');
        return;
      }
      synthesized.description = adjusted.trim();
    }
  }

  // 5. Build Preview for User Confirmation
  let preview = '';
  if (synthesized.type === 'invariant') {
    preview = `Título: [NORMATIVA] ${synthesized.title}\nSurface: ${synthesized.surface}\nRegla: ${synthesized.description}`;
  } else if (synthesized.type === 'ask') {
    preview = `Título: [ASK] ${synthesized.title}\nSurface: ${synthesized.surface}\nTrigger: ${synthesized.trigger}\nAnti-Trigger: ${synthesized.antiTrigger}\nPregunta: "${synthesized.prompt}"\nDefault: ${synthesized.defaultAction}`;
  } else {
    preview = `Título: [NUNCA/PROHIBICIÓN] ${synthesized.title}\nSurface: ${synthesized.surface}\nProhibición: ${synthesized.description}\nMotivo: ${synthesized.reason || 'Restricción arquitectónica obligatoria'}`;
  }

  // Confirm dialog or fail-safe without UI
  let confirmed = false;
  if (ctx.ui?.confirm) {
    confirmed = await ctx.ui.confirm(
      `¿Deseas guardar esta regla en ${targetDisplayName}?`,
      preview
    );
  } else if (autoConfirm) {
    confirmed = true;
  } else {
    // Fail-safe: Sin confirmación interactiva y sin --yes, no se escribe en disco
    ctx.ui?.notify?.(
      '⚠️ Regla sintetizada pero no guardada: se requiere confirmación interactiva o el flag --yes para escribir en disco.',
      'warning'
    );
    return;
  }

  if (!confirmed) {
    ctx.ui?.notify('Operación cancelada: La regla fue descartada.', 'info');
    return;
  }

  // 6. Save to storage according to targetScope
  let pb: Playbook | null = null;
  if (targetScope === 'project') {
    pb = await storage.getLocalProjectPlaybook(cwd);
    if (!pb) {
      pb = {
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
  } else if (targetScope === 'stack') {
    pb = await storage.getStack(targetIdentifier);
    if (!pb) {
      pb = {
        language: targetIdentifier,
        stackId: targetIdentifier,
        stackName: targetIdentifier.toUpperCase(),
        requiredFlags: [targetIdentifier],
        scope: 'stack',
        version: 1,
        updatedAt: new Date().toISOString().split('T')[0],
        topology: { pattern: 'Standard Stack Layout', directories: ['src/'] },
        invariants: [],
        askRules: [],
        snippets: [],
      };
    }
  } else if (targetScope === 'agents') {
    pb = await storage.getAgentPreferences();
    if (!pb) {
      pb = {
        language: AGENTS_PREFERENCES_ID,
        scope: 'agents',
        version: 1,
        updatedAt: new Date().toISOString().split('T')[0],
        topology: { pattern: 'Agent Runtime', directories: [] },
        invariants: [],
        askRules: [],
        snippets: [],
      };
    }
  } else {
    pb = await storage.getPlaybook(targetIdentifier);
    if (!pb) {
      pb = {
        language: targetIdentifier,
        scope: 'global',
        version: 1,
        updatedAt: new Date().toISOString().split('T')[0],
        topology: { pattern: 'Standard Layout', directories: ['src/'] },
        invariants: [],
        askRules: [],
        snippets: [],
      };
    }
  }

  if (synthesized.type === 'invariant') {
    const idx = pb.invariants.findIndex((i) => i.id === synthesized.id);
    const newInv: InvariantRule = {
      id: synthesized.id,
      type: 'invariant',
      title: synthesized.title,
      surface: synthesized.surface,
      description: synthesized.description,
    };
    if (idx >= 0) pb.invariants[idx] = newInv;
    else pb.invariants.push(newInv);
  } else if (synthesized.type === 'never') {
    if (!pb.neverRules) pb.neverRules = [];
    const idx = pb.neverRules.findIndex((n) => n.id === synthesized.id);
    const newNever: NeverRule = {
      id: synthesized.id,
      type: 'never',
      title: synthesized.title,
      surface: synthesized.surface,
      description: synthesized.description,
      reason: synthesized.reason || '',
    };
    if (idx >= 0) pb.neverRules[idx] = newNever;
    else pb.neverRules.push(newNever);
  } else {
    const idx = pb.askRules.findIndex((a) => a.id === synthesized.id);
    const newAsk: AskRule = {
      id: synthesized.id,
      type: 'ask',
      title: synthesized.title,
      surface: synthesized.surface,
      description: synthesized.description,
      trigger: synthesized.trigger || '',
      antiTrigger: synthesized.antiTrigger || '',
      prompt: synthesized.prompt || '',
      defaultAction: synthesized.defaultAction || 'Omitir regla',
    };
    if (idx >= 0) pb.askRules[idx] = newAsk;
    else pb.askRules.push(newAsk);
  }

  pb.version += 1;
  pb.updatedAt = new Date().toISOString().split('T')[0];

  if (targetScope === 'project') {
    await storage.saveLocalProjectPlaybook(pb, cwd);
  } else if (targetScope === 'stack') {
    await storage.saveStack(pb);
  } else if (targetScope === 'agents') {
    await storage.saveAgentPreferences(pb);
  } else {
    await storage.savePlaybook(pb);
  }

  ctx.ui?.notify(`✓ Regla guardada con éxito en ${targetDisplayName}`, 'info');

  pi.sendMessage({
    customType: 'gentle-playbook',
    content: `### 🛡️ Nueva Regla Guardada en ${targetDisplayName} (v${pb.version})\n\n${preview}`,
    display: true,
  });
}

export default function (pi: ExtensionAPI) {
  const storage = new PlaybookStorage();

  // 1. Register Slash Command: /gentle-playbook and alias /playbook
  const playbookCommandHandler = async (args: string, ctx: any) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0] || 'list';
      const includeSnippets = args.includes('--snippets') || args.includes('--full');

      if (sub === 'add') {
        const remainingArgs = parts.slice(1).join(' ');
        await handleAddRule(remainingArgs, ctx, storage, pi);
        return;
      }

      if (sub === 'stack') {
        const remainingArgs = parts.slice(1).join(' ');
        await handleStackCommand(remainingArgs, ctx, storage, pi);
        return;
      }

      if (sub === 'list') {
        const languages = await storage.listLanguages();
        const hasAgents = await storage.hasAgentPreferences();

        if (languages.length === 0 && !hasAgents) {
          ctx.ui?.notify('gentle-playbook: No hay playbooks guardados en el almacenamiento.', 'info');
          return;
        }

        const entries: Array<{ id: string; label: string; summary: string }> = [];

        if (hasAgents) {
          const agentPb = await storage.getAgentPreferences();
          if (agentPb) {
            const counts: string[] = [];
            counts.push(`${agentPb.invariants.length} normativas`);
            counts.push(`${agentPb.askRules.length} asks`);
            if (agentPb.neverRules && agentPb.neverRules.length > 0) {
              counts.push(`${agentPb.neverRules.length} never`);
            }
            const countStr = counts.join(', ');
            entries.push({
              id: AGENTS_PREFERENCES_ID,
              label: `🤖 agents-preferences (${countStr})`,
              summary: `Agents Preferences (v${agentPb.version}): ${countStr} [SUPERVISION]`,
            });
          }
        }

        for (const lang of languages) {
          const pb = await storage.getPlaybook(lang);
          if (pb) {
            const counts: string[] = [];
            counts.push(`${pb.invariants.length} invariantes`);
            counts.push(`${pb.askRules.length} ask rules`);
            if (pb.neverRules && pb.neverRules.length > 0) {
              counts.push(`${pb.neverRules.length} prohibiciones (never)`);
            }
            if (pb.snippets && pb.snippets.length > 0) {
              counts.push(`${pb.snippets.length} snippets`);
            }
            const countStr = counts.join(', ');
            entries.push({
              id: lang,
              label: `• ${lang} (${countStr})`,
              summary: `${lang.toUpperCase()} (v${pb.version}): ${countStr}`,
            });
          }
        }

        if (ctx.ui?.select) {
          const selectedLabel = await ctx.ui.select(
            'Selecciona un playbook para explorar:',
            entries.map((e) => e.label)
          );
          if (selectedLabel) {
            const matched = entries.find((e) => e.label === selectedLabel);
            if (matched) {
              const pb = await storage.getPlaybook(matched.id);
              if (pb) {
                ctx.ui?.notify(matched.summary, 'info');
                pi.sendMessage({
                  customType: 'gentle-playbook',
                  content: formatPlaybookForDisplay(pb, { includeSnippets }),
                  display: true,
                });
              }
            }
          }
        } else {
          ctx.ui?.notify(
            'Playbooks disponibles:\n' + entries.map((e) => e.summary).join('\n'),
            'info'
          );
        }
      } else if (sub === 'show') {
        const langInput = parts[1];
        if (!langInput) {
          ctx.ui?.notify('Usage: /gentle-playbook show <language|agents> [--full]', 'warning');
          return;
        }
        const resolved = resolveLanguage(langInput);
        const pb = await storage.getPlaybook(resolved);
        if (!pb) {
          ctx.ui?.notify(`Playbook "${langInput}" not found.`, 'error');
          return;
        }
        const displayLabel = pb.language === AGENTS_PREFERENCES_ID ? 'Agents Preferences' : pb.language;
        ctx.ui?.notify(`Displaying playbook: ${displayLabel}`, 'info');

        pi.sendMessage({
          customType: 'gentle-playbook',
          content: formatPlaybookForDisplay(pb, { includeSnippets }),
          display: true,
        });
      } else if (sub === 'delete') {
        let targetLang = parts[1];
        const autoConfirm = parts.includes('--yes') || parts.includes('-y');
        const ruleFlagIdx = parts.indexOf('--rule');
        let directRuleId: string | undefined = undefined;
        if (ruleFlagIdx >= 0) {
          const candidate = parts[ruleFlagIdx + 1];
          if (!candidate || candidate.startsWith('-')) {
            ctx.ui?.notify?.(
              'Error: El flag --rule requiere el ID de la regla a eliminar (ej: --rule http-handlers-ports).',
              'error'
            );
            return;
          }
          directRuleId = candidate;
        }

        if (!targetLang || targetLang.startsWith('--')) {
          const languages = await storage.listLanguages();
          const hasAgents = await storage.hasAgentPreferences();
          const options: string[] = [];
          if (hasAgents) options.push('🤖 agents-preferences (Gobernanza de Agente)');
          options.push(...languages);

          if (options.length === 0) {
            ctx.ui?.notify('No hay playbooks guardados para eliminar.', 'info');
            return;
          }

          if (ctx.ui?.select) {
            const selected = await ctx.ui.select(
              'Selecciona el playbook que deseas gestionar o eliminar:',
              options
            );
            if (!selected || typeof selected !== 'string') return;
            targetLang = selected.includes('agents-preferences') ? AGENTS_PREFERENCES_ID : selected;
          } else {
            ctx.ui?.notify('Uso: /playbook delete <language|agents> [--rule <id>]', 'warning');
            return;
          }
        } else {
          targetLang = targetLang === 'agents' || targetLang === 'agents-preferences'
            ? AGENTS_PREFERENCES_ID
            : resolveLanguage(targetLang);
        }

        const pb = await storage.getPlaybook(targetLang);
        if (!pb) {
          ctx.ui?.notify(`El playbook "${targetLang}" no existe en el almacenamiento.`, 'error');
          return;
        }

        const targetDisplayName = targetLang === AGENTS_PREFERENCES_ID ? 'Agents Preferences' : targetLang.toUpperCase();

        // Si se especificó directamente --rule <id> por comando
        if (directRuleId) {
          if (ctx.ui?.confirm) {
            const confirmed = await ctx.ui.confirm(
              'Confirmar eliminación de regla',
              `¿Deseas eliminar la regla "${directRuleId}" de ${targetDisplayName}?`
            );
            if (!confirmed) {
              ctx.ui?.notify('Eliminación de regla cancelada.', 'info');
              return;
            }
          } else if (!autoConfirm) {
            ctx.ui?.notify?.(
              '⚠️ Eliminación cancelada: se requiere confirmación interactiva o el flag --yes para eliminar en disco.',
              'warning'
            );
            return;
          }
          const res = await storage.deleteRule(targetLang, directRuleId);
          if (res.deleted) {
            ctx.ui?.notify(`✓ Regla "${directRuleId}" (${res.ruleType}) eliminada con éxito de ${targetDisplayName}.`, 'info');
          } else {
            ctx.ui?.notify(`Error: La regla "${directRuleId}" no se encontró en ${targetDisplayName}.`, 'error');
          }
          return;
        }

        // Flujo Interactivo en TUI: 2 opciones (regla específica vs playbook entero)
        if (ctx.ui?.select) {
          const actionChoice = await ctx.ui.select(
            `Gestión de eliminación para "${targetDisplayName}":`,
            [
              '✂️ Eliminar una regla específica del playbook',
              '🗑️ Eliminar el playbook completo de este lenguaje',
            ]
          );
          if (!actionChoice) return;

          if (actionChoice.includes('completo')) {
            // Opción 2: Borrar el playbook entero
            let confirmed = true;
            if (ctx.ui?.confirm) {
              confirmed = await ctx.ui.confirm(
                '⚠️ Confirmar eliminación total',
                `¿Estás seguro de que deseas eliminar permanentemente el playbook completo de ${targetDisplayName}?`
              );
            }
            if (confirmed) {
              await storage.deletePlaybook(targetLang);
              ctx.ui?.notify(`✓ Playbook de ${targetDisplayName} eliminado por completo.`, 'info');
            } else {
              ctx.ui?.notify('Eliminación del playbook cancelada por el usuario.', 'info');
            }
            return;
          }

          // Opción 1: Borrar una regla específica
          const rulesList: Array<{ id: string; label: string }> = [];
          for (const inv of pb.invariants) {
            rulesList.push({ id: inv.id, label: `[INVARIANT] ${inv.id}: ${inv.title}` });
          }
          for (const ask of pb.askRules) {
            rulesList.push({ id: ask.id, label: `[ASK] ${ask.id}: ${ask.title}` });
          }
          for (const never of (pb.neverRules || [])) {
            rulesList.push({ id: never.id, label: `[NEVER] ${never.id}: ${never.description.slice(0, 40)}` });
          }
          for (const snip of pb.snippets) {
            rulesList.push({ id: snip.id, label: `[SNIPPET] ${snip.id}: ${snip.title}` });
          }

          if (rulesList.length === 0) {
            ctx.ui?.notify(`El playbook "${targetDisplayName}" no tiene reglas individuales para eliminar.`, 'warning');
            return;
          }

          const selectedRule = await ctx.ui.select(
            'Selecciona la regla que deseas eliminar:',
            rulesList.map((r) => r.label)
          );
          if (!selectedRule) return;

          const matched = rulesList.find((r) => r.label === selectedRule);
          if (matched) {
            let confirmed = true;
            if (ctx.ui?.confirm) {
              confirmed = await ctx.ui.confirm(
                'Confirmar eliminación de regla',
                `¿Eliminar permanentemente la regla "${matched.id}" de ${targetDisplayName}?`
              );
            }
            if (confirmed) {
              const res = await storage.deleteRule(targetLang, matched.id);
              if (res.deleted) {
                ctx.ui?.notify(`✓ Regla "${matched.id}" (${res.ruleType}) eliminada con éxito de ${targetDisplayName}.`, 'info');
              } else {
                ctx.ui?.notify(`Error: La regla "${matched.id}" no se pudo eliminar.`, 'error');
              }
            } else {
              ctx.ui?.notify('Eliminación de regla cancelada.', 'info');
            }
          }
          return;
        }

        // Sin ctx.ui.select (entorno headless / fallback)
        let confirmed = false;
        if (ctx.ui?.confirm) {
          confirmed = await ctx.ui.confirm(
            'Confirmar eliminación',
            `¿Deseas eliminar el playbook de ${targetDisplayName}?`
          );
        } else if (autoConfirm) {
          confirmed = true;
        } else {
          ctx.ui?.notify?.(
            '⚠️ Eliminación cancelada: se requiere confirmación interactiva o el flag --yes para eliminar en disco.',
            'warning'
          );
          return;
        }
        if (confirmed) {
          await storage.deletePlaybook(targetLang);
          ctx.ui?.notify(`✓ Playbook de ${targetDisplayName} eliminado.`, 'info');
        } else {
          ctx.ui?.notify('Operación cancelada.', 'info');
        }
      } else if (sub === 'extract') {
        let inputPath: string | undefined;
        let langOverride: string | undefined;
        let autoConfirm = false;

        for (let i = 1; i < parts.length; i++) {
          if (parts[i] === '--lang') {
            if (parts[i + 1] && !parts[i + 1].startsWith('--')) {
              langOverride = resolveLanguage(parts[i + 1]);
              i++;
            }
          } else if (parts[i] === '--yes' || parts[i] === '-y') {
            autoConfirm = true;
          } else if (!parts[i].startsWith('--') && !inputPath) {
            inputPath = parts[i];
          }
        }

        let resolvedPath = '';

        if (!inputPath) {
          // Sin argumento: extraer sobre el proyecto actualmente abierto
          resolvedPath = ctx.cwd || process.cwd();
        } else {
          const direct = path.resolve(ctx.cwd || process.cwd(), inputPath);
          const sibling = path.resolve(ctx.cwd || process.cwd(), '..', inputPath);

          let found = false;
          try {
            await fs.access(direct);
            resolvedPath = direct;
            found = true;
          } catch {
            try {
              await fs.access(sibling);
              resolvedPath = sibling;
              found = true;
            } catch {
              // no encontrado
            }
          }

          if (!found) {
            ctx.ui?.notify(`❌ Error: La ruta "${inputPath}" no existe.`, 'error');
            return;
          }
        }

        ctx.ui?.notify(`Iniciando Agente Explorador de Esencia sobre ${resolvedPath}...`, 'info');

        try {
          let detectedLang: string;
          if (langOverride) {
            detectedLang = langOverride;
            ctx.ui?.notify(`Lenguaje especificado manualmente: ${detectedLang}`, 'info');
          } else {
            const langResult = await detectProjectLanguages(resolvedPath);
            detectedLang = langResult.primary;

            if (langResult.isMonorepo) {
              const countsDesc = langResult.detected
                .map((l) => `${l} (${langResult.counts[l] || 0} archivos)`)
                .join(', ');
              ctx.ui?.notify(`Múltiples lenguajes detectados: ${countsDesc}. Predominante: ${detectedLang}`, 'info');
            }
          }

          if (!ctx.modelRegistry || !ctx.model) {
            ctx.ui?.notify(
              '❌ Error: Se requiere un modelo activo en Pi para extraer normas arquitectónicas con el Agente.',
              'error'
            );
            return;
          }

          const completePrompt = async (prompt: string) => {
            const completion = await ctx.modelRegistry.complete(ctx.model, {
              messages: [{ role: 'user', content: prompt }],
            });
            return completion?.content?.map((c: any) => c.text || '').join('') || '';
          };

          ctx.ui?.notify('Explorando decisiones arquitectónicas y recolectando evidencia contada...', 'info');
          const result = await runAgentExtraction(resolvedPath, {
            language: detectedLang,
            completePrompt,
          });
          const draft: Playbook = result.playbook;
          const evidenceReport = result.evidenceReport;

          // Si hay reporte de evidencia, mostrárselo al usuario
          if (evidenceReport) {
            pi.sendMessage({
              customType: 'gentle-playbook-evidence',
              content: `### 📊 Reporte de Evidencia de Extracción\n\n${evidenceReport}`,
              display: true,
            });
          }

          // Ejecutar Triage interactivo 1 a 1 (Global vs Stack vs Local vs Modificar vs Descartar)
          const triageSummary = await runExtractTriage({
            draft,
            detectedLang,
            projectPath: resolvedPath,
            storage,
            ctx,
            pi,
            completePrompt,
            autoConfirm,
          });

          const stackSummaryParts = Object.entries(triageSummary.savedToStack).map(
            ([slug, count]) => `${count} en Stack [${slug}]`
          );
          const totalSaved =
            triageSummary.savedToGlobal +
            triageSummary.savedToProject +
            Object.values(triageSummary.savedToStack).reduce((a, b) => a + b, 0);

          const summaryLines = [
            `- **Global (${detectedLang.toUpperCase()}):** ${triageSummary.savedToGlobal} regla(s)`,
            `- **Proyecto Local (playbook.md):** ${triageSummary.savedToProject} regla(s)`,
            `- **Stacks Tecnológicos:** ${stackSummaryParts.join(", ") || "0 regla(s)"}`,
            `- **Modificadas vía IA:** ${triageSummary.modified}`,
            `- **Descartadas:** ${triageSummary.discarded}`,
          ];

          ctx.ui?.notify(
            `Extracción y Triage completados: ${totalSaved} regla(s) guardadas en sus respectivos ámbitos.`,
            "info"
          );

          pi.sendMessage({
            customType: 'gentle-playbook-triage-summary',
            content: `### 🎯 Resumen de Extracción y Triage 1 a 1\n\n${summaryLines.join("\n")}`,
            display: true,
          });
        } catch (err: any) {
          ctx.ui?.notify(`Fallo en la extracción: ${err.message}`, 'error');
        }
      }
  };

  pi.registerCommand('gentle-playbook', {
    description: 'Inspect, extract, or manage language architecture playbooks and agent preferences',
    handler: playbookCommandHandler,
  });

  // Short alias for convenient autocomplete: /playbook
  pi.registerCommand('playbook', {
    description: 'Inspect, extract, or manage language architecture playbooks (alias)',
    handler: playbookCommandHandler,
  });

  // 2. Register Dedicated Slash Command: /gentle-playbook-add
  pi.registerCommand('gentle-playbook-add', {
    description: 'Add a new architectural invariant, ask rule, or agent preference interactively',
    handler: async (args: string, ctx: any) => {
      await handleAddRule(args, ctx, storage, pi);
    },
  });

  // Dedicated Slash Command: /playbook-stack
  pi.registerCommand('gentle-playbook-stack', {
    description: 'Create, inspect, or manage technology stack playbooks',
    handler: async (args: string, ctx: any) => {
      await handleStackCommand(args, ctx, storage, pi);
    },
  });

  pi.registerCommand('playbook-stack', {
    description: 'Create, inspect, or manage technology stack playbooks (alias)',
    handler: async (args: string, ctx: any) => {
      await handleStackCommand(args, ctx, storage, pi);
    },
  });

  // 3. Auto-detection on session_start
  pi.on('session_start', async (_event: any, ctx: any) => {
    const cwd = ctx.cwd || process.cwd();

    // Preferencias de Agente
    if (await storage.hasAgentPreferences()) {
      ctx.ui?.notify(
        '[gentle-playbook] Agent Preferences active (Supervision & Governance available via playbook_consult tool)',
        'info'
      );
    }

    // Playbook Local del Proyecto (playbook.md)
    if (await storage.hasLocalProjectPlaybook(cwd)) {
      ctx.ui?.notify(
        '[gentle-playbook] Local Project Playbook active (playbook.md en la raíz del repositorio)',
        'info'
      );
    }

    // Stacks Tecnológicos activos y arbitraje de conflictos
    const allStackSlugs = await storage.listStacks();
    const allStackPbs: Playbook[] = [];
    for (const slug of allStackSlugs) {
      const s = await storage.getStack(slug);
      if (s) allStackPbs.push(s);
    }
    const activeStacks = await detectActiveStacks(cwd, allStackPbs);
    if (activeStacks.length > 0) {
      const names = activeStacks.map((s) => s.stackName || s.stackId).join(', ');
      ctx.ui?.notify(`[gentle-playbook] Active Stack(s): ${names}`, 'info');

      // Si hay 2 o más stacks activos, chequear colisiones y aterrizar en local
      if (activeStacks.length >= 2) {
        await checkAndResolveMultiStackConflicts(cwd, activeStacks, storage, ctx, pi);
      }
    }

    // Lenguaje base detectado
    const detectedLang = await detectProjectLanguage(cwd);
    if (detectedLang && detectedLang !== 'generic') {
      const exists = await storage.exists(detectedLang);
      if (exists) {
        ctx.ui?.notify(
          `[gentle-playbook] Active ${detectedLang.toUpperCase()} playbook available via playbook_consult tool`,
          'info'
        );
      }
    }
  });

  // 4. Light runtime directive via before_agent_start (Eje 4: Puntero ligero on-demand)
  pi.on('before_agent_start', async (event: any, ctx: any) => {
    const cwd = ctx?.cwd || process.cwd();
    const activePbs = await getActiveWorkspacePlaybooks(cwd, storage);

    if (activePbs.length === 0) return;

    if (!event.systemPromptOptions) {
      event.systemPromptOptions = { sections: {} };
    }
    if (!event.systemPromptOptions.sections) {
      event.systemPromptOptions.sections = {};
    }

    event.systemPromptOptions.sections.playbook_guidance = buildSystemGuidance(activePbs);
  });

  // 5. Model-callable tool: playbook_consult (Option A: Role Tool on-demand data)
  if (pi.registerTool) {
    const PlaybookConsultParams = Type.Object({
      language: Type.Optional(
        Type.String({
          description:
            "Target language (e.g. 'go', 'typescript', 'python') or 'agents' for agent supervision preferences. Defaults to auto-detected workspace language.",
        })
      ),
      surface: Type.Optional(
        Type.String({
          description:
            "Optional filter for rules affecting a specific surface or file path (e.g. 'internal/ports', 'tools:write', 'git:push').",
        })
      ),
    });

    pi.registerTool({
      name: 'playbook_consult',
      label: 'Playbook Consult',
      description:
        'Consult architectural conventions, topology constraints, coding invariants, conditional asks, prohibitions, and agent supervision preferences for the project or language. Returns passive reference data without system prompt injection.',
      parameters: PlaybookConsultParams,
      async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
        const cwd = ctx?.cwd || process.cwd();
        let targetLang = params?.language?.trim().toLowerCase();
        const surfaceFilter = params?.surface?.trim();

        const results: string[] = [];

        if (targetLang === 'agents' || targetLang === AGENTS_PREFERENCES_ID) {
          const agentPrefs = await storage.getAgentPreferences();
          if (agentPrefs) {
            results.push(formatAgentPreferencesForTool(agentPrefs, surfaceFilter));
          } else {
            results.push('No agent supervision preferences found in storage.');
          }
        } else if (targetLang === 'project' || targetLang === 'local') {
          const localPb = await storage.getLocalProjectPlaybook(cwd);
          if (localPb) {
            results.push(formatPlaybookForTool(localPb, surfaceFilter));
          } else {
            results.push('No local project playbook (playbook.md) found in this repository.');
          }
        } else if (targetLang && (await storage.hasStack(targetLang))) {
          const stackPb = await storage.getStack(targetLang);
          if (stackPb) {
            results.push(formatPlaybookForTool(stackPb, surfaceFilter));
          } else {
            results.push(`No stack playbook found for '${targetLang}'.`);
          }
        } else if (targetLang) {
          const resolved = resolveLanguage(targetLang);
          const pb = await storage.getPlaybook(resolved);
          if (pb) {
            results.push(formatPlaybookForTool(pb, surfaceFilter));
          } else {
            results.push(`No playbook found for language '${targetLang}'.`);
          }
        } else {
          // Jerarquía completa del workspace (Local > Stack > Global > Agente)
          const playbooks = await getActiveWorkspacePlaybooks(cwd, storage);
          for (const pb of playbooks) {
            let header = '';
            if (pb.scope === 'project' || pb.language === 'project') {
              header = '### 🏠 [LOCAL PROJECT PLAYBOOK: playbook.md]';
            } else if (pb.scope === 'stack' || pb.stackId) {
              header = `### 📦 [STACK PLAYBOOK: ${pb.stackName || pb.stackId}]`;
            } else if (pb.language === AGENTS_PREFERENCES_ID) {
              header = '### 🤖 [AGENT SUPERVISION PREFERENCES]';
            } else {
              header = `### 🌐 [GLOBAL PLAYBOOK: ${pb.language.toUpperCase()}]`;
            }

            const formatted =
              pb.language === AGENTS_PREFERENCES_ID
                ? formatAgentPreferencesForTool(pb, surfaceFilter)
                : formatPlaybookForTool(pb, surfaceFilter);

            if (formatted && !formatted.includes('No se encontraron reglas')) {
              results.push(`${header}\n\n${formatted}`);
            }
          }

          if (results.length === 0) {
            results.push('No playbook found for the current workspace and no agent preferences configured.');
          }
        }

        const text = results.join('\n\n---\n\n');
        return {
          content: [{ type: 'text', text }],
          details: { language: targetLang, surface: surfaceFilter },
        };
      },
    });
  }

  // 5. Pre-flight prompt inspection (Eje 1: Pre-vuelo)
  pi.on('input', async (event: any, ctx: any) => {
    try {
      if (!event || event.source === 'extension') {
        return { action: 'continue' };
      }

      const promptText = typeof event.text === 'string' ? event.text : '';
      if (!promptText.trim()) {
        return { action: 'continue' };
      }

      const cwd = ctx?.cwd || process.cwd();
      const rawPlaybooks = await getActiveWorkspacePlaybooks(cwd, storage);
      const playbooksToCheck = maskSubordinatePlaybooks(rawPlaybooks);

      if (playbooksToCheck.length === 0) return { action: 'continue' };

      // El pre-vuelo en input es estrictamente determinístico y ultra-rápido en memoria (<1ms).
      // No invoca APIs de LLM síncronas para evitar bloquear el event loop de la UI de Pi.
      const originalText = promptText;

      // Evaluación compartida runtime-agnostic: recolecta violaciones y ASKs
      // disparadas para todas las capas activas (misma entrada, mismo orden).
      const evaluation = await evaluateWorkspacePrompt(promptText, playbooksToCheck);

      const violationByPlaybook = new Map(evaluation.violations.map((entry) => [entry.playbook, entry.violation]));
      const askByPlaybook = new Map(evaluation.asks.map((entry) => [entry.playbook, entry.ask]));

      // Paridad con el handler Pi del baseline: las capas se procesan una a una,
      // en orden de capa, y dentro de cada capa la violación va antes que el ASK.
      for (const pb of playbooksToCheck) {
        const violation = violationByPlaybook.get(pb);
        if (violation) {
          const pbName = playbookDisplayName(pb);
          const ruleId = violation.rule.id.toUpperCase();

        // Caso 1: Intento explícito de eludir checkpoints o apagar el playbook
        if (isBypassViolation(violation)) {
          if (ctx.ui?.confirm) {
            const confirmed = await ctx.ui.confirm(
              '⚠️ Intento de Bypass de Gobernanza',
              `El prompt intenta eludir un control obligatorio de ${pbName}:\n\n` +
                `Regla [${ruleId}]: ${violation.rule.description}\n` +
                `Motivo: ${violation.reason}\n\n` +
                `¿Autorizas explícitamente omitir este control?`
            );
            if (!confirmed) {
              ctx.ui?.notify('Operación cancelada: Se respetan los controles de gobernanza.', 'info');
              return { action: 'handled' };
            }
          } else {
            // Fail-safe estricto en entornos headless con mensaje visible (no silencioso)
            const msg = buildBypassBlockedMessage();
            if (ctx.ui?.notify) ctx.ui.notify(msg, 'error');
            console.error(msg);
            return { action: 'handled' };
          }
        } else {
          // Caso 2: Conflicto de superficie/carpeta o kit vetado
          const targetSurface = (violation.rule as any).surface || 'la superficie canónica del playbook';
          if (ctx.ui?.select) {
            const choice = await ctx.ui.select(
              `⚠️ Conflicto con Playbook (${pbName})`,
              [
                `🛡️ Redirigir a la arquitectura canónica (${targetSurface}) [Recomendado]`,
                `⚠️ Permitir excepción por esta única vez (escribir donde se solicitó)`,
                `❌ Cancelar la operación`,
              ]
            );
            if (!choice || choice.includes('Cancelar')) {
              ctx.ui?.notify('Operación cancelada para respetar el playbook.', 'info');
              return { action: 'handled' };
            }
            if (choice.includes('Redirigir')) {
              event.text = `${event.text}\n\n[DIRECTIVA DE GOBERNANZA PLAYBOOK]: El usuario seleccionó REDIRIGIR a la arquitectura canónica. Implementa completamente el requerimiento solicitado ("${promptText}"), pero ubica los archivos exclusivamente en "${targetSurface}" y sin usar kits o tecnologías vetadas por la regla [${ruleId}]. Explica claramente esta redirección al inicio de tu respuesta.`;
            }
          } else if (ctx.ui?.confirm) {
            const confirmed = await ctx.ui.confirm(
              '⚠️ Conflicto con Playbook',
              `Esta acción entra en conflicto con ${pbName}:\n\n` +
                `Regla [${ruleId}]: ${violation.rule.description}\n` +
                `Motivo: ${violation.reason}\n\n` +
                `¿Deseas continuar permitiendo esta excepción?`
            );

            if (!confirmed) {
              ctx.ui?.notify('Acción cancelada para respetar el playbook.', 'info');
              return { action: 'handled' };
            }
          } else {
            // Modo desatendido / headless / --print: Jamás aborto mudo. El playbook orienta y redirige.
            event.text = `${event.text}\n\n${buildHeadlessRedirectDirective(promptText, ruleId, violation.reason, targetSurface)}`;
          }
        }
        continue;
        }

        const askMatch = askByPlaybook.get(pb);
        if (!askMatch) continue;
        const askId = askMatch.rule.id.toUpperCase();
        if (ctx.ui?.confirm) {
          const askTitle = askMatch.rule.title ? ` - ${askMatch.rule.title}` : '';
          const applyExtra = await ctx.ui.confirm(
            `💡 Playbook (${pb.language.toUpperCase()}): [ASK:${askId}]${askTitle}`,
            `${askMatch.prompt}\n\n(Default: ${askMatch.defaultAction})`
          );
          if (applyExtra) {
            event.text = `${event.text}\n\n[DIRECTIVA DE GOBERNANZA PLAYBOOK]: El usuario autorizó aplicar la regla [ASK:${askId}]. Implementa completamente el requerimiento solicitado ("${promptText}") e INCLUYE el extra aprobado (${askMatch.prompt}).`;
          } else {
            event.text = `${event.text}\n\n[DIRECTIVA DE GOBERNANZA PLAYBOOK]: El usuario declinó aplicar el extra de la regla [ASK:${askId}]. Implementa completamente el requerimiento solicitado ("${promptText}") pero NO apliques el extra (${askMatch.defaultAction}).`;
          }
        } else {
          // Modo desatendido / headless: aplicar el default pero construyendo el feature base
          event.text = `${event.text}\n\n${buildAskDefaultDirective(promptText, askId, askMatch.defaultAction)}`;
        }
      }

      if (event.text !== originalText) {
        return { action: 'transform', text: event.text };
      }
      return { action: 'continue' };
    } catch {
      return { action: 'continue' };
    }
  });

  // 6. Write/Edit Path Enforcement Barrier (Eje 1: Barrera tool_call)
  pi.on('tool_call', async (event: any, ctx: any) => {
    try {
      if (!event || (event.toolName !== 'write' && event.toolName !== 'edit')) {
        return undefined;
      }

      const targetPath = typeof event.input?.path === 'string' ? event.input.path : '';
      if (!targetPath.trim()) return undefined;

      const cwd = ctx?.cwd || process.cwd();
      const rawPlaybooks = await getActiveWorkspacePlaybooks(cwd, storage);
      const playbooksToCheck = maskSubordinatePlaybooks(rawPlaybooks);
      const agentPrefs = await storage.getAgentPreferences();

      if (playbooksToCheck.length === 0) return undefined;

      // 1. Evaluar restricciones operativas de Agent Preferences en la herramienta (never, ask, invariants)
      if (agentPrefs) {
        const toolAction = event.toolName;

        // 1.1 Never Rules (Prohibiciones terminantes de herramientas)
        for (const never of agentPrefs.neverRules || []) {
          if (matchesAgentToolSurface(never.surface, toolAction)) {
            const reason = buildAgentNeverBlockReason(never);
            ctx.ui?.notify?.(reason, 'error');
            return { block: true, reason };
          }
        }

        // 1.2 Ask Rules (Puntos de control condicionales)
        for (const ask of agentPrefs.askRules || []) {
          if (matchesAgentToolSurface(ask.surface, toolAction)) {
            if (ctx.ui?.confirm) {
              const confirmed = await ctx.ui.confirm(
                '🤖 Punto de Control de Agente [ASK]',
                `${ask.prompt}\n\n(Default: ${ask.defaultAction})`
              );
              if (!confirmed) {
                return {
                  block: true,
                  reason: `Operación bloqueada por decisión del usuario en punto de control [${ask.id.toUpperCase()}]: ${ask.defaultAction}`,
                };
              }
            } else {
              return {
                block: true,
                reason: buildAgentAskHeadlessBlockReason(ask),
              };
            }
          }
        }

        // 1.3 Invariants (Límites operativos obligatorios)
        for (const inv of agentPrefs.invariants || []) {
          if (matchesAgentToolSurface(inv.surface, toolAction)) {
            if (ctx.ui?.confirm) {
              const confirmed = await ctx.ui.confirm(
                '🤖 Supervisión de Agente (Límite Operativo)',
                `El agente intenta ejecutar la acción "${toolAction}" sobre "${targetPath}":\n\n` +
                  `Regla [${inv.id.toUpperCase()}]: ${inv.description}\n\n` +
                  `¿Autorizas la ejecución de esta herramienta?`
              );
              if (!confirmed) {
                ctx.ui?.notify?.(`Operación ${toolAction} bloqueada por supervisión de agente.`, 'warning');
                return {
                  block: true,
                  reason: `Operación bloqueada por regla de supervisión [${inv.id.toUpperCase()}]: ${inv.description}`,
                };
              }
            } else {
              return {
                block: true,
                reason: buildAgentInvariantHeadlessBlockReason(inv, toolAction),
              };
            }
          }
        }
      }

      for (const pb of playbooksToCheck) {
        const pathViolation = checkPathViolation(targetPath, pb, cwd);
        if (pathViolation) {
          const pbName = playbookDisplayName(pb);
          if (ctx.ui?.confirm) {
            const confirmed = await ctx.ui.confirm(
              '⚠️ Violación de Playbook',
              `El agente intenta modificar una ruta que viola ${pbName}:\n\n` +
                `Regla [${pathViolation.rule.id.toUpperCase()}]: ${pathViolation.rule.description}\n` +
                `Ruta: ${targetPath}\n` +
                `Motivo: ${pathViolation.reason}\n\n` +
                `¿Deseas autorizar la escritura en esta ruta de todas formas?`
            );

            if (!confirmed) {
              ctx.ui?.notify(`Escritura en "${targetPath}" bloqueada para respetar el playbook.`, 'warning');
              return {
                block: true,
                reason: `Operación bloqueada por el usuario para respetar la regla [${pathViolation.rule.id.toUpperCase()}]: ${pathViolation.rule.description}`,
              };
            }
          } else {
            // Fail-safe en entornos headless/desatendidos
            return {
              block: true,
              reason: buildPathViolationBlockReason(targetPath, pathViolation as any),
            };
          }
        }
      }

      return undefined;
    } catch (err: any) {
      const errMsg = `Error interno en la barrera de gobernanza: ${err?.message || String(err)}`;
      ctx.ui?.notify?.(`⚠️ ${errMsg}`, 'error');
      console.error(errMsg);
      return {
        block: true,
        reason: errMsg,
      };
    }
  });
}
