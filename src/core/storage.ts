import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { Playbook, AGENTS_PREFERENCES_ID } from './schema.js';
import { parsePlaybook, serializePlaybook } from './parser.js';
import { resolveLanguage } from './languages.js';

export class PlaybookStorage {
  private baseDir: string;

  constructor(customDir?: string) {
    if (customDir) {
      this.baseDir = customDir;
    } else if (process.env.GENTLE_PLAYBOOK_DIR) {
      this.baseDir = process.env.GENTLE_PLAYBOOK_DIR;
    } else {
      this.baseDir = path.join(os.homedir(), '.config', 'gentle-playbook', 'languages');
    }
  }

  getBaseDir(): string {
    return this.baseDir;
  }

  async ensureDir(): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true });
  }

  private getFilePath(language: string): string {
    const resolved = resolveLanguage(language);
    return path.join(this.baseDir, `${resolved}.md`);
  }

  async listLanguages(): Promise<string[]> {
    await this.ensureDir();
    try {
      const entries = await fs.readdir(this.baseDir, { withFileTypes: true });
      return entries
        .filter(
          (entry) =>
            entry.isFile() &&
            entry.name.endsWith('.md') &&
            entry.name !== `${AGENTS_PREFERENCES_ID}.md`
        )
        .map((entry) => path.basename(entry.name, '.md'))
        .sort();
    } catch {
      return [];
    }
  }

  async hasAgentPreferences(): Promise<boolean> {
    return this.exists(AGENTS_PREFERENCES_ID);
  }

  async getAgentPreferences(): Promise<Playbook | null> {
    return this.getPlaybook(AGENTS_PREFERENCES_ID);
  }

  async saveAgentPreferences(playbook: Playbook): Promise<void> {
    playbook.language = AGENTS_PREFERENCES_ID;
    return this.savePlaybook(playbook);
  }

  async exists(language: string): Promise<boolean> {
    const filePath = this.getFilePath(language);
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async getPlaybook(language: string): Promise<Playbook | null> {
    const filePath = this.getFilePath(language);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return parsePlaybook(content);
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return null;
      }
      throw err;
    }
  }

  async savePlaybook(playbook: Playbook): Promise<void> {
    await this.ensureDir();
    const filePath = this.getFilePath(playbook.language);
    const markdown = serializePlaybook(playbook);
    await fs.writeFile(filePath, markdown, 'utf-8');
  }

  async deletePlaybook(language: string): Promise<boolean> {
    const filePath = this.getFilePath(language);
    try {
      await fs.unlink(filePath);
      return true;
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return false;
      }
      throw err;
    }
  }
}
