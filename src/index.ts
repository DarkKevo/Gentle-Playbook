import * as path from 'node:path';
import { PlaybookStorage } from './core/storage.js';
import { extractPlaybook, detectProjectLanguage } from './extract/extractor.js';
import { computePlaybookDiff, mergePlaybooks } from './core/diff.js';
import { formatPlaybookForDisplay } from './core/parser.js';
import { InvariantRule, AskRule, RuleType, Playbook } from './core/schema.js';
import { buildSynthesisPrompt, parseSynthesizedRule, SynthesizedRule } from './core/synthesizer.js';

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

  // 1. Language resolution
  if (!targetLang) {
    const cwd = ctx.cwd || process.cwd();
    const detected = await detectProjectLanguage(cwd);
    if (detected && detected !== 'generic') {
      targetLang = detected;
    } else {
      const languages = await storage.listLanguages();
      const options = languages.length > 0 ? languages : ['go', 'typescript', 'python', 'rust'];
      if (ctx.ui?.select) {
        const selected = await ctx.ui.select('Selecciona el lenguaje para agregar la regla:', options);
        if (!selected) return;
        targetLang = selected;
      } else {
        targetLang = 'go';
      }
    }
  }

  targetLang = targetLang.toLowerCase();

  // 2. Input dialog for preference text
  if (!ctx.ui?.input) {
    ctx.ui?.notify('Error: UI no disponible para capturar la regla.', 'error');
    return;
  }

  const rawDescription = await ctx.ui.input(
    `[${targetLang.toUpperCase()}] Escribe tu preferencia arquitectónica o norma:`,
    'Ej: me gusta colocar rate limit en situaciones donde son rutas peligrosas como logins...'
  );

  if (!rawDescription || !rawDescription.trim()) {
    ctx.ui?.notify('Operación cancelada: No se ingresó ninguna descripción.', 'info');
    return;
  }

  // 3. Selection of Rule Type: Normativa vs Ask
  let ruleType: RuleType = 'invariant';
  if (ctx.ui?.select) {
    const typeChoice = await ctx.ui.select('¿Qué tipo de regla es?', [
      '🛡️ Normativa (Invariante no negociable)',
      '💡 Ask (Patrón condicional / Receta con pregunta)',
    ]);
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
        surface: 'src/',
        description: rawDescription.trim(),
        trigger: 'Al implementar esta funcionalidad',
        antiTrigger: 'En contextos no aplicables',
        prompt: `¿Deseas aplicar ${rawDescription.slice(0, 30)}?`,
        defaultAction: 'Continuar sin esta regla',
      };
    } else {
      synthesized = parseSynthesizedRule(rawResponse, ruleType);
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
      `¿Deseas guardar esta regla en el Playbook de ${targetLang.toUpperCase()}?`,
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
      topology: { pattern: 'Standard Layout', directories: ['src/'] },
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

  ctx.ui?.notify(`✓ Regla guardada con éxito en el Playbook de ${targetLang.toUpperCase()}`, 'info');

  pi.sendMessage({
    customType: 'gentle-playbook',
    content: `### 🛡️ Nueva Regla Guardada en ${targetLang.toUpperCase()} (v${pb.version})\n\n${preview}`,
    display: true,
  });
}

export default function (pi: ExtensionAPI) {
  const storage = new PlaybookStorage();

  // 1. Register Slash Command: /gentle-playbook
  pi.registerCommand('gentle-playbook', {
    description: 'Inspect, extract, or manage language architecture playbooks',
    handler: async (args: string, ctx: any) => {
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
        if (languages.length === 0) {
          ctx.ui?.notify('gentle-playbook: No playbooks found in storage.', 'info');
          return;
        }

        if (ctx.ui?.select) {
          const selected = await ctx.ui.select(
            'Select a language playbook to view:',
            languages
          );
          if (selected && typeof selected === 'string') {
            const pb = await storage.getPlaybook(selected);
            if (pb) {
              const summary = `${selected.toUpperCase()} (v${pb.version}): ${pb.invariants.length} normativas, ${pb.askRules.length} ask rules`;
              ctx.ui?.notify(summary, 'info');

              pi.sendMessage({
                customType: 'gentle-playbook',
                content: formatPlaybookForDisplay(pb, { includeSnippets }),
                display: true,
              });
            }
          }
        } else {
          ctx.ui?.notify(`Available playbooks: ${languages.join(', ')}`, 'info');
        }
      } else if (sub === 'show') {
        const lang = parts[1];
        if (!lang) {
          ctx.ui?.notify('Usage: /gentle-playbook show <language> [--full]', 'warning');
          return;
        }
        const pb = await storage.getPlaybook(lang);
        if (!pb) {
          ctx.ui?.notify(`Playbook "${lang}" not found.`, 'error');
          return;
        }
        ctx.ui?.notify(`Displaying playbook: ${lang}`, 'info');

        pi.sendMessage({
          customType: 'gentle-playbook',
          content: formatPlaybookForDisplay(pb, { includeSnippets }),
          display: true,
        });
      } else if (sub === 'extract') {
        const targetPath = parts[1];
        if (!targetPath) {
          ctx.ui?.notify('Usage: /gentle-playbook extract <path-to-repo>', 'warning');
          return;
        }

        const resolvedPath = path.resolve(ctx.cwd || process.cwd(), targetPath);
        ctx.ui?.notify(`Analyzing essence from ${resolvedPath}...`, 'info');

        try {
          const detectedLang = await detectProjectLanguage(resolvedPath);
          const draft = await extractPlaybook(resolvedPath, { language: detectedLang });
          const existing = await storage.getPlaybook(detectedLang);

          const diff = computePlaybookDiff(draft, existing);
          const merged = mergePlaybooks(draft, existing);
          await storage.savePlaybook(merged);

          ctx.ui?.notify(
            `Playbook for ${detectedLang} updated: ${diff.stats.newRules} new, ${diff.stats.identicalRules} identical, ${diff.stats.conflictRules} conflicts resolved.`,
            'info'
          );

          pi.sendMessage({
            customType: 'gentle-playbook',
            content: formatPlaybookForDisplay(merged),
            display: true,
          });
        } catch (err: any) {
          ctx.ui?.notify(`Extraction failed: ${err.message}`, 'error');
        }
      }
    },
  });

  // 2. Register Dedicated Slash Command: /gentle-playbook-add
  pi.registerCommand('gentle-playbook-add', {
    description: 'Add a new architectural invariant or ask rule to a language playbook interactively',
    handler: async (args: string, ctx: any) => {
      await handleAddRule(args, ctx, storage, pi);
    },
  });

  // 3. Auto-detection on session_start
  pi.on('session_start', async (_event: any, ctx: any) => {
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
}
