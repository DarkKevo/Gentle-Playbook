import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectProjectLanguage, extractPlaybook } from '../src/extract/extractor.js';
import { detectTopology } from '../src/extract/topology.js';
import { CodeGraphWrapper } from '../src/extract/codegraph.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturePath = path.join(__dirname, 'fixtures', 'go-hexagonal');

describe('Extraction Engine with Local Fixture', () => {
  it('should detect Go language from fixture repository root', async () => {
    const lang = await detectProjectLanguage(fixturePath);
    expect(lang).toBe('go');
  });

  it('should detect Modular Hexagonal topology in fixture', async () => {
    const topology = await detectTopology(fixturePath);
    expect(topology.pattern).toContain('Hexagonal');
    expect(topology.directories.length).toBeGreaterThan(0);
    expect(topology.directories.some((d) => d.includes('adapters'))).toBe(true);
  });

  it('should extract invariants, ask rules and snippets from fixture using CodeGraph', async () => {
    const cg = new CodeGraphWrapper();
    const isAvail = await cg.isAvailable();
    if (!isAvail) {
      console.warn('CodeGraph binary not available, skipping live extraction test');
      return;
    }

    const playbook = await extractPlaybook(fixturePath, { codeGraph: cg });

    expect(playbook.language).toBe('go');
    expect(playbook.topology.pattern).toContain('Hexagonal');

    // Invariants must include null-byte sanitizer, DTO validation, and API response envelope
    const hasSanitizer = playbook.invariants.some((i) => i.id === 'null-byte-sanitizer');
    const hasNotBlank = playbook.invariants.some((i) => i.id === 'dto-notblank-validation');
    const hasResponse = playbook.invariants.some((i) => i.id === 'api-response-envelope');

    expect(hasSanitizer).toBe(true);
    expect(hasNotBlank).toBe(true);
    expect(hasResponse).toBe(true);

    // Ask rules must include RBAC
    const hasRBAC = playbook.askRules.some((a) => a.id === 'rbac-authorization');
    expect(hasRBAC).toBe(true);

    // Snippets must be captured with actual source code
    expect(playbook.snippets.length).toBeGreaterThanOrEqual(2);
    const sanitizerSnippet = playbook.snippets.find((s) => s.id === 'canonical-null-byte-sanitizer');
    expect(sanitizerSnippet).toBeDefined();
    expect(sanitizerSnippet?.code).toContain('SanitizeInputMiddleware');
  });
});
