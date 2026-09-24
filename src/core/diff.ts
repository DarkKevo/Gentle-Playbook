import {
  Playbook,
  InvariantRule,
  AskRule,
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

export interface PlaybookDiffResult {
  language: string;
  topologyChanged: boolean;
  incomingTopology: Topology;
  existingTopology?: Topology;
  invariants: InvariantDiff[];
  askRules: AskDiff[];
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

    return {
      language: incoming.language,
      topologyChanged: true,
      incomingTopology: incoming.topology,
      invariants,
      askRules,
      snippets,
      stats: {
        newRules: invariants.length + askRules.length + snippets.length,
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

  const allDiffs = [...invariantDiffs, ...askDiffs, ...snippetDiffs];
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
    snippets: snippetDiffs,
    stats: {
      newRules,
      identicalRules,
      conflictRules,
    },
  };
}

function isSimilarTitle(t1: string, t2: string): boolean {
  const norm1 = t1.toLowerCase().replace(/[^a-z0-9]/g, '');
  const norm2 = t2.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (norm1 === norm2) return true;
  return norm1.includes(norm2) || norm2.includes(norm1);
}
