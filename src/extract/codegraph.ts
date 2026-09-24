import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const execFileAsync = promisify(execFile);

export interface CodeGraphNode {
  id: string;
  kind: string;
  name: string;
  qualifiedName: string;
  filePath: string;
  language: string;
  startLine: number;
  endLine: number;
  docstring?: string;
  signature?: string;
  returnType?: string;
}

export interface CodeGraphQueryResult {
  node: CodeGraphNode;
  score?: number;
}

export interface CodeGraphCallerItem {
  name: string;
  kind: string;
  filePath: string;
  startLine: number;
}

export interface CodeGraphCallersResponse {
  symbol: string;
  callers: CodeGraphCallerItem[];
}

export class CodeGraphWrapper {
  private binaryPath: string;

  constructor(customBinary?: string) {
    this.binaryPath = customBinary || process.env.CODEGRAPH_BIN || '/home/darkkevo/.local/bin/codegraph';
  }

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync(this.binaryPath, ['--version']);
      return true;
    } catch {
      return false;
    }
  }

  async hasIndex(projectPath: string): Promise<boolean> {
    const indexPath = path.join(projectPath, '.codegraph');
    try {
      const stat = await fs.stat(indexPath);
      return stat.isDirectory();
    } catch {
      return false;
    }
  }

  async ensureIndex(projectPath: string): Promise<void> {
    const exists = await this.hasIndex(projectPath);
    if (!exists) {
      await execFileAsync(this.binaryPath, ['init', projectPath]);
    }
  }

  async query(
    projectPath: string,
    search: string,
    options: { kind?: string; limit?: number } = {}
  ): Promise<CodeGraphQueryResult[]> {
    await this.ensureIndex(projectPath);
    const args = ['query', '-p', projectPath, '-j'];
    if (options.limit) {
      args.push('-l', options.limit.toString());
    }
    if (options.kind) {
      args.push('-k', options.kind);
    }
    args.push(search);

    try {
      const { stdout } = await execFileAsync(this.binaryPath, args, { maxBuffer: 10 * 1024 * 1024 });
      if (!stdout || stdout.trim() === '') return [];
      return JSON.parse(stdout.trim()) as CodeGraphQueryResult[];
    } catch (err: any) {
      // If no matches found or empty, return empty array
      return [];
    }
  }

  async callers(
    projectPath: string,
    symbol: string,
    options: { limit?: number } = {}
  ): Promise<CodeGraphCallerItem[]> {
    await this.ensureIndex(projectPath);
    const args = ['callers', '-p', projectPath, '-j'];
    if (options.limit) {
      args.push('-l', options.limit.toString());
    }
    args.push(symbol);

    try {
      const { stdout } = await execFileAsync(this.binaryPath, args, { maxBuffer: 10 * 1024 * 1024 });
      if (!stdout || stdout.trim() === '') return [];
      const parsed = JSON.parse(stdout.trim());
      if (Array.isArray(parsed)) return parsed;
      if (parsed && Array.isArray(parsed.callers)) return parsed.callers;
      return [];
    } catch {
      return [];
    }
  }
}
