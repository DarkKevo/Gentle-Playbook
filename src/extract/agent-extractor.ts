import { Playbook } from '../core/schema.js';
import { parsePlaybook } from '../core/parser.js';
import { detectTopology } from './topology.js';
import { detectProjectLanguage } from './extractor.js';
import { buildAgentExtractorPrompt } from './prompt.js';
import { collectProjectContext } from './context-collector.js';

export interface AgentExtractionResult {
  evidenceReport: string;
  playbookMarkdown: string;
  playbook: Playbook;
}

export function parseAgentOutput(rawOutput: string, defaultLang: string): AgentExtractionResult {
  let evidenceReport = '';
  let playbookMarkdown = '';

  const evidenceMarker = '=== REPORTE DE EVIDENCIA ===';
  const playbookMarker = '=== PLAYBOOK COMPACTO ===';

  const evidenceIdx = rawOutput.indexOf(evidenceMarker);
  const playbookIdx = rawOutput.indexOf(playbookMarker);

  if (evidenceIdx !== -1 && playbookIdx !== -1 && playbookIdx > evidenceIdx) {
    evidenceReport = rawOutput.slice(evidenceIdx + evidenceMarker.length, playbookIdx).trim();
    playbookMarkdown = rawOutput.slice(playbookIdx + playbookMarker.length).trim();
  } else {
    // Si no vinieron los marcadores exactos, buscar bloques delimitados por markdown
    const codeBlockMatch = rawOutput.match(/```markdown([\s\S]*?)```/);
    if (codeBlockMatch) {
      playbookMarkdown = codeBlockMatch[1].trim();
      evidenceReport = rawOutput.replace(codeBlockMatch[0], '').trim();
    } else {
      playbookMarkdown = rawOutput.trim();
      evidenceReport = 'No se incluyó reporte de evidencia separado en la salida del modelo.';
    }
  }

  // Limpiar posibles fences de markdown alrededor del playbook
  if (playbookMarkdown.startsWith('```markdown')) {
    playbookMarkdown = playbookMarkdown.replace(/^```markdown\r?\n/, '').replace(/\r?\n```$/, '');
  } else if (playbookMarkdown.startsWith('```')) {
    playbookMarkdown = playbookMarkdown.replace(/^```\r?\n/, '').replace(/\r?\n```$/, '');
  }

  const playbook = parsePlaybook(playbookMarkdown);
  if (!playbook.language || playbook.language === 'unknown') {
    playbook.language = defaultLang;
  }

  return {
    evidenceReport,
    playbookMarkdown,
    playbook,
  };
}

export interface AgentExtractorOptions {
  language?: string;
  completePrompt?: (prompt: string) => Promise<string>;
}

export async function runAgentExtraction(
  targetPath: string,
  options: AgentExtractorOptions = {}
): Promise<AgentExtractionResult> {
  const language = options.language || (await detectProjectLanguage(targetPath));
  const topology = await detectTopology(targetPath);

  // Recolectar contexto real del repositorio (CodeGraph index o archivos de muestra)
  const context = await collectProjectContext(targetPath, language);

  const prompt = buildAgentExtractorPrompt({
    targetPath,
    language,
    topology: topology.pattern,
    contextText: context.formattedContext,
  });

  if (!options.completePrompt) {
    throw new Error(
      'No se proveyó una función para ejecutar el prompt del agente. Usa /gentle-playbook extract dentro de Pi para usar su modelo.'
    );
  }

  const rawOutput = await options.completePrompt(prompt);
  const result = parseAgentOutput(rawOutput, language);
  if (result.playbook.topology.pattern === 'Standard' && topology.pattern) {
    result.playbook.topology = topology;
  }
  return result;
}
