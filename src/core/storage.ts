import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { Playbook, AGENTS_PREFERENCES_ID } from './schema.js';
import { parsePlaybook, serializePlaybook } from './parser.js';
import { filterPlaybookRules } from './security.js';
import { resolveLanguage } from './languages.js';

export class PlaybookStorage {
  private baseDir: string;
  private stacksDir: string;

  constructor(customDir?: string) {
    if (customDir) {
      this.baseDir = customDir;
      if (path.basename(customDir) === 'languages') {
        this.stacksDir = path.join(path.dirname(customDir), 'stacks');
      } else {
        this.stacksDir = path.join(customDir, 'stacks');
      }
    } else if (process.env.GENTLE_PLAYBOOK_DIR) {
      this.baseDir = process.env.GENTLE_PLAYBOOK_DIR;
      if (path.basename(this.baseDir) === 'languages') {
        this.stacksDir = path.join(path.dirname(this.baseDir), 'stacks');
      } else {
        this.stacksDir = path.join(this.baseDir, 'stacks');
      }
    } else {
      const configRoot = path.join(os.homedir(), '.config', 'gentle-playbook');
      this.baseDir = path.join(configRoot, 'languages');
      this.stacksDir = path.join(configRoot, 'stacks');
    }
  }

  getBaseDir(): string {
    return this.baseDir;
  }

  getStacksDir(): string {
    return this.stacksDir;
  }

  async ensureDir(): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true });
    await fs.mkdir(this.stacksDir, { recursive: true });
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
    const { playbook: safePlaybook } = filterPlaybookRules(playbook);
    const filePath = this.getFilePath(safePlaybook.language);
    const markdown = serializePlaybook(safePlaybook);
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

  async deleteRule(language: string, ruleId: string): Promise<{ deleted: boolean; ruleType?: string }> {
    const playbook = await this.getPlaybook(language);
    if (!playbook) {
      return { deleted: false };
    }

    const res = this.removeRuleFromPlaybook(playbook, ruleId);
    if (res.deleted) {
      await this.savePlaybook(playbook);
    }
    return res;
  }

  private removeRuleFromPlaybook(playbook: Playbook, ruleId: string): { deleted: boolean; ruleType?: string } {
    const normId = ruleId.trim().toLowerCase();

    // 1. Check in Invariants
    const invIdx = playbook.invariants.findIndex((i) => i.id.toLowerCase() === normId);
    if (invIdx >= 0) {
      playbook.invariants.splice(invIdx, 1);
      return { deleted: true, ruleType: 'invariant' };
    }

    // 2. Check in Ask Rules
    const askIdx = playbook.askRules.findIndex((a) => a.id.toLowerCase() === normId);
    if (askIdx >= 0) {
      playbook.askRules.splice(askIdx, 1);
      return { deleted: true, ruleType: 'ask' };
    }

    // 3. Check in Never Rules
    if (playbook.neverRules) {
      const neverIdx = playbook.neverRules.findIndex((n) => n.id.toLowerCase() === normId);
      if (neverIdx >= 0) {
        playbook.neverRules.splice(neverIdx, 1);
        if (playbook.neverRules.length === 0) {
          delete playbook.neverRules;
        }
        return { deleted: true, ruleType: 'never' };
      }
    }

    // 4. Check in Snippets
    const snipIdx = playbook.snippets.findIndex((s) => s.id.toLowerCase() === normId);
    if (snipIdx >= 0) {
      playbook.snippets.splice(snipIdx, 1);
      return { deleted: true, ruleType: 'snippet' };
    }

    return { deleted: false };
  }

  // --- Stacks Management ---
  private getStackFilePath(stackId: string): string {
    const slug = stackId.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
    return path.join(this.stacksDir, `${slug}.md`);
  }

  async listStacks(): Promise<string[]> {
    await this.ensureDir();
    try {
      const entries = await fs.readdir(this.stacksDir, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
        .map((entry) => path.basename(entry.name, '.md'))
        .sort();
    } catch {
      return [];
    }
  }

  async hasStack(stackId: string): Promise<boolean> {
    const filePath = this.getStackFilePath(stackId);
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async getStack(stackId: string): Promise<Playbook | null> {
    const filePath = this.getStackFilePath(stackId);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const pb = parsePlaybook(content);
      pb.scope = 'stack';
      if (!pb.stackId) pb.stackId = stackId;
      return pb;
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return null;
      }
      throw err;
    }
  }

  async saveStack(playbook: Playbook): Promise<void> {
    await this.ensureDir();
    playbook.scope = 'stack';
    const slug = (playbook.stackId || playbook.language).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
    playbook.stackId = slug;
    playbook.language = slug;
    const { playbook: safePlaybook } = filterPlaybookRules(playbook);
    const filePath = this.getStackFilePath(slug);
    const markdown = serializePlaybook(safePlaybook);
    await fs.writeFile(filePath, markdown, 'utf-8');
  }

  async deleteStack(stackId: string): Promise<boolean> {
    const filePath = this.getStackFilePath(stackId);
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

  async deleteRuleFromStack(stackId: string, ruleId: string): Promise<{ deleted: boolean; ruleType?: string }> {
    const pb = await this.getStack(stackId);
    if (!pb) return { deleted: false };
    const res = this.removeRuleFromPlaybook(pb, ruleId);
    if (res.deleted) {
      await this.saveStack(pb);
    }
    return res;
  }

  // --- Local Project Playbook Management ---
  getLocalProjectPath(projectDir?: string): string {
    const targetDir = projectDir || process.cwd();
    return path.join(targetDir, 'playbook.md');
  }

  async hasLocalProjectPlaybook(projectDir?: string): Promise<boolean> {
    const filePath = this.getLocalProjectPath(projectDir);
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async getLocalProjectPlaybook(projectDir?: string): Promise<Playbook | null> {
    const filePath = this.getLocalProjectPath(projectDir);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const pb = parsePlaybook(content);
      pb.scope = 'project';
      return pb;
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return null;
      }
      throw err;
    }
  }

  async saveLocalProjectPlaybook(playbook: Playbook, projectDir?: string): Promise<void> {
    playbook.scope = 'project';
    playbook.language = 'project';
    const { playbook: safePlaybook } = filterPlaybookRules(playbook);
    const filePath = this.getLocalProjectPath(projectDir);
    const markdown = serializePlaybook(safePlaybook);
    await fs.writeFile(filePath, markdown, 'utf-8');
  }

  async deleteLocalProjectPlaybook(projectDir?: string): Promise<boolean> {
    const filePath = this.getLocalProjectPath(projectDir);
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

  async deleteRuleFromProject(projectDir: string, ruleId: string): Promise<{ deleted: boolean; ruleType?: string }> {
    const pb = await this.getLocalProjectPlaybook(projectDir);
    if (!pb) return { deleted: false };
    const res = this.removeRuleFromPlaybook(pb, ruleId);
    if (res.deleted) {
      await this.saveLocalProjectPlaybook(pb, projectDir);
    }
    return res;
  }
}
