import {
  Playbook,
  InvariantRule,
  AskRule,
  NeverRule,
  Snippet,
  Topology,
} from './schema.js';

export type DiffStatus = 'new' | 'identical' | 'conflict';

export interface InvariantDiff {
  status: DiffStatus;
  incoming: InvariantRule;
  existing?: InvariantRule;
  reason?: string;
}

export interface AskDiff {
  status: DiffStatus;
  incoming: AskRule;
  existing?: AskRule;
  reason?: string;
}

export interface SnippetDiff {
  status: DiffStatus;
  incoming: Snippet;
  existing?: Snippet;
  reason?: string;
}

export interface NeverDiff {
  status: DiffStatus;
  incoming: NeverRule;
  existing?: NeverRule;
  reason?: string;
}

export interface PlaybookDiffResult {
  language: string;
  topologyChanged: boolean;
  incomingTopology: Topology;
  existingTopology?: Topology;
  invariants: InvariantDiff[];
  askRules: AskDiff[];
  neverRules: NeverDiff[];
  snippets: SnippetDiff[];
  stats: {
    newRules: number;
    identicalRules: number;
    conflictRules: number;
  };
}

export function computePlaybookDiff(
  incoming: Playbook,
  existing: Playbook | null
): PlaybookDiffResult {
  if (!existing) {
    // Everything is new
    const invariants: InvariantDiff[] = incoming.invariants.map((inv) => ({
      status: 'new',
      incoming: inv,
    }));
    const askRules: AskDiff[] = incoming.askRules.map((ask) => ({
      status: 'new',
      incoming: ask,
    }));
    const snippets: SnippetDiff[] = incoming.snippets.map((snip) => ({
      status: 'new',
      incoming: snip,
    }));
    const neverRules: NeverDiff[] = (incoming.neverRules || []).map((nev) => ({
      status: 'new',
      incoming: nev,
    }));

    return {
      language: incoming.language,
      topologyChanged: true,
      incomingTopology: incoming.topology,
      invariants,
      askRules,
      neverRules,
      snippets,
      stats: {
        newRules: invariants.length + askRules.length + snippets.length + neverRules.length,
        identicalRules: 0,
        conflictRules: 0,
      },
    };
  }

  // 1. Topology diff
  const topologyChanged =
    incoming.topology.pattern !== existing.topology.pattern ||
    incoming.topology.directories.some((d) => !existing.topology.directories.includes(d));

  // 2. Invariants diff
  const invariantDiffs: InvariantDiff[] = [];
  for (const inc of incoming.invariants) {
    const match = existing.invariants.find(
      (e) => e.id === inc.id || isSimilarTitle(e.title, inc.title)
    );

    if (!match) {
      invariantDiffs.push({ status: 'new', incoming: inc });
    } else if (
      match.description.trim() === inc.description.trim() &&
      match.surface.trim() === inc.surface.trim()
    ) {
      invariantDiffs.push({ status: 'identical', incoming: inc, existing: match });
    } else {
      const reasons: string[] = [];
      if (match.surface.trim() !== inc.surface.trim()) reasons.push('Surface differs');
      if (match.description.trim() !== inc.description.trim()) reasons.push('Rule description differs');
      invariantDiffs.push({
        status: 'conflict',
        incoming: inc,
        existing: match,
        reason: reasons.join(', '),
      });
    }
  }

  // 3. Ask Rules diff
  const askDiffs: AskDiff[] = [];
  for (const inc of incoming.askRules) {
    const match = existing.askRules.find(
      (e) => e.id === inc.id || isSimilarTitle(e.title, inc.title)
    );

    if (!match) {
      askDiffs.push({ status: 'new', incoming: inc });
    } else if (
      match.trigger.trim() === inc.trigger.trim() &&
      match.antiTrigger.trim() === inc.antiTrigger.trim() &&
      match.prompt.trim() === inc.prompt.trim()
    ) {
      askDiffs.push({ status: 'identical', incoming: inc, existing: match });
    } else {
      const reasons: string[] = [];
      if (match.trigger.trim() !== inc.trigger.trim()) reasons.push('Trigger differs');
      if (match.antiTrigger.trim() !== inc.antiTrigger.trim()) reasons.push('Anti-Trigger differs');
      if (match.prompt.trim() !== inc.prompt.trim()) reasons.push('Prompt wording differs');
      askDiffs.push({
        status: 'conflict',
        incoming: inc,
        existing: match,
        reason: reasons.join(', '),
      });
    }
  }

  // 4. Snippets diff
  const snippetDiffs: SnippetDiff[] = [];
  for (const inc of incoming.snippets) {
    const match = existing.snippets.find((e) => e.id === inc.id);
    if (!match) {
      snippetDiffs.push({ status: 'new', incoming: inc });
    } else if (match.code.trim() === inc.code.trim()) {
      snippetDiffs.push({ status: 'identical', incoming: inc, existing: match });
    } else {
      snippetDiffs.push({
        status: 'conflict',
        incoming: inc,
        existing: match,
        reason: 'Snippet code differs',
      });
    }
  }

  // 5. Never rules diff
  const neverDiffs: NeverDiff[] = [];
  const incNever = incoming.neverRules || [];
  const existNever = existing.neverRules || [];
  for (const inc of incNever) {
    const match = existNever.find((e) => e.id === inc.id || isSimilarTitle(e.description, inc.description));
    if (!match) {
      neverDiffs.push({ status: 'new', incoming: inc });
    } else if (match.description.trim() === inc.description.trim()) {
      neverDiffs.push({ status: 'identical', incoming: inc, existing: match });
    } else {
      neverDiffs.push({
        status: 'conflict',
        incoming: inc,
        existing: match,
        reason: 'Never description differs',
      });
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
}

export type ResolutionAction =
  | 'accept'
  | 'reject'
  | 'convert_to_ask'
  | 'convert_to_invariant';

export interface RuleResolution {
  ruleId: string;
  action: ResolutionAction;
  customTrigger?: string;
  customAntiTrigger?: string;
  customPrompt?: string;
}

export function mergePlaybooks(
  incoming: Playbook,
  existing: Playbook | null,
  resolutions: Record<string, RuleResolution> = {}
): Playbook {
  if (!existing) {
    const playbook: Playbook = {
      language: incoming.language,
      version: 1,
      updatedAt: new Date().toISOString().split('T')[0],
      topology: { ...incoming.topology },
      source: incoming.source,
      projectType: incoming.projectType,
      stack: incoming.stack,
      invariants: [],
      askRules: [],
      neverRules: incoming.neverRules ? [...incoming.neverRules] : undefined,
      snippets: [...incoming.snippets],
    };

    // Apply any conversions to incoming rules
    for (const inv of incoming.invariants) {
      const res = resolutions[inv.id];
      if (res && res.action === 'reject') continue;
      if (res && res.action === 'convert_to_ask') {
        playbook.askRules.push({
          id: inv.id,
          type: 'ask',
          title: inv.title,
          surface: inv.surface,
          description: inv.description,
          trigger: res.customTrigger || `Cuando se configure la capa ${inv.surface}`,
          antiTrigger: res.customAntiTrigger || 'En scripts CLI o llamadas internas simples',
          prompt: res.customPrompt || `¿Deseas aplicar ${inv.title}?`,
          defaultAction: 'Continuar sin aplicar regla opcional',
        });
      } else {
        playbook.invariants.push(inv);
      }
    }

    for (const ask of incoming.askRules) {
      const res = resolutions[ask.id];
      if (res && res.action === 'reject') continue;
      if (res && res.action === 'convert_to_invariant') {
        playbook.invariants.push({
          id: ask.id,
          type: 'invariant',
          title: ask.title,
          surface: ask.surface,
          description: ask.description || ask.prompt,
        });
      } else {
        playbook.askRules.push(ask);
      }
    }

    return playbook;
  }

  // Base is existing playbook
  const mergedInvariants = [...existing.invariants];
  const mergedAskRules = [...existing.askRules];
  const mergedSnippets = [...existing.snippets];

  const diff = computePlaybookDiff(incoming, existing);

  // Process Invariants
  for (const invDiff of diff.invariants) {
    if (invDiff.status === 'identical') {
      continue;
    }

    if (invDiff.status === 'new') {
      const res = resolutions[invDiff.incoming.id] || { action: 'accept' };
      if (res.action === 'reject') continue;

      if (res.action === 'convert_to_ask') {
        mergedAskRules.push({
          id: invDiff.incoming.id,
          type: 'ask',
          title: invDiff.incoming.title,
          surface: invDiff.incoming.surface,
          description: invDiff.incoming.description,
          trigger: res.customTrigger || `Cuando se requiera ${invDiff.incoming.title}`,
          antiTrigger: res.customAntiTrigger || 'Sin requerimiento explícito',
          prompt: res.customPrompt || `¿Deseas aplicar ${invDiff.incoming.title}?`,
          defaultAction: 'Continuar sin esta regla',
        });
      } else {
        mergedInvariants.push(invDiff.incoming);
      }
    } else if (invDiff.status === 'conflict') {
      // Default safety: preserve existing rule unless explicitly resolved with 'accept'
      const res = resolutions[invDiff.incoming.id];
      if (res && res.action === 'accept') {
        // Explicitly approved replacement
        const idx = mergedInvariants.findIndex((i) => i.id === invDiff.existing?.id);
        if (idx >= 0) {
          mergedInvariants[idx] = invDiff.incoming;
        }
      } else if (res && res.action === 'convert_to_ask') {
        // Remove from invariants, add to askRules
        const idx = mergedInvariants.findIndex((i) => i.id === invDiff.existing?.id);
        if (idx >= 0) mergedInvariants.splice(idx, 1);
        mergedAskRules.push({
          id: invDiff.incoming.id,
          type: 'ask',
          title: invDiff.incoming.title,
          surface: invDiff.incoming.surface,
          description: invDiff.incoming.description,
          trigger: res.customTrigger || `Al implementar ${invDiff.incoming.surface}`,
          antiTrigger: res.customAntiTrigger || 'En componentes internos',
          prompt: res.customPrompt || `¿Deseas implementar ${invDiff.incoming.title}?`,
          defaultAction: 'Omitir regla',
        });
      }
      // If no explicit resolution or reject: keep existing as is (safety by default)
    }
  }

  // Process Ask Rules
  for (const askDiff of diff.askRules) {
    if (askDiff.status === 'identical') {
      continue;
    }

    if (askDiff.status === 'new') {
      const res = resolutions[askDiff.incoming.id] || { action: 'accept' };
      if (res.action === 'reject') continue;

      if (res.action === 'convert_to_invariant') {
        mergedInvariants.push({
          id: askDiff.incoming.id,
          type: 'invariant',
          title: askDiff.incoming.title,
          surface: askDiff.incoming.surface,
          description: askDiff.incoming.description || askDiff.incoming.prompt,
        });
      } else {
        mergedAskRules.push(askDiff.incoming);
      }
    } else if (askDiff.status === 'conflict') {
      const res = resolutions[askDiff.incoming.id];
      if (res && res.action === 'accept') {
        const idx = mergedAskRules.findIndex((a) => a.id === askDiff.existing?.id);
        if (idx >= 0) mergedAskRules[idx] = askDiff.incoming;
      } else if (res && res.action === 'convert_to_invariant') {
        const idx = mergedAskRules.findIndex((a) => a.id === askDiff.existing?.id);
        if (idx >= 0) mergedAskRules.splice(idx, 1);
        mergedInvariants.push({
          id: askDiff.incoming.id,
          type: 'invariant',
          title: askDiff.incoming.title,
          surface: askDiff.incoming.surface,
          description: askDiff.incoming.description || askDiff.incoming.prompt,
        });
      }
      // If no explicit resolution or reject: keep existing intact
    }
  }

  // Process Snippets
  for (const snipDiff of diff.snippets) {
    if (snipDiff.status === 'identical') continue;
    if (snipDiff.status === 'new') {
      mergedSnippets.push(snipDiff.incoming);
    } else if (snipDiff.status === 'conflict') {
      const res = resolutions[snipDiff.incoming.id];
      if (res && res.action === 'accept') {
        const idx = mergedSnippets.findIndex((s) => s.id === snipDiff.existing?.id);
        if (idx >= 0) mergedSnippets[idx] = snipDiff.incoming;
      }
      // Safety by default: si no hay 'accept' explícito, preservar el snippet existente
    }
  }

  // Process Never Rules
  const mergedNeverRules = [...(existing.neverRules || [])];
  for (const nevDiff of diff.neverRules) {
    if (nevDiff.status === 'identical') continue;
    if (nevDiff.status === 'new') {
      mergedNeverRules.push(nevDiff.incoming);
    } else if (nevDiff.status === 'conflict') {
      const res = resolutions[nevDiff.incoming.id];
      if (res && res.action === 'accept') {
        const idx = mergedNeverRules.findIndex((n) => n.id === nevDiff.existing?.id);
        if (idx >= 0) mergedNeverRules[idx] = nevDiff.incoming;
      }
      // Safety by default: si no hay 'accept' explícito, preservar la regla Nunca existente
    }
  }

  // Merge Topology directories
  const combinedDirs = Array.from(
    new Set([...existing.topology.directories, ...incoming.topology.directories])
  ).sort();

  return {
    language: existing.language,
    version: existing.version + 1,
    updatedAt: new Date().toISOString().split('T')[0],
    topology: {
      pattern: incoming.topology.pattern || existing.topology.pattern,
      directories: combinedDirs,
    },
    invariants: mergedInvariants,
    askRules: mergedAskRules,
    neverRules: mergedNeverRules.length > 0 ? mergedNeverRules : undefined,
    snippets: mergedSnippets,
  };
}

function isSimilarTitle(t1: string, t2: string): boolean {
  const norm1 = t1.toLowerCase().replace(/[^a-z0-9]/g, '');
  const norm2 = t2.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (norm1 === norm2) return true;
  return norm1.includes(norm2) || norm2.includes(norm1);
}


