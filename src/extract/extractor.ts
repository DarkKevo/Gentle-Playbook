import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Playbook } from '../core/schema.js';
import { CodeGraphWrapper } from './codegraph.js';
import { detectTopology } from './topology.js';
import { CodePatternAnalyzer } from './analyzer.js';

export interface ExtractOptions {
  language?: string;
  codeGraph?: CodeGraphWrapper;
}

export async function detectProjectLanguage(projectPath: string): Promise<string> {
  const checks = [
    { file: 'go.mod', lang: 'go' },
    { file: 'package.json', lang: 'typescript' },
    { file: 'Cargo.toml', lang: 'rust' },
    { file: 'pyproject.toml', lang: 'python' },
    { file: 'requirements.txt', lang: 'python' },
  ];

  for (const check of checks) {
    try {
      await fs.access(path.join(projectPath, check.file));
      return check.lang;
    } catch {
      // Continue checking
    }
  }

  return 'generic';
}

export async function extractPlaybook(
  projectPath: string,
  options: ExtractOptions = {}
): Promise<Playbook> {
  const language = options.language || (await detectProjectLanguage(projectPath));
  const cg = options.codeGraph || new CodeGraphWrapper();

  // 1. Ensure CodeGraph index is ready
  await cg.ensureIndex(projectPath);

  // 2. Topology Detection
  const topology = await detectTopology(projectPath);

  // 3. Pattern & Invariant Analysis
  const analyzer = new CodePatternAnalyzer(cg);
  const { invariants, askRules, snippets } = await analyzer.analyze(projectPath);

  return {
    language,
    version: 1,
    updatedAt: new Date().toISOString().split('T')[0],
    topology,
    invariants,
    askRules,
    snippets,
  };
}
