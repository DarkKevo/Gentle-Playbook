import * as path from 'node:path';
import { PlaybookStorage } from './core/storage.js';
import { extractPlaybook, detectProjectLanguage } from './extract/extractor.js';
import { computePlaybookDiff, mergePlaybooks } from './core/diff.js';
import { serializePlaybook } from './core/parser.js';

export interface ExtensionAPI {
  registerCommand(
    name: string,
    options: {
      description: string;
      handler: (args: string, ctx: any) => Promise<void>;
    }
  ): void;
  registerTool?(tool: any): void;
  on(event: string, handler: (event: any, ctx: any) => Promise<void>): void;
}

export default function (pi: ExtensionAPI) {
  const storage = new PlaybookStorage();

  // 1. Register Slash Command: /gentle-playbook
  pi.registerCommand('gentle-playbook', {
    description: 'Inspect, extract, or manage language architecture playbooks',
    handler: async (args: string, ctx: any) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0] || 'list';

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
              const summary = `${selected.toUpperCase()} (v${pb.version}): ${pb.invariants.length} invariants, ${pb.askRules.length} ask rules, ${pb.snippets.length} snippets`;
              ctx.ui?.notify(summary, 'info');
              console.log('\n' + serializePlaybook(pb) + '\n');
            }
          }
        } else {
          ctx.ui?.notify(`Available playbooks: ${languages.join(', ')}`, 'info');
        }
      } else if (sub === 'show') {
        const lang = parts[1];
        if (!lang) {
          ctx.ui?.notify('Usage: /gentle-playbook show <language>', 'warning');
          return;
        }
        const pb = await storage.getPlaybook(lang);
        if (!pb) {
          ctx.ui?.notify(`Playbook "${lang}" not found.`, 'error');
          return;
        }
        ctx.ui?.notify(`Displaying playbook: ${lang}`, 'info');
        console.log(serializePlaybook(pb));
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
        } catch (err: any) {
          ctx.ui?.notify(`Extraction failed: ${err.message}`, 'error');
        }
      }
    },
  });

  // 2. Auto-detection on session_start
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
