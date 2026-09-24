#!/usr/bin/env node

import * as path from 'node:path';
import { PlaybookStorage } from './core/storage.js';
import { extractPlaybook, detectProjectLanguage } from './extract/extractor.js';
import { computePlaybookDiff, mergePlaybooks } from './core/diff.js';
import { serializePlaybook } from './core/parser.js';

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'list';
  const storage = new PlaybookStorage();

  try {
    switch (command) {
      case 'list': {
        const languages = await storage.listLanguages();
        if (languages.length === 0) {
          console.log('No playbooks found in storage.');
          console.log(`Directory: ${storage.getBaseDir()}`);
          console.log('\nRun "gentle-playbook extract <path-to-repo>" to generate your first playbook.');
        } else {
          console.log('Available Gentle Playbooks:');
          for (const lang of languages) {
            const pb = await storage.getPlaybook(lang);
            const invCount = pb?.invariants.length || 0;
            const askCount = pb?.askRules.length || 0;
            console.log(`  • ${lang.padEnd(12)} (v${pb?.version || 1}) - ${invCount} invariants, ${askCount} ask rules`);
          }
        }
        break;
      }

      case 'show': {
        const lang = args[1];
        if (!lang) {
          console.error('Error: Language argument required. Usage: gentle-playbook show <language>');
          process.exit(1);
        }
        const pb = await storage.getPlaybook(lang);
        if (!pb) {
          console.error(`Error: No playbook found for language "${lang}".`);
          process.exit(1);
        }
        console.log(serializePlaybook(pb));
        break;
      }

      case 'extract': {
        const targetPath = args[1];
        if (!targetPath) {
          console.error('Error: Path required. Usage: gentle-playbook extract <path-to-repo> [--lang <lang>]');
          process.exit(1);
        }

        const resolvedPath = path.resolve(process.cwd(), targetPath);
        console.log(`Analyzing repository: ${resolvedPath}...`);

        let langOverride: string | undefined;
        const langIdx = args.indexOf('--lang');
        if (langIdx >= 0 && args[langIdx + 1]) {
          langOverride = args[langIdx + 1];
        }

        const detectedLang = langOverride || (await detectProjectLanguage(resolvedPath));
        console.log(`Detected Language: ${detectedLang}`);

        const draft = await extractPlaybook(resolvedPath, { language: detectedLang });
        const existing = await storage.getPlaybook(detectedLang);

        const diff = computePlaybookDiff(draft, existing);

        console.log('\n========================================');
        console.log(` Diff Report for ${detectedLang.toUpperCase()}`);
        console.log('========================================');
        console.log(`Topology: ${draft.topology.pattern}`);
        console.log(`New Rules: ${diff.stats.newRules} | Identical: ${diff.stats.identicalRules} | Conflicts: ${diff.stats.conflictRules}\n`);

        console.log('--- INVARIANTS ---');
        for (const inv of diff.invariants) {
          const badge = inv.status === 'new' ? '[NEW]' : inv.status === 'identical' ? '[IDENTICAL]' : '[CONFLICT]';
          console.log(`  ${badge.padEnd(12)} ${inv.incoming.title} (${inv.incoming.surface})`);
          if (inv.reason) console.log(`               Reason: ${inv.reason}`);
        }

        console.log('\n--- ASK RULES (Conditional / Recipes) ---');
        for (const ask of diff.askRules) {
          const badge = ask.status === 'new' ? '[NEW]' : ask.status === 'identical' ? '[IDENTICAL]' : '[CONFLICT]';
          console.log(`  ${badge.padEnd(12)} ${ask.incoming.title}`);
          console.log(`               Trigger: ${ask.incoming.trigger}`);
          console.log(`               Prompt: "${ask.incoming.prompt}"`);
        }

        // Auto-merge with default accept for CLI mode
        const merged = mergePlaybooks(draft, existing);
        await storage.savePlaybook(merged);

        console.log('\n✓ Playbook merged and saved successfully!');
        console.log(`Storage location: ${path.join(storage.getBaseDir(), `${detectedLang}.md`)}`);
        break;
      }

      case 'delete': {
        const lang = args[1];
        if (!lang) {
          console.error('Error: Language argument required. Usage: gentle-playbook delete <language>');
          process.exit(1);
        }
        const deleted = await storage.deletePlaybook(lang);
        if (deleted) {
          console.log(`✓ Deleted playbook for "${lang}".`);
        } else {
          console.error(`Error: Playbook "${lang}" not found.`);
        }
        break;
      }

      default:
        console.log('Usage: gentle-playbook <command> [options]');
        console.log('\nCommands:');
        console.log('  list                     List all registered language playbooks');
        console.log('  show <lang>              Display the canonical markdown playbook');
        console.log('  extract <path> [--lang]  Extract essence from repo, diff, and merge');
        console.log('  delete <lang>            Remove a language playbook');
        break;
    }
  } catch (err: any) {
    console.error(`Fatal error: ${err.message}`);
    process.exit(1);
  }
}

main();
