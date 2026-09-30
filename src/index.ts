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
  evaluatePromptFull,
  checkAskTrigger,
  PromptEvaluationResult,
} from './core/checker.js';
import { getLanguageMenuLabels, resolveLanguage } from './core/languages.js';

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

  // 1. Pregunta 1: ¿Qué tipo de regla es (Agente vs Lenguaje)?
  if (!targetLang) {
    if (ctx.ui?.select) {
      const categoryChoice = await ctx.ui.select(
        '¿Qué tipo de regla deseas registrar?',
        [
          '🤖 Preferencias de Agente (Supervisión y Gobernanza de IA)',
          '💻 Regla de Arquitectura de Lenguaje (Go, TypeScript, etc.)',
        ]
      );
      if (!categoryChoice) return;

      if (categoryChoice.includes('Agente')) {
        targetLang = AGENTS_PREFERENCES_ID;
      } else {
        const selected = await ctx.ui.select(
          '¿Para qué lenguaje es esta regla de arquitectura?',
          getLanguageMenuLabels()
        );
        if (!selected) return;
        targetLang = resolveLanguage(selected);
      }
    } else {
      targetLang = 'go';
    }
  } else {
    targetLang = resolveLanguage(targetLang);
  }

  const isAgent = targetLang === AGENTS_PREFERENCES_ID;
  const targetDisplayName = isAgent ? 'Agents Preferences' : targetLang.toUpperCase();

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
    const prompt = buildSynthesisPrompt(targetLang, rawDescription.trim(), ruleType, {
      prohibitionScope,
      customScopeText,
    });
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
      synthesized = parseSynthesizedRule(rawResponse, ruleType, targetLang);
    }
  } catch (err: any) {
    ctx.ui?.notify(`Error al sintetizar la regla: ${err.message}`, 'error');
    return;
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

  // 6. Save to storage
  let pb: Playbook | null = await storage.getPlaybook(targetLang);
  if (!pb) {
    pb = {
      language: targetLang,
      version: 1,
      updatedAt: new Date().toISOString().split('T')[0],
      topology: {
        pattern: isAgent ? 'Agent Runtime' : 'Standard Layout',
        directories: isAgent ? [] : ['src/'],
      },
      invariants: [],
      askRules: [],
      snippets: [],
    };
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
  await storage.savePlaybook(pb);

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

          const existing = await storage.getPlaybook(detectedLang);
          ctx.ui?.notify('Comparando semánticamente reglas con tu playbook existente...', 'info');
          let diff: PlaybookDiffResult;
          try {
            diff = await computeSemanticPlaybookDiff(draft, existing, completePrompt);
          } catch {
            ctx.ui?.notify('❌ Ha habido un problema con tu agente, reintenta.', 'error');
            return;
          }

          // Si hay reporte de evidencia, mostrárselo al usuario
          if (evidenceReport) {
            pi.sendMessage({
              customType: 'gentle-playbook-evidence',
              content: `### 📊 Reporte de Evidencia de Extracción\n\n${evidenceReport}`,
              display: true,
            });
          }

          const resolutions: Record<string, RuleResolution> = {};

          // Si hay conflictos y la UI está disponible, resolver 1 a 1 interactivamente (#4 A, #4 C)
          if (diff.stats.conflictRules > 0) {
            ctx.ui?.notify(
              `Se detectaron ${diff.stats.conflictRules} conflicto(s) con tu playbook existente. Iniciando resolución interactiva...`,
              'info'
            );

            // Recolectar items en conflicto
            const conflicts: {
              type: 'invariant' | 'ask' | 'never' | 'snippet';
              id: string;
              reason?: string;
              existing: any;
              incoming: any;
            }[] = [];

            for (const d of diff.invariants) {
              if (d.status === 'conflict') {
                conflicts.push({ type: 'invariant', id: d.incoming.id, reason: d.reason, existing: d.existing, incoming: d.incoming });
              }
            }
            for (const d of diff.askRules) {
              if (d.status === 'conflict') {
                conflicts.push({ type: 'ask', id: d.incoming.id, reason: d.reason, existing: d.existing, incoming: d.incoming });
              }
            }
            for (const d of diff.neverRules) {
              if (d.status === 'conflict') {
                conflicts.push({ type: 'never', id: d.incoming.id, reason: d.reason, existing: d.existing, incoming: d.incoming });
              }
            }
            for (const d of diff.snippets) {
              if (d.status === 'conflict') {
                conflicts.push({ type: 'snippet', id: d.incoming.id, reason: d.reason, existing: d.existing, incoming: d.incoming });
              }
            }

            const total = conflicts.length;
            for (let i = 0; i < total; i++) {
              const c = conflicts[i];

              const existDesc = c.existing.description || c.existing.prompt || c.existing.code || '';
              const incDesc = c.incoming.description || c.incoming.prompt || c.incoming.code || '';
              const existSurface = c.existing.surface ? `\`${c.existing.surface}\`` : 'N/A';
              const incSurface = c.incoming.surface ? `\`${c.incoming.surface}\`` : 'N/A';
              const existTitle = c.existing.title || c.id;
              const incTitle = c.incoming.title || c.id;

              pi.sendMessage({
                customType: 'gentle-playbook-conflict',
                content: `### ⚔️ Conflicto (${i + 1}/${total}): [${c.type.toUpperCase()}:${c.id}]\n\n` +
                  `**Versión Actual (En tu Playbook):**\n` +
                  `- **Título:** ${existTitle}\n` +
                  `- **Surface:** ${existSurface}\n` +
                  `- **Texto/Código:** ${existDesc}\n\n` +
                  `**Versión Nueva (Propuesta por el Extract):**\n` +
                  `- **Título:** ${incTitle}\n` +
                  `- **Surface:** ${incSurface}\n` +
                  `- **Texto/Código:** ${incDesc}\n\n` +
                  `*Motivo de discrepancia:* ${c.reason || 'Difiere del contenido guardado'}`,
                display: true,
              });

              if (ctx.ui?.select) {
                const choice = await ctx.ui.select(
                  `[Conflicto ${i + 1}/${total}: ${c.id}] Selecciona la acción para resolver:`,
                  [
                    '🛡️ 1. Conservar versión actual (mantener mi regla existente)',
                    '📥 2. Reemplazar por la nueva versión (adoptar propuesta del extract)',
                    '💡 3. Convertir en regla condicional (crear Ask Rule con la nueva)',
                    '🤖 4. Instruir a la IA para fusionar/resolver (dar indicación en lenguaje natural)',
                    '❌ Cancelar todo el merge (no guardar cambios en disco)',
                  ]
                );

                if (!choice || choice.includes('Cancelar')) {
                  ctx.ui?.notify('Extracción cancelada por el usuario. No se guardaron cambios en disco.', 'info');
                  return;
                }

                if (choice.includes('1. Conservar')) {
                  resolutions[c.id] = { ruleId: c.id, action: 'reject' };
                } else if (choice.includes('2. Reemplazar')) {
                  resolutions[c.id] = { ruleId: c.id, action: 'accept' };
                } else if (choice.includes('3. Convertir')) {
                  resolutions[c.id] = {
                    ruleId: c.id,
                    action: c.type === 'invariant' ? 'convert_to_ask' : 'convert_to_invariant',
                  };
                } else if (choice.includes('4. Instruir a la IA')) {
                  if (ctx.ui?.input) {
                    const userInstruction = await ctx.ui.input(
                      `[${c.id}] Escribe tu instrucción para la IA (ej: 'fusiona ambas...', 'conserva la surface de A pero texto de B'):`,
                      'Fusiona ambas reglas tomando lo mejor de cada una'
                    );
                    if (userInstruction && userInstruction.trim()) {
                      ctx.ui?.notify('Sintetizando regla unificada con la IA...', 'info');
                      let aiResolved;
                      try {
                        aiResolved = await resolveConflictWithAI({
                          ruleType: c.type,
                          language: detectedLang,
                          existingRule: c.existing,
                          incomingRule: c.incoming,
                          userInstruction: userInstruction.trim(),
                          completePrompt,
                        });
                      } catch {
                        ctx.ui?.notify('❌ Ha habido un problema con tu agente, reintenta.', 'error');
                        return;
                      }

                      resolutions[c.id] = {
                        ruleId: c.id,
                        action: 'custom_edit',
                        customTitle: aiResolved.title,
                        customSurface: aiResolved.surface,
                        customDescription: aiResolved.description,
                      };

                      pi.sendMessage({
                        customType: 'gentle-playbook-ai-resolution',
                        content: `✓ **Regla sintetizada por IA para \`${c.id}\`:**\n` +
                          `- **Título:** ${aiResolved.title}\n` +
                          `- **Surface:** \`${aiResolved.surface}\`\n` +
                          `- **Descripción:** ${aiResolved.description}`,
                        display: true,
                      });
                    } else {
                      resolutions[c.id] = { ruleId: c.id, action: 'reject' };
                    }
                  } else {
                    resolutions[c.id] = { ruleId: c.id, action: 'reject' };
                  }
                }
              }
            }
          }

          // Confirmación interactiva si la UI lo permite, o fail-safe sin UI
          if (ctx.ui?.confirm) {
            const summaryParts = [];
            if (diff.stats.newRules > 0) summaryParts.push(`${diff.stats.newRules} nuevas`);
            if (diff.stats.conflictRules > 0) summaryParts.push(`${diff.stats.conflictRules} conflictos arbitrados`);
            const summaryStr = summaryParts.length > 0 ? summaryParts.join(', ') : 'sin cambios estructurales';

            const confirmed = await ctx.ui.confirm(
              'Aprobar guardado de playbook',
              `¿Deseas guardar los cambios en el playbook de ${detectedLang}? (${summaryStr})`
            );
            if (!confirmed) {
              ctx.ui?.notify('Guardado cancelado por el usuario. No se modificó el playbook en disco.', 'info');
              return;
            }
          } else if (!autoConfirm) {
            // Fail-safe: Sin confirmación interactiva y sin --yes, no se escribe en disco
            ctx.ui?.notify(
              'Extracción completada sin guardar: se requiere confirmación interactiva o el flag --yes para escribir en disco.',
              'warning'
            );
            pi.sendMessage({
              customType: 'gentle-playbook-draft',
              content: `⚠️ **Extracción finalizada (Solo Lectura):**\nNo hay interfaz interactiva de confirmación y no se pasó \`--yes\`. No se modificó el disco.\n\n` + formatPlaybookForDisplay(mergePlaybooks(draft, existing, resolutions, diff)),
              display: true,
            });
            return;
          }

          const merged = mergePlaybooks(draft, existing, resolutions, diff);
          await storage.savePlaybook(merged);

          let conflictMsg = '';
          if (diff.stats.conflictRules > 0) {
            const resCount = Object.keys(resolutions).length;
            if (resCount > 0) {
              const accepted = Object.values(resolutions).filter((r) => r.action === 'accept').length;
              const converted = Object.values(resolutions).filter((r) => r.action.startsWith('convert')).length;
              const aiCustom = Object.values(resolutions).filter((r) => r.action === 'custom_edit').length;
              const kept = Object.values(resolutions).filter((r) => r.action === 'reject').length;
              const details: string[] = [];
              if (accepted > 0) details.push(`${accepted} reemplazadas`);
              if (aiCustom > 0) details.push(`${aiCustom} fusionadas con IA`);
              if (converted > 0) details.push(`${converted} convertidas`);
              if (kept > 0) details.push(`${kept} conservadas`);
              const detailStr = details.length > 0 ? ` (${details.join(', ')})` : '';
              conflictMsg = `, ${resCount} conflictos arbitrados${detailStr}`;
            } else {
              conflictMsg = `, ${diff.stats.conflictRules} conflictos (versiones existentes preservadas)`;
            }
          }

          ctx.ui?.notify(
            `Playbook para ${detectedLang} actualizado: ${diff.stats.newRules} nuevas, ${diff.stats.identicalRules} idénticas${conflictMsg}.`,
            'info'
          );

          pi.sendMessage({
            customType: 'gentle-playbook',
            content: formatPlaybookForDisplay(merged),
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

  // 3. Auto-detection on session_start
  pi.on('session_start', async (_event: any, ctx: any) => {
    if (await storage.hasAgentPreferences()) {
      ctx.ui?.notify(
        '[gentle-playbook] Agent Preferences active (Supervision & Governance available via playbook_consult tool)',
        'info'
      );
    }

    const cwd = ctx.cwd || process.cwd();
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
    const detectedLang = await detectProjectLanguage(cwd);
    const hasLangPlaybook =
      detectedLang && detectedLang !== 'generic' && (await storage.exists(detectedLang));
    const hasAgentPrefs = await storage.hasAgentPreferences();

    if (!hasLangPlaybook && !hasAgentPrefs) return;

    if (!event.systemPromptOptions) {
      event.systemPromptOptions = { sections: {} };
    }
    if (!event.systemPromptOptions.sections) {
      event.systemPromptOptions.sections = {};
    }

    const targets: string[] = [];
    if (hasLangPlaybook) targets.push(`playbook de ${detectedLang.toUpperCase()}`);
    if (hasAgentPrefs) targets.push('preferencias de gobernanza de agente');

    event.systemPromptOptions.sections.playbook_guidance =
      `[gentle-playbook] Este workspace cuenta con normas activas (${targets.join(', ')}). ` +
      `Antes de estructurar, planificar, generar o modificar código o ejecutar acciones operativas en este proyecto, ` +
      `debes consultar la herramienta \`playbook_consult\` para conocer la topología, invariantes, estándares y prohibiciones vinculantes del repositorio.`;
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
        } else if (targetLang) {
          const resolved = resolveLanguage(targetLang);
          const pb = await storage.getPlaybook(resolved);
          if (pb) {
            results.push(formatPlaybookForTool(pb, surfaceFilter));
          } else {
            results.push(`No playbook found for language '${targetLang}'.`);
          }
        } else {
          // Auto-detect project language and include agent preferences if present
          const detected = await detectProjectLanguage(cwd);
          let foundAny = false;

          if (detected && detected !== 'generic') {
            const pb = await storage.getPlaybook(detected);
            if (pb) {
              results.push(formatPlaybookForTool(pb, surfaceFilter));
              foundAny = true;
            }
          }

          const agentPrefs = await storage.getAgentPreferences();
          if (
            agentPrefs &&
            (agentPrefs.invariants.length > 0 ||
              agentPrefs.askRules.length > 0 ||
              (agentPrefs.neverRules && agentPrefs.neverRules.length > 0))
          ) {
            results.push(formatAgentPreferencesForTool(agentPrefs, surfaceFilter));
            foundAny = true;
          }

          if (!foundAny) {
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
      const detectedLang = await detectProjectLanguage(cwd);
      const playbooksToCheck: Playbook[] = [];

      if (detectedLang && detectedLang !== 'generic') {
        const activePb = await storage.getPlaybook(detectedLang);
        if (activePb) playbooksToCheck.push(activePb);
      }

      const agentPrefs = await storage.getAgentPreferences();
      if (agentPrefs) playbooksToCheck.push(agentPrefs);

      if (playbooksToCheck.length === 0) return { action: 'continue' };

      // Si hay modelo disponible en Pi, usamos el Agente para la evaluación semántica real
      let completePrompt: ((prompt: string) => Promise<string>) | undefined;
      if (ctx?.modelRegistry && ctx?.model) {
        completePrompt = async (p: string) => {
          const completion = await ctx.modelRegistry.complete(ctx.model, {
            messages: [{ role: 'user', content: p }],
          });
          return (
            completion?.content
              ?.filter((c: any) => c.type === 'text')
              .map((c: any) => c.text || '')
              .join('') || ''
          );
        };
      }

      const originalText = promptText;

      for (const pb of playbooksToCheck) {
        let evaluation: PromptEvaluationResult;
        if (completePrompt) {
          evaluation = await evaluatePromptFull(promptText, pb, completePrompt);
        } else {
          evaluation = await evaluatePromptFull(promptText, pb);
        }

        const violation = evaluation.violation;

        if (violation) {
          const pbName = pb.language === AGENTS_PREFERENCES_ID ? 'Agents Preferences' : pb.language.toUpperCase();
          const ruleId = violation.rule.id.toUpperCase();
          const isBypass =
            violation.kind === 'checkpoint_bypass' ||
            violation.kind === 'playbook_bypass' ||
            violation.kind === 'agent_governance_violation';

          // Caso 1: Intento explícito de eludir checkpoints o apagar el playbook
          if (isBypass) {
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
              const msg = `❌ [GOBERNANZA PLAYBOOK] Operación bloqueada: No se permite omitir puntos de control ("sin consultar") en entornos desatendidos sin confirmación interactiva.`;
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
              event.text = `${event.text}\n\n[ADVERTENCIA DE GOBERNANZA PLAYBOOK]: El requerimiento entra en conflicto con la regla [${ruleId}]: ${violation.reason}. En modo desatendido se aplica la arquitectura canónica: implementa el feature solicitado ("${promptText}") ubicando el código exclusivamente en "${targetSurface}" y sin usar las tecnologías prohibidas. Detalla esta decisión al inicio de tu respuesta.`;
            }
          }
        } else {
          // Si no hubo violación, verificar si el prompt activa una regla ASK
          const askMatch = evaluation.triggeredAsk || checkAskTrigger(promptText, pb);
          if (askMatch) {
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
              event.text = `${event.text}\n\n[DIRECTIVA DE GOBERNANZA PLAYBOOK]: Ejecución desatendida. Para la regla [ASK:${askId}], aplica la acción por defecto: "${askMatch.defaultAction}". Implementa completamente el requerimiento base solicitado ("${promptText}") respetando este default.`;
            }
          }
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
      const detectedLang = await detectProjectLanguage(cwd);
      const playbooksToCheck: Playbook[] = [];

      if (detectedLang && detectedLang !== 'generic') {
        const activePb = await storage.getPlaybook(detectedLang);
        if (activePb) playbooksToCheck.push(activePb);
      }

      const agentPrefs = await storage.getAgentPreferences();
      if (agentPrefs) playbooksToCheck.push(agentPrefs);

      if (playbooksToCheck.length === 0) return undefined;

      // 1. Evaluar restricciones operativas de Agent Preferences en la herramienta (never, ask, invariants)
      if (agentPrefs) {
        const toolAction = event.toolName;
        const isToolMatch = (ruleSurface?: string) => {
          if (!ruleSurface) return false;
          const surfaces = ruleSurface.toLowerCase().split(',').map((s) => s.trim());
          return surfaces.some(
            (s) =>
              s === 'tools:all' ||
              s === `tools:${toolAction}` ||
              s === 'tools:write' ||
              s === 'tools:edit' ||
              s === 'tools'
          );
        };

        // 1.1 Never Rules (Prohibiciones terminantes de herramientas)
        for (const never of agentPrefs.neverRules || []) {
          if (isToolMatch(never.surface)) {
            const reason = `Operación bloqueada por prohibición de agente [${never.id.toUpperCase()}]: ${never.description}`;
            ctx.ui?.notify?.(reason, 'error');
            return { block: true, reason };
          }
        }

        // 1.2 Ask Rules (Puntos de control condicionales)
        for (const ask of agentPrefs.askRules || []) {
          if (isToolMatch(ask.surface)) {
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
                reason: `Operación bloqueada en modo desatendido por punto de control [${ask.id.toUpperCase()}]: ${ask.defaultAction}`,
              };
            }
          }
        }

        // 1.3 Invariants (Límites operativos obligatorios)
        for (const inv of agentPrefs.invariants || []) {
          if (isToolMatch(inv.surface)) {
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
                reason: `Operación bloqueada: la acción "${toolAction}" requiere autorización interactiva según la regla [${inv.id.toUpperCase()}]: ${inv.description}`,
              };
            }
          }
        }
      }

      for (const pb of playbooksToCheck) {
        const pathViolation = checkPathViolation(targetPath, pb, cwd);
        if (pathViolation) {
          const pbName = pb.language === AGENTS_PREFERENCES_ID ? 'Agents Preferences' : pb.language.toUpperCase();
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
              reason: `Operación bloqueada: la ruta "${targetPath}" viola la regla [${pathViolation.rule.id.toUpperCase()}]: ${pathViolation.rule.description}. Debes ubicar este código exclusivamente dentro de "${pathViolation.rule.surface}".`,
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
