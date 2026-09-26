#!/usr/bin/env node

import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as readline from 'node:readline/promises';
import { PlaybookStorage } from './core/storage.js';
import { extractPlaybook, detectProjectLanguage, detectProjectLanguages } from './extract/extractor.js';
import { computePlaybookDiff, mergePlaybooks } from './core/diff.js';
import { serializePlaybook } from './core/parser.js';
import { resolveLanguage, resolveLanguageStrict, SUPPORTED_LANGUAGES } from './core/languages.js';
import { InvariantRule, AskRule, NeverRule, Playbook } from './core/schema.js';

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'list';
  const storage = new PlaybookStorage();

  try {
    switch (command) {
      case 'list': {
        const languages = await storage.listLanguages();
        const hasAgents = await storage.hasAgentPreferences();
        if (languages.length === 0 && !hasAgents) {
          console.log('No playbooks found in storage.');
          console.log(`Directory: ${storage.getBaseDir()}`);
          console.log('\nRun "gentle-playbook extract <path-to-repo>" to generate your first playbook.');
        } else {
          console.log('Available Gentle Playbooks:');
          if (hasAgents) {
            const agentPb = await storage.getAgentPreferences();
            const invCount = agentPb?.invariants.length || 0;
            const askCount = agentPb?.askRules.length || 0;
            console.log(`  🤖 ${'agents-preferences'.padEnd(20)} (v${agentPb?.version || 1}) - ${invCount} normativas, ${askCount} ask rules [SUPERVISION]`);
          }
          for (const lang of languages) {
            const pb = await storage.getPlaybook(lang);
            const invCount = pb?.invariants.length || 0;
            const askCount = pb?.askRules.length || 0;
            console.log(`  • ${lang.padEnd(20)} (v${pb?.version || 1}) - ${invCount} invariants, ${askCount} ask rules`);
          }
        }
        break;
      }

      case 'show': {
        const langInput = args[1];
        if (!langInput) {
          console.error('Error: Language argument required. Usage: gentle-playbook show <language>');
          process.exit(1);
        }
        const lang = resolveLanguage(langInput);
        const pb = await storage.getPlaybook(lang);
        if (!pb) {
          console.error(`Error: No playbook found for language "${lang}".`);
          process.exit(1);
        }
        console.log(serializePlaybook(pb));
        break;
      }

      case 'extract': {
        const inputPath = args[1]?.startsWith('--') ? undefined : args[1];
        let resolvedPath = '';

        if (!inputPath) {
          resolvedPath = process.cwd();
        } else {
          const direct = path.resolve(process.cwd(), inputPath);
          const sibling = path.resolve(process.cwd(), '..', inputPath);

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
            console.error(`❌ Error: Path "${inputPath}" does not exist.`);
            process.exit(1);
          }
        }

        console.log(`Analyzing repository: ${resolvedPath}...`);

        let langOverride: string | undefined;
        const langIdx = args.indexOf('--lang');
        if (langIdx >= 0 && args[langIdx + 1]) {
          langOverride = args[langIdx + 1];
        }

        let detectedLang: string;

        if (langOverride) {
          detectedLang = resolveLanguage(langOverride);
          console.log(`Language override specified: ${detectedLang}`);
        } else {
          const langResult = await detectProjectLanguages(resolvedPath);
          detectedLang = langResult.primary;
          if (langResult.isMonorepo) {
            const countsDesc = langResult.detected
              .map((l) => `${l} (${langResult.counts[l] || 0} files)`)
              .join(', ');
            console.log(`ℹ Multiple languages detected: ${countsDesc}`);
            console.log(`  Predominant language chosen: '${detectedLang}' (Use --lang <lang> to override)`);
          } else {
            console.log(`Detected Language: ${detectedLang}`);
          }
        }

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

        if (diff.neverRules && diff.neverRules.length > 0) {
          console.log('\n--- NUNCA (Deliberate Absences) ---');
          for (const nev of diff.neverRules) {
            const badge = nev.status === 'new' ? '[NEW]' : nev.status === 'identical' ? '[IDENTICAL]' : '[CONFLICT]';
            console.log(`  ${badge.padEnd(12)} ${nev.incoming.description}`);
          }
        }

        // Auto-merge with default accept for CLI mode
        const merged = mergePlaybooks(draft, existing);
        await storage.savePlaybook(merged);

        console.log('\n✓ Playbook merged and saved successfully!');
        console.log(`Storage location: ${path.join(storage.getBaseDir(), `${detectedLang}.md`)}`);
        break;
      }

      case 'add': {
        const langInput = args[1];
        if (!langInput) {
          console.error('Error: Language argument required. Usage: gentle-playbook add <language> [options]');
          console.error('Examples:');
          console.error('  gentle-playbook add go --type invariant --title "No Null Bytes" --surface "internal/http/" --description "Reject \\0 in requests"');
          console.error('  gentle-playbook add go --type ask --title "Rate Limit" --trigger "Public endpoints" --prompt "Apply rate limiter?"');
          console.error('  gentle-playbook add go --type never --description "No heavy ORMs"');
          process.exit(1);
        }

        const resolvedLang = resolveLanguageStrict(langInput);
        if (!resolvedLang) {
          console.error(`Error: Unknown language "${langInput}".`);
          console.error('Valid languages: ' + SUPPORTED_LANGUAGES.map((l) => l.id).join(', '));
          process.exit(1);
        }

        // Parse flags: --type, --id, --title, --surface, --description, --rule, --trigger, --anti-trigger, --prompt, --default
        function getFlag(name: string): string | undefined {
          const idx = args.indexOf(`--${name}`);
          if (idx >= 0 && args[idx + 1] && !args[idx + 1].startsWith('--')) {
            return args[idx + 1];
          }
          return undefined;
        }

        const ruleType = (getFlag('type') || 'invariant').toLowerCase();
        let ruleId = getFlag('id');
        const title = getFlag('title') || 'Untitled Rule';
        const surface = getFlag('surface') || 'general';
        const description = getFlag('description') || getFlag('rule') || '';

        if (!ruleId) {
          ruleId = title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '');
        }

        let existing = await storage.getPlaybook(resolvedLang);
        if (!existing) {
          existing = {
            language: resolvedLang,
            version: 1,
            updatedAt: new Date().toISOString().split('T')[0],
            topology: { pattern: 'Standard Layout', directories: [] },
            invariants: [],
            askRules: [],
            snippets: [],
          };
        }

        if (ruleType === 'invariant') {
          if (!description) {
            console.error('Error: Invariant requires --description or --rule.');
            process.exit(1);
          }
          // Remove if already exists with same id
          existing.invariants = existing.invariants.filter((i) => i.id !== ruleId);
          existing.invariants.push({
            id: ruleId,
            type: 'invariant',
            title,
            surface,
            description,
          });
          console.log(`✓ Added invariant rule [${ruleId}] to ${resolvedLang} playbook.`);
        } else if (ruleType === 'ask') {
          const trigger = getFlag('trigger') || 'When configuring this layer';
          const antiTrigger = getFlag('anti-trigger') || 'Internal or script usage';
          const prompt = getFlag('prompt') || `Apply ${title}?`;
          const defaultAction = getFlag('default') || 'Skip optional rule';

          existing.askRules = existing.askRules.filter((a) => a.id !== ruleId);
          existing.askRules.push({
            id: ruleId,
            type: 'ask',
            title,
            surface,
            trigger,
            antiTrigger,
            prompt,
            defaultAction,
            description: description || trigger,
          });
          console.log(`✓ Added ask rule [${ruleId}] to ${resolvedLang} playbook.`);
        } else if (ruleType === 'never') {
          if (!description) {
            console.error('Error: Never rule requires --description.');
            process.exit(1);
          }
          if (!existing.neverRules) existing.neverRules = [];
          existing.neverRules = existing.neverRules.filter((n) => n.id !== ruleId);
          existing.neverRules.push({
            id: ruleId,
            type: 'never',
            title,
            surface,
            description,
          });
          console.log(`✓ Added deliberate prohibition [${ruleId}] to ${resolvedLang} playbook.`);
        } else {
          console.error(`Error: Invalid rule type "${ruleType}". Must be invariant, ask, or never.`);
          process.exit(1);
        }

        existing.updatedAt = new Date().toISOString().split('T')[0];
        await storage.savePlaybook(existing);
        break;
      }

      case 'delete': {
        const langInput = args[1];
        if (!langInput) {
          console.error('Error: Language argument required. Usage: gentle-playbook delete <language> [--rule <id>] [--yes]');
          process.exit(1);
        }

        const resolvedLang = resolveLanguageStrict(langInput);
        if (!resolvedLang) {
          console.error(`Error: Ambiguous or unknown language "${langInput}". Exact language name or alias required.`);
          const available = await storage.listLanguages();
          console.error(`Available playbooks: ${available.join(', ')}`);
          process.exit(1);
        }

        // Check for surgical rule deletion: --rule <id>
        const ruleIdx = args.indexOf('--rule');
        const ruleId = ruleIdx >= 0 ? args[ruleIdx + 1] : undefined;
        const autoConfirm = args.includes('--yes') || args.includes('-y');

        if (ruleId) {
          const res = await storage.deleteRule(resolvedLang, ruleId);
          if (res.deleted) {
            console.log(`✓ Deleted rule "${ruleId}" (${res.ruleType}) from "${resolvedLang}" playbook.`);
          } else {
            console.error(`Error: Rule "${ruleId}" not found in "${resolvedLang}" playbook.`);
            process.exit(1);
          }
          break;
        }

        // Full playbook deletion: requires confirmation if interactive
        if (!autoConfirm) {
          if (process.stdin.isTTY) {
            const rl = readline.createInterface({
              input: process.stdin,
              output: process.stdout,
            });
            const answer = await rl.question(
              `⚠️ Are you sure you want to completely delete the playbook for "${resolvedLang}"? (y/N): `
            );
            rl.close();
            if (answer.trim().toLowerCase() !== 'y') {
              console.log('Operation aborted. No files were deleted.');
              break;
            }
          } else {
            console.error(`Error: Deleting the entire playbook "${resolvedLang}" requires explicit confirmation.`);
            console.error('Run with --yes to confirm in non-interactive environments.');
            process.exit(1);
          }
        }

        const deleted = await storage.deletePlaybook(resolvedLang);
        if (deleted) {
          console.log(`✓ Deleted playbook for "${resolvedLang}".`);
        } else {
          console.error(`Error: Playbook "${resolvedLang}" not found.`);
        }
        break;
      }

      default:
        console.log('Usage: gentle-playbook <command> [options]');
        console.log('\nCommands:');
        console.log('  list                           List all registered language playbooks & agent preferences');
        console.log('  show <lang|agents>             Display the canonical markdown playbook');
        console.log('  add <lang> [options]           Add an individual invariant, ask rule, or never rule');
        console.log('  extract <path> [--lang]        Extract essence from repo, diff, and merge');
        console.log('  delete <lang> [--rule <id>]    Delete a specific rule or an entire playbook (with confirmation)');
        break;
    }
  } catch (err: any) {
    console.error(`Fatal error: ${err.message}`);
    process.exit(1);
  }
}

main();
