import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Los comandos de OpenCode son templates markdown con frontmatter: nombre de
 * comando = nombre de archivo (/playbook, /playbook-add, ...). Esta suite
 * fija el contrato: los 5 comandos existen, tienen frontmatter válido con
 * description, y referencian las tools del plugin (playbook_consult /
 * playbook_manage) para orquestar los flujos agente-mediados.
 */

const COMMANDS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'opencode-commands');

const EXPECTED_COMMANDS = [
  { file: 'playbook.md', name: '/playbook', tools: ['playbook_consult'] },
  { file: 'playbook-add.md', name: '/playbook-add', tools: ['playbook_manage'] },
  { file: 'playbook-extract.md', name: '/playbook-extract', tools: ['playbook_manage'] },
  { file: 'playbook-stack.md', name: '/playbook-stack', tools: ['playbook_manage'] },
  { file: 'playbook-delete.md', name: '/playbook-delete', tools: ['playbook_manage'] },
];

function parseFrontmatter(raw: string): { data: Record<string, string>; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { data: {}, body: raw };
  const data: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (kv) data[kv[1]] = kv[2].trim();
  }
  return { data, body: match[2] };
}

describe('OpenCode command templates', () => {
  it('ships exactly the five command files', async () => {
    const files = (await fs.readdir(COMMANDS_DIR)).filter((f) => f.endsWith('.md')).sort();
    expect(files).toEqual(EXPECTED_COMMANDS.map((c) => c.file).sort());
  });

  for (const cmd of EXPECTED_COMMANDS) {
    it(`${cmd.name}: valid frontmatter with description, in Spanish, referencing the plugin tools`, async () => {
      const raw = await fs.readFile(path.join(COMMANDS_DIR, cmd.file), 'utf-8');
      const { data, body } = parseFrontmatter(raw);

      expect(data.description).toBeDefined();
      expect(data.description!.length).toBeGreaterThan(10);

      // El cuerpo orquesta con las tools del plugin, no con scripts externos.
      for (const tool of cmd.tools) {
        expect(body).toContain(tool);
      }

      // Convención del repo: documentación user-facing en español.
      expect(body).toMatch(/[áéíóúñ¿¡]/u);

      // Frontmatter cerrado y cuerpo no vacío.
      expect(raw.startsWith('---\n')).toBe(true);
      expect(body.trim().length).toBeGreaterThan(200);
    });
  }

  it('every command teaches explicit user confirmation before persistence', async () => {
    for (const cmd of EXPECTED_COMMANDS.filter((c) => c.tools.includes('playbook_manage'))) {
      const raw = await fs.readFile(path.join(COMMANDS_DIR, cmd.file), 'utf-8');
      expect(
        raw.toLowerCase().match(/confirmaci[oó]n|confirm[áa]|confirmaci/),
        `${cmd.file} debe exigir confirmación del usuario antes de persistir`
      ).not.toBeNull();
    }
  });
});
