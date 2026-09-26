import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { CodeGraphWrapper, CodeGraphQueryResult } from './codegraph.js';

export interface ProjectContextOptions {
  codeGraph?: CodeGraphWrapper;
  maxFilesToRead?: number;
  maxLinesPerFile?: number;
}

export interface CollectedProjectContext {
  usedCodeGraph: boolean;
  manifests: { file: string; content: string }[];
  fileList: string[];
  symbolsSummary?: string;
  codeSnippets: { filePath: string; content: string }[];
  formattedContext: string;
}

const MANIFEST_CANDIDATES = [
  'package.json',
  'go.mod',
  'Cargo.toml',
  'pyproject.toml',
  'requirements.txt',
];

const IGNORED_DIRS = new Set([
  '.git',
  '.codegraph',
  'node_modules',
  'vendor',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
]);

const LANG_EXTENSIONS: Record<string, string[]> = {
  go: ['.go'],
  typescript: ['.ts', '.tsx', '.js', '.jsx'],
  rust: ['.rs'],
  python: ['.py'],
};

export async function collectProjectContext(
  projectPath: string,
  language: string,
  options: ProjectContextOptions = {}
): Promise<CollectedProjectContext> {
  const cg = options.codeGraph || new CodeGraphWrapper();
  const maxFiles = options.maxFilesToRead || 5;
  const maxLines = options.maxLinesPerFile || 120;

  // 1. Manifiestos
  const manifests: { file: string; content: string }[] = [];
  for (const candidate of MANIFEST_CANDIDATES) {
    try {
      const full = path.join(projectPath, candidate);
      const raw = await fs.readFile(full, 'utf-8');
      manifests.push({ file: candidate, content: raw.slice(0, 3000) });
    } catch {
      // Ignorar si no existe
    }
  }

  // 2. Intentar explorar con CodeGraph si está disponible
  let usedCodeGraph = false;
  let codeGraphResults: CodeGraphQueryResult[] = [];
  let symbolsSummary = '';

  try {
    const isAvail = await cg.isAvailable();
    if (isAvail) {
      await cg.ensureIndex(projectPath);
      codeGraphResults = await cg.query(projectPath, '', { limit: 60 });
      if (codeGraphResults.length > 0) {
        usedCodeGraph = true;
        const lines: string[] = [];
        for (const item of codeGraphResults) {
          const n = item.node;
          lines.push(
            `- [${n.kind || 'Symbol'}] ${n.qualifiedName || n.name} en \`${n.filePath}:${n.startLine}-${n.endLine}\``
          );
        }
        symbolsSummary = lines.slice(0, 50).join('\n');
      }
    }
  } catch {
    usedCodeGraph = false;
  }

  // 3. Recorrido de archivos de código (usando CodeGraph nodes o filesystem)
  const allowedExts = LANG_EXTENSIONS[language] || ['.ts', '.js', '.go', '.rs', '.py'];
  const fileList: string[] = [];

  if (usedCodeGraph && codeGraphResults.length > 0) {
    const uniqueFiles = Array.from(new Set(codeGraphResults.map((r) => r.node.filePath)));
    fileList.push(...uniqueFiles);
  } else {
    // Recorrido de filesystem
    async function scanDir(current: string, rel: string, depth = 0) {
      if (depth > 5) return;
      try {
        const entries = await fs.readdir(current, { withFileTypes: true });
        for (const entry of entries) {
          if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
          const entryRel = rel ? path.join(rel, entry.name) : entry.name;
          const entryFull = path.join(current, entry.name);
          if (entry.isDirectory()) {
            await scanDir(entryFull, entryRel, depth + 1);
          } else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase();
            if (allowedExts.includes(ext)) {
              fileList.push(entryRel);
            }
          }
        }
      } catch {}
    }
    await scanDir(projectPath, '', 0);
  }

  // 4. Seleccionar archivos representativos para lectura de código
  // Priorizar middlewares, handlers, controladores, modelos, schemas o servicios
  const priorityPatterns = [
    /middleware/i,
    /handler/i,
    /controller/i,
    /route/i,
    /service/i,
    /model/i,
    /schema/i,
    /validator/i,
    /sanitize/i,
    /main/i,
  ];

  const sortedFiles = [...fileList].sort((a, b) => {
    const scoreA = priorityPatterns.reduce((acc, p) => acc + (p.test(a) ? 1 : 0), 0);
    const scoreB = priorityPatterns.reduce((acc, p) => acc + (p.test(b) ? 1 : 0), 0);
    return scoreB - scoreA;
  });

  const selectedFiles = sortedFiles.slice(0, maxFiles);
  const codeSnippets: { filePath: string; content: string }[] = [];

  for (const relPath of selectedFiles) {
    try {
      const fullPath = path.isAbsolute(relPath) ? relPath : path.join(projectPath, relPath);
      const rawContent = await fs.readFile(fullPath, 'utf-8');
      const lines = rawContent.split(/\r?\n/).slice(0, maxLines);
      const numbered = lines.map((line, idx) => `${idx + 1} | ${line}`).join('\n');
      codeSnippets.push({
        filePath: relPath,
        content: numbered,
      });
    } catch {}
  }

  // 5. Formatear la sección de Markdown para el prompt
  const parts: string[] = [];
  parts.push(
    `## CONTEXTO REAL DEL REPOSITORIO (${usedCodeGraph ? 'Indexado y Analizado con CodeGraph' : 'Inspección Estructural de Archivos'})\n`
  );

  if (manifests.length > 0) {
    parts.push('### MANIFIESTOS DE DEPENDENCIAS:');
    for (const m of manifests) {
      parts.push(`**${m.file}**:\n\`\`\`\n${m.content}\n\`\`\`\n`);
    }
  }

  if (fileList.length > 0) {
    parts.push(`### ÁRBOL DE ARCHIVOS DE CÓDIGO (${fileList.length} archivos detectados):`);
    parts.push(fileList.slice(0, 30).map((f) => `- ${f}`).join('\n') + (fileList.length > 30 ? '\n- ... y más' : ''));
    parts.push('\n');
  }

  if (usedCodeGraph && symbolsSummary) {
    parts.push('### MAPA DE SÍMBOLOS Y DEFINICIONES (CodeGraph Index):');
    parts.push(symbolsSummary);
    parts.push('\n');
  }

  if (codeSnippets.length > 0) {
    parts.push('### MUESTRAS DE CÓDIGO FUENTE REAL (Líneas numeradas):');
    for (const s of codeSnippets) {
      parts.push(`#### Archivo: \`${s.filePath}\`\n\`\`\`${language}\n${s.content}\n\`\`\`\n`);
    }
  }

  const formattedContext = parts.join('\n');

  return {
    usedCodeGraph,
    manifests,
    fileList,
    symbolsSummary,
    codeSnippets,
    formattedContext,
  };
}
