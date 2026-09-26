export type RuleType = 'invariant' | 'ask' | 'never';

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

export interface NeverRule extends BaseRule {
  type: 'never';
  reason?: string;
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
  source?: string;
  projectType?: string;
  stack?: string[];
  invariants: InvariantRule[];
  askRules: AskRule[];
  neverRules?: NeverRule[];
  snippets: Snippet[];
}

export interface RuleDiff {
  type: 'new' | 'identical' | 'conflict';
  category: RuleType;
  incoming: InvariantRule | AskRule | NeverRule;
  existing?: InvariantRule | AskRule | NeverRule;
  conflictReason?: string;
}
