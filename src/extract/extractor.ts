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

export interface LanguageDetectionResult {
  primary: string;
  detected: string[];
  counts: Record<string, number>;
  isMonorepo: boolean;
}

const MANIFEST_LANG_MAP: { file: string; lang: string; ext: string[] }[] = [
  { file: 'go.mod', lang: 'go', ext: ['.go'] },
  { file: 'package.json', lang: 'typescript', ext: ['.ts', '.tsx', '.js', '.jsx'] },
  { file: 'Cargo.toml', lang: 'rust', ext: ['.rs'] },
  { file: 'pyproject.toml', lang: 'python', ext: ['.py'] },
  { file: 'requirements.txt', lang: 'python', ext: ['.py'] },
];

export async function detectProjectLanguages(projectPath: string): Promise<LanguageDetectionResult> {
  const foundLangs = new Set<string>();

  for (const item of MANIFEST_LANG_MAP) {
    try {
      await fs.access(path.join(projectPath, item.file));
      foundLangs.add(item.lang);
    } catch {
      // Ignorar si no existe
    }
  }

  const detected = Array.from(foundLangs);

  if (detected.length === 0) {
    return {
      primary: 'generic',
      detected: [],
      counts: {},
      isMonorepo: false,
    };
  }

  if (detected.length === 1) {
    return {
      primary: detected[0],
      detected,
      counts: {},
      isMonorepo: false,
    };
  }

  // Hay múltiples lenguajes presentes (Monorepo o Híbrido): Desambiguar por conteo de extensiones
  const counts: Record<string, number> = {};
  for (const l of detected) counts[l] = 0;

  async function countExtensions(dir: string, depth = 0) {
    if (depth > 4) return;
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (
          entry.name.startsWith('.') ||
          entry.name === 'node_modules' ||
          entry.name === 'vendor' ||
          entry.name === 'dist' ||
          entry.name === 'build'
        ) {
          continue;
        }

        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await countExtensions(fullPath, depth + 1);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          for (const item of MANIFEST_LANG_MAP) {
            if (foundLangs.has(item.lang) && item.ext.includes(ext)) {
              counts[item.lang] = (counts[item.lang] || 0) + 1;
            }
          }
        }
      }
    } catch {
      // Ignorar directorios no legibles
    }
  }

  await countExtensions(projectPath, 0);

  // Elegir el lenguaje con mayor cantidad de archivos de código
  let primary = detected[0];
  let maxCount = -1;

  for (const lang of detected) {
    const c = counts[lang] || 0;
    if (c > maxCount) {
      maxCount = c;
      primary = lang;
    }
  }

  return {
    primary,
    detected,
    counts,
    isMonorepo: true,
  };
}

export async function detectProjectLanguage(projectPath: string): Promise<string> {
  const result = await detectProjectLanguages(projectPath);
  return result.primary;
}

export async function extractPlaybook(
  projectPath: string,
  options: ExtractOptions = {}
): Promise<Playbook> {
  const language = options.language || (await detectProjectLanguage(projectPath));
  const cg = options.codeGraph || new CodeGraphWrapper();

  // 1. Ensure CodeGraph is available
  const isAvailable = await cg.isAvailable();
  if (!isAvailable) {
    throw new Error(
      `CodeGraph binary ('${(cg as any).binaryPath || 'codegraph'}') not found in PATH.\nPlease install CodeGraph or set the CODEGRAPH_BIN environment variable.`
    );
  }

  // 2. Ensure CodeGraph index is ready
  await cg.ensureIndex(projectPath);

  // 3. Topology Detection
  const topology = await detectTopology(projectPath);

  // 4. Pattern & Invariant Analysis
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
