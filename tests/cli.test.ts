import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';

const execFileAsync = promisify(execFile);
const cliPath = path.resolve(__dirname, '../dist/cli.js');

describe('CLI Integration', () => {
  it('should execute gentle-playbook list command', async () => {
    const { stdout } = await execFileAsync('node', [cliPath, 'list']);
    expect(stdout).toContain('Available Gentle Playbooks:');
    expect(stdout).toContain('go');
  });

  it('should execute gentle-playbook show go command', async () => {
    const { stdout } = await execFileAsync('node', [cliPath, 'show', 'go']);
    expect(stdout).toContain('# Playbook: Go');
    expect(stdout).toContain('Topology: Modular Hexagonal');
    expect(stdout).toContain('[INVARIANT:null-byte-sanitizer]');
  });
});
