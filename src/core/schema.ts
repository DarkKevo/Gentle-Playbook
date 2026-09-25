export type RuleType = 'invariant' | 'ask';

export const AGENTS_PREFERENCES_ID = 'agents-preferences';

export interface BaseRule {
  id: string;
  title: string;
  surface: string;
  description: string;
}

export interface InvariantRule extends BaseRule {
  type: 'invariant';
}

export interface AskRule extends BaseRule {
  type: 'ask';
  trigger: string;
  antiTrigger: string;
  prompt: string;
  defaultAction: string;
  recipeSnippetId?: string;
}

export interface Snippet {
  id: string;
  title: string;
  language: string;
  code: string;
  description?: string;
}

export interface Topology {
  pattern: string;
  directories: string[];
}

export interface Playbook {
  language: string;
  version: number;
  updatedAt: string;
  topology: Topology;
  invariants: InvariantRule[];
  askRules: AskRule[];
  snippets: Snippet[];
}

export interface RuleDiff {
  type: 'new' | 'identical' | 'conflict';
  category: RuleType;
  incoming: InvariantRule | AskRule;
  existing?: InvariantRule | AskRule;
  conflictReason?: string;
}
