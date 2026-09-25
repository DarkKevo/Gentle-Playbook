import {
  Playbook,
  Topology,
  InvariantRule,
  AskRule,
  Snippet,
  AGENTS_PREFERENCES_ID,
} from './schema.js';

export function parsePlaybook(markdown: string): Playbook {
  const lines = markdown.split(/\r?\n/);

  let version = 1;
  let language = '';
  let updatedAt = new Date().toISOString().split('T')[0];

  // 1. Header parsing: <!-- gentle-playbook:v1 lang=go updated=2025-02-18 -->
  const headerMatch = markdown.match(/<!--\s*gentle-playbook:v(\d+)\s+lang=([^\s]+)\s+updated=([^\s]+)\s*-->/);
  if (headerMatch) {
    version = parseInt(headerMatch[1], 10);
    language = headerMatch[2];
    updatedAt = headerMatch[3];
  }

  // Fallback language detection from title if missing
  if (!language) {
    const titleMatch = markdown.match(/#\s+Playbook:\s*([^\r\n]+)/i);
    if (titleMatch) {
      language = titleMatch[1].trim().toLowerCase();
    } else {
      language = 'unknown';
    }
  }

  const topology: Topology = {
    pattern: 'Standard',
    directories: [],
  };

  const invariants: InvariantRule[] = [];
  const askRules: AskRule[] = [];
  const snippets: Snippet[] = [];

  // Split into H2 sections
  const h2Regex = /^##\s+(.+)$/gm;
  const sections: { title: string; content: string }[] = [];
  let lastIndex = 0;
  let currentTitle = '';

  let match: RegExpExecArray | null;
  while ((match = h2Regex.exec(markdown)) !== null) {
    if (currentTitle) {
      sections.push({
        title: currentTitle,
        content: markdown.slice(lastIndex, match.index),
      });
    }
    currentTitle = match[1].trim();
    lastIndex = match.index + match[0].length;
  }

  if (currentTitle) {
    sections.push({
      title: currentTitle,
      content: markdown.slice(lastIndex),
    });
  }

  for (const section of sections) {
    const secTitle = section.title.toLowerCase();

    if (secTitle.startsWith('topology')) {
      // e.g. "Topology: Hexagonal (Ports & Adapters)"
      const patternMatch = section.title.match(/topology:\s*(.+)/i);
      if (patternMatch) {
        topology.pattern = patternMatch[1].trim();
      }
      const dirMatches = section.content.matchAll(/^\s*-\s+`([^`]+)`/gm);
      for (const m of dirMatches) {
        topology.directories.push(m[1].trim());
      }
      if (topology.directories.length === 0) {
        // Fallback for standard bullets without backticks
        const plainMatches = section.content.matchAll(/^\s*-\s+([^\r\n]+)/gm);
        for (const m of plainMatches) {
          topology.directories.push(m[1].trim());
        }
      }
    } else if (secTitle.startsWith('invariant')) {
      // Parse Invariant rules
      // ### [INVARIANT:id] Title
      const ruleBlocks = section.content.split(/(?=^###\s+\[INVARIANT:)/m);
      for (const block of ruleBlocks) {
        const header = block.match(/^###\s+\[INVARIANT:([^\]]+)\]\s+([^\r\n]+)/m);
        if (!header) continue;

        const id = header[1].trim();
        const title = header[2].trim();

        const surfaceMatch = block.match(/-\s+\*\*Surface:\*\*\s+`?([^`\r\n]+)`?/i);
        const ruleMatch = block.match(/-\s+\*\*Rule:\*\*\s+([^\r\n]+(?:\r?\n(?!-\s+\*\*)[^\r\n]+)*)/i);

        invariants.push({
          id,
          type: 'invariant',
          title,
          surface: surfaceMatch ? surfaceMatch[1].trim() : '',
          description: ruleMatch ? ruleMatch[1].replace(/\r?\n\s+/g, ' ').trim() : '',
        });
      }
    } else if (secTitle.startsWith('ask')) {
      // Parse Ask rules
      // ### [ASK:id] Title
      const ruleBlocks = section.content.split(/(?=^###\s+\[ASK:)/m);
      for (const block of ruleBlocks) {
        const header = block.match(/^###\s+\[ASK:([^\]]+)\]\s+([^\r\n]+)/m);
        if (!header) continue;

        const id = header[1].trim();
        const title = header[2].trim();

        const surfaceMatch = block.match(/-\s+\*\*Surface:\*\*\s+`?([^`\r\n]+)`?/i);
        const triggerMatch = block.match(/-\s+\*\*Trigger:\*\*\s+([^\r\n]+)/i);
        const antiTriggerMatch = block.match(/-\s+\*\*Anti-Trigger:\*\*\s+([^\r\n]+)/i);
        const promptMatch = block.match(/-\s+\*\*Prompt:\*\*\s+["']?([^"'\r\n]+)["']?/i);
        const defaultMatch = block.match(/-\s+\*\*Default:\*\*\s+([^\r\n]+)/i);
        const recipeMatch = block.match(/-\s+\*\*Recipe:\*\*\s+`?([^`\r\n]+)`?/i);
        const descMatch = block.match(/-\s+\*\*Description:\*\*\s+([^\r\n]+)/i);

        askRules.push({
          id,
          type: 'ask',
          title,
          surface: surfaceMatch ? surfaceMatch[1].trim() : '',
          trigger: triggerMatch ? triggerMatch[1].trim() : '',
          antiTrigger: antiTriggerMatch ? antiTriggerMatch[1].trim() : '',
          prompt: promptMatch ? promptMatch[1].trim() : '',
          defaultAction: defaultMatch ? defaultMatch[1].trim() : '',
          recipeSnippetId: recipeMatch ? recipeMatch[1].trim() : undefined,
          description: descMatch ? descMatch[1].trim() : (triggerMatch ? triggerMatch[1].trim() : ''),
        });
      }
    } else if (secTitle.startsWith('canonical snippet') || secTitle.startsWith('snippet')) {
      // Parse Snippets
      // ### [SNIPPET:id] Title
      const snippetBlocks = section.content.split(/(?=^###\s+\[SNIPPET:)/m);
      for (const block of snippetBlocks) {
        const header = block.match(/^###\s+\[SNIPPET:([^\]]+)\]\s+([^\r\n]+)/m);
        if (!header) continue;

        const id = header[1].trim();
        const title = header[2].trim();

        const codeBlockMatch = block.match(/```([a-zA-Z0-9_-]*)\r?\n([\s\S]*?)\r?\n```/);
        if (codeBlockMatch) {
          snippets.push({
            id,
            title,
            language: codeBlockMatch[1].trim() || language,
            code: codeBlockMatch[2],
          });
        }
      }
    }
  }

  return {
    language,
    version,
    updatedAt,
    topology,
    invariants,
    askRules,
    snippets,
  };
}

export function serializePlaybook(playbook: Playbook): string {
  const parts: string[] = [];

  // 1. Metadata Header
  parts.push(`<!-- gentle-playbook:v${playbook.version} lang=${playbook.language} updated=${playbook.updatedAt} -->`);
  if (playbook.language === AGENTS_PREFERENCES_ID) {
    parts.push('# Playbook: Agents Preferences');
  } else {
    parts.push(`# Playbook: ${capitalize(playbook.language)}`);
  }
  parts.push('');

  // 2. Topology
  if (playbook.language !== AGENTS_PREFERENCES_ID || playbook.topology.directories.length > 0) {
    parts.push(`## Topology: ${playbook.topology.pattern}`);
    for (const dir of playbook.topology.directories) {
      parts.push(`- \`${dir}\``);
    }
    parts.push('');
  }

  // 3. Invariants
  parts.push('## Invariants');
  parts.push('');
  for (const inv of playbook.invariants) {
    parts.push(`### [INVARIANT:${inv.id}] ${inv.title}`);
    parts.push(`- **Surface:** \`${inv.surface}\``);
    parts.push(`- **Rule:** ${inv.description}`);
    parts.push('');
  }

  // 4. Ask Catalog
  parts.push('## Ask Catalog');
  parts.push('');
  for (const ask of playbook.askRules) {
    parts.push(`### [ASK:${ask.id}] ${ask.title}`);
    parts.push(`- **Surface:** \`${ask.surface}\``);
    parts.push(`- **Trigger:** ${ask.trigger}`);
    parts.push(`- **Anti-Trigger:** ${ask.antiTrigger}`);
    parts.push(`- **Prompt:** "${ask.prompt}"`);
    parts.push(`- **Default:** ${ask.defaultAction}`);
    if (ask.recipeSnippetId) {
      parts.push(`- **Recipe:** \`${ask.recipeSnippetId}\``);
    }
    parts.push('');
  }

  // 5. Canonical Snippets
  if (playbook.snippets.length > 0) {
    parts.push('## Canonical Snippets');
    parts.push('');
    for (const snip of playbook.snippets) {
      parts.push(`### [SNIPPET:${snip.id}] ${snip.title}`);
      parts.push(`\`\`\`${snip.language}`);
      parts.push(snip.code);
      parts.push('```');
      parts.push('');
    }
  }

  return parts.join('\n');
}

export function formatPlaybookForDisplay(
  playbook: Playbook,
  options: { includeSnippets?: boolean } = {}
): string {
  const parts: string[] = [];

  if (playbook.language === AGENTS_PREFERENCES_ID) {
    parts.push(`# 🤖 Playbook: Agents Preferences (v${playbook.version})`);
    parts.push(`*Supervisión y Gobernanza de Agente | Última actualización: ${playbook.updatedAt}*`);
    parts.push('');

    // 1. Invariants (Normativas)
    parts.push('## 🛡️ Normativas de Gobernanza (Límites Operativos Obligatorios)');
    parts.push('');
    for (const inv of playbook.invariants) {
      parts.push(`### [NORMATIVA] ${inv.title}`);
      parts.push(`- **Acción / Herramienta (Surface):** \`${inv.surface}\``);
      parts.push(`- **Límite / Regla:** ${inv.description}`);
      parts.push('');
    }

    // 2. Ask Catalog (Condicionales)
    parts.push('## 💡 Puntos de Control y Confirmaciones [ASK]');
    parts.push('');
    for (const ask of playbook.askRules) {
      parts.push(`### [ASK] ${ask.title}`);
      parts.push(`- **Acción (Surface):** \`${ask.surface}\``);
      parts.push(`- **Disparador (Trigger):** ${ask.trigger}`);
      parts.push(`- **Excepción (Anti-Trigger):** ${ask.antiTrigger}`);
      parts.push(`- **Pregunta al Usuario:** "${ask.prompt}"`);
      parts.push(`- **Acción por defecto:** ${ask.defaultAction}`);
      parts.push('');
    }

    return parts.join('\n');
  }

  parts.push(`# 📘 Playbook: ${capitalize(playbook.language)} (v${playbook.version})`);
  parts.push(`*Topología: ${playbook.topology.pattern} | Última actualización: ${playbook.updatedAt}*`);
  parts.push('');

  // 1. Invariants (Normativas)
  parts.push('## 🛡️ Normativas (Reglas Invariantes)');
  parts.push('');
  for (const inv of playbook.invariants) {
    parts.push(`### [NORMATIVA] ${inv.title}`);
    parts.push(`- **Surface:** \`${inv.surface}\``);
    parts.push(`- **Regla:** ${inv.description}`);
    parts.push('');
  }

  // 2. Ask Catalog (Condicionales)
  parts.push('## 💡 Preguntas Condicionales [ASK]');
  parts.push('');
  for (const ask of playbook.askRules) {
    parts.push(`### [ASK] ${ask.title}`);
    parts.push(`- **Surface:** \`${ask.surface}\``);
    parts.push(`- **Trigger:** ${ask.trigger}`);
    parts.push(`- **Anti-Trigger:** ${ask.antiTrigger}`);
    parts.push(`- **Pregunta:** "${ask.prompt}"`);
    parts.push(`- **Default:** ${ask.defaultAction}`);
    parts.push('');
  }

  // 3. Canonical Snippets (solo si se solicita explícitamente)
  if (options.includeSnippets && playbook.snippets.length > 0) {
    parts.push('## 📦 Snippets Canónicos');
    parts.push('');
    for (const snip of playbook.snippets) {
      const ext = snip.language === 'go' ? '.go' : snip.language === 'typescript' ? '.ts' : '';
      const filename = snip.id.replace(/^canonical-/, '').replace(/-/g, '_') + ext;
      parts.push(`### [SNIPPET:${snip.id}] ${snip.title}`);
      parts.push(`\`\`\`${snip.language}:${filename}`);
      parts.push(snip.code);
      parts.push('```');
      parts.push('');
    }
  }

  return parts.join('\n');
}

export function formatAgentPreferencesForSystemPrompt(playbook: Playbook): string {
  const parts: string[] = [];

  parts.push(`ACTIVE AGENT GOVERNANCE & SUPERVISION PLAYBOOK (v${playbook.version})`);
  parts.push('These rules supervise and delimit your actions and tools. They do NOT alter your core personality, but define mandatory operational boundaries.');
  parts.push('');

  if (playbook.invariants.length > 0) {
    parts.push('## MANDATORY OPERATIONAL LIMITS (INVARIANTS)');
    parts.push('You must strictly obey these limits. Do not bypass or proceed without adhering to them:');
    for (const inv of playbook.invariants) {
      parts.push(`- [${inv.id}] ${inv.title} (Surface/Tools: ${inv.surface}): ${inv.description}`);
    }
    parts.push('');
  }

  if (playbook.askRules.length > 0) {
    parts.push('## OPERATIONAL CHECKPOINTS (ASK CATALOG)');
    parts.push('Whenever an action matches a Trigger and does NOT match an Anti-Trigger, you MUST pause and ask the user for approval:');
    for (const ask of playbook.askRules) {
      parts.push(`- [${ask.id}] ${ask.title}`);
      parts.push(`  Surface/Tools: ${ask.surface}`);
      parts.push(`  Trigger: ${ask.trigger}`);
      parts.push(`  Anti-Trigger: ${ask.antiTrigger}`);
      parts.push(`  Question to User: "${ask.prompt}"`);
      parts.push(`  Default Action: ${ask.defaultAction}`);
    }
    parts.push('');
  }

  return parts.join('\n');
}

export function formatPlaybookForSystemPrompt(playbook: Playbook): string {
  if (playbook.language === AGENTS_PREFERENCES_ID) {
    return formatAgentPreferencesForSystemPrompt(playbook);
  }

  const parts: string[] = [];

  parts.push(`ACTIVE ARCHITECTURAL PLAYBOOK: ${capitalize(playbook.language)} (v${playbook.version})`);
  parts.push(`Topology Pattern: ${playbook.topology.pattern}`);
  if (playbook.topology.directories.length > 0) {
    parts.push('Target directory layout: ' + playbook.topology.directories.join(', '));
  }
  parts.push('');

  parts.push('## INVARIANTS (MANDATORY & NON-NEGOTIABLE)');
  parts.push('Apply these rules silently and unconditionally when writing, generating, or modifying code in this project. Do not ask for permission.');
  for (const inv of playbook.invariants) {
    parts.push(`- [${inv.id}] ${inv.title} (Surface: ${inv.surface}): ${inv.description}`);
  }
  parts.push('');

  if (playbook.askRules.length > 0) {
    parts.push('## CONDITIONAL RECIPES [ASK CATALOG]');
    parts.push('Evaluate these rules ONLY when working on their declared Surface. Trigger activates the prompt; Anti-Trigger strictly forbids asking.');
    for (const ask of playbook.askRules) {
      parts.push(`- [${ask.id}] ${ask.title}`);
      parts.push(`  Surface: ${ask.surface}`);
      parts.push(`  Trigger: ${ask.trigger}`);
      parts.push(`  Anti-Trigger: ${ask.antiTrigger}`);
      parts.push(`  Prompt to User: "${ask.prompt}"`);
      parts.push(`  Default: ${ask.defaultAction}`);
    }
    parts.push('');
  }

  return parts.join('\n');
}

function capitalize(s: string): string {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}
