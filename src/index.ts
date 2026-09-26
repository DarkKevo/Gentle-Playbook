import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { PlaybookStorage } from './core/storage.js';
import { detectProjectLanguage, detectProjectLanguages } from './extract/extractor.js';
import { runAgentExtraction } from './extract/agent-extractor.js';
import { computePlaybookDiff, mergePlaybooks, RuleResolution, PlaybookDiffResult } from './core/diff.js';
import { computeSemanticPlaybookDiff, resolveConflictWithAI } from './core/semantic-diff.js';
import { formatPlaybookForDisplay, formatPlaybookForSystemPrompt, formatAgentPreferencesForSystemPrompt } from './core/parser.js';
import { InvariantRule, AskRule, RuleType, Playbook, AGENTS_PREFERENCES_ID } from './core/schema.js';
import { buildSynthesisPrompt, parseSynthesizedRule, SynthesizedRule } from './core/synthesizer.js';
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
  on(event: string, handler: (event: any, ctx: any) => Promise<void>): void;
}

async function handleAddRule(
  args: string,
  ctx: any,
  storage: PlaybookStorage,
  pi: ExtensionAPI
): Promise<void> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  let targetLang = parts[0] === 'add' ? parts[1] : parts[0];

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

  // 3. Selection of Rule Type: Normativa vs Ask
  let ruleType: RuleType = 'invariant';
  if (ctx.ui?.select) {
    const typeOptions = isAgent
      ? [
          '🛡️ Normativa (Límite operativo no negociable / Restricción estricta)',
          '💡 Ask (Punto de control / Preguntar al usuario antes de actuar)',
        ]
      : [
          '🛡️ Normativa (Invariante no negociable)',
          '💡 Ask (Patrón condicional / Receta con pregunta)',
        ];

    const typeChoice = await ctx.ui.select(
      isAgent ? '¿Qué tipo de regla de supervisión es?' : '¿Qué tipo de regla es?',
      typeOptions
    );
    if (!typeChoice) return;
    if (typeChoice.includes('Ask')) {
      ruleType = 'ask';
    }
  }

  // 4. Synthesize with LLM via modelRegistry
  ctx.ui?.notify('Procesando y sintetizando regla con el modelo...', 'info');

  let synthesized: SynthesizedRule;
  try {
    const prompt = buildSynthesisPrompt(targetLang, rawDescription.trim(), ruleType);
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
        surface: isAgent ? 'tools:all' : 'src/',
        description: rawDescription.trim(),
        trigger: isAgent ? 'Al intentar ejecutar acciones en esta superficie' : 'Al implementar esta funcionalidad',
        antiTrigger: isAgent ? 'En tareas de solo lectura' : 'En contextos no aplicables',
        prompt: `¿Deseas proceder con ${rawDescription.slice(0, 30)}?`,
        defaultAction: isAgent ? 'Detener la acción y pedir instrucciones' : 'Continuar sin esta regla',
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
  } else {
    preview = `Título: [ASK] ${synthesized.title}\nSurface: ${synthesized.surface}\nTrigger: ${synthesized.trigger}\nAnti-Trigger: ${synthesized.antiTrigger}\nPregunta: "${synthesized.prompt}"\nDefault: ${synthesized.defaultAction}`;
  }

  // Confirm dialog
  let confirmed = true;
  if (ctx.ui?.confirm) {
    confirmed = await ctx.ui.confirm(
      `¿Deseas guardar esta regla en ${targetDisplayName}?`,
      preview
    );
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
          ctx.ui?.notify('gentle-playbook: No playbooks found in storage.', 'info');
          return;
        }

        const options: string[] = [];
        if (hasAgents) {
          options.push('🤖 agents-preferences (Gobernanza de Agente)');
        }
        options.push(...languages);

        if (ctx.ui?.select) {
          const selected = await ctx.ui.select(
            'Select a playbook to view:',
            options
          );
          if (selected && typeof selected === 'string') {
            const cleanId = selected.includes('agents-preferences') ? AGENTS_PREFERENCES_ID : selected;
            const pb = await storage.getPlaybook(cleanId);
            if (pb) {
              const label = pb.language === AGENTS_PREFERENCES_ID ? 'Agents Preferences' : pb.language.toUpperCase();
              const summary = `${label} (v${pb.version}): ${pb.invariants.length} normativas, ${pb.askRules.length} ask rules`;
              ctx.ui?.notify(summary, 'info');

              pi.sendMessage({
                customType: 'gentle-playbook',
                content: formatPlaybookForDisplay(pb, { includeSnippets }),
                display: true,
              });
            }
          }
        } else {
          ctx.ui?.notify(`Available playbooks: ${options.join(', ')}`, 'info');
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
      } else if (sub === 'extract') {
        let inputPath: string | undefined;
        let langOverride: string | undefined;

        for (let i = 1; i < parts.length; i++) {
          if (parts[i] === '--lang') {
            if (parts[i + 1] && !parts[i + 1].startsWith('--')) {
              langOverride = resolveLanguage(parts[i + 1]);
              i++;
            }
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

          // Confirmación interactiva si la UI lo permite
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
        '[gentle-playbook] Agent Preferences active (Supervision & Governance loaded)',
        'info'
      );
    }

    const cwd = ctx.cwd || process.cwd();
    const detectedLang = await detectProjectLanguage(cwd);

    if (detectedLang && detectedLang !== 'generic') {
      const exists = await storage.exists(detectedLang);
      if (exists) {
        ctx.ui?.notify(
          `[gentle-playbook] Active ${detectedLang.toUpperCase()} playbook loaded from ~/.config/gentle-playbook/languages/${detectedLang}.md`,
          'info'
        );
      }
    }
  });

  // 4. Runtime Invariant & Ask Enforcement via before_agent_start
  pi.on('before_agent_start', async (event: any, ctx: any) => {
    const promptParts: string[] = [];

    // 1. Cargar SIEMPRE Agents Preferences si existen
    const agentPrefs = await storage.getAgentPreferences();
    if (
      agentPrefs &&
      (agentPrefs.invariants.length > 0 ||
        agentPrefs.askRules.length > 0 ||
        (agentPrefs.neverRules && agentPrefs.neverRules.length > 0))
    ) {
      promptParts.push(formatAgentPreferencesForSystemPrompt(agentPrefs));
    }

    // 2. Cargar Playbook del lenguaje si se detecta
    const cwd = ctx.cwd || process.cwd();
    const detectedLang = await detectProjectLanguage(cwd);
    if (detectedLang && detectedLang !== 'generic') {
      const pb = await storage.getPlaybook(detectedLang);
      if (pb) {
        promptParts.push(formatPlaybookForSystemPrompt(pb));
      }
    }

    if (promptParts.length === 0) return;

    const fullPrompt = promptParts.join('\n\n---\n\n');
    if (event.systemPromptOptions?.sections) {
      event.systemPromptOptions.sections['gentle_playbook'] = fullPrompt;
    } else if (event.systemPromptOptions) {
      event.systemPromptOptions.appendSystemPrompt =
        (event.systemPromptOptions.appendSystemPrompt || '') + '\n\n' + fullPrompt;
    }
  });
}
