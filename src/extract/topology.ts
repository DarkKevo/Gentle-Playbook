import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Topology } from '../core/schema.js';

export async function detectTopology(projectPath: string): Promise<Topology> {
  const dirSet = new Set<string>();

  async function walk(dir: string, depth = 0) {
    if (depth > 4) return;
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
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
        const relPath = path.relative(projectPath, fullPath) + '/';
        dirSet.add(relPath);
        await walk(fullPath, depth + 1);
      }
    } catch {
      // Ignore unreadable dirs
    }
  }

  await walk(projectPath, 0);
  const dirs = Array.from(dirSet);

  // Pattern Detection Logic
  const hasAdaptersDrivers = dirs.some((d) => d.includes('adapters/drivers') || d.includes('adapters/driver'));
  const hasAdaptersDrivens = dirs.some((d) => d.includes('adapters/drivens') || d.includes('adapters/driven'));
  const hasPorts = dirs.some((d) => d.includes('ports'));
  const hasDomain = dirs.some((d) => d.includes('domain') || d.includes('entities'));
  const hasInfrastructure = dirs.some((d) => d.includes('infrastructure'));
  const hasApplication = dirs.some((d) => d.includes('application'));
  const hasInternal = dirs.some((d) => d.startsWith('internal/'));
  const hasCmd = dirs.some((d) => d.startsWith('cmd/'));
  const hasUseCases = dirs.some((d) => d.includes('usecase') || d.includes('usecases'));

  let pattern = 'Standard Layout';
  const canonicalDirs: string[] = [];

  if ((hasAdaptersDrivers || hasAdaptersDrivens) && (hasPorts || hasDomain)) {
    pattern = 'Modular Hexagonal (Ports & Adapters)';
    // Extract key recurring structural folders
    const drivers = dirs.find((d) => d.includes('adapters/drivers'));
    const drivens = dirs.find((d) => d.includes('adapters/drivens'));
    const ports = dirs.find((d) => d.includes('ports'));
    const domain = dirs.find((d) => d.includes('domain') || d.includes('entities'));
    const shared = dirs.find((d) => d.includes('shared'));

    if (drivers) canonicalDirs.push(drivers);
    if (drivens) canonicalDirs.push(drivens);
    if (ports) canonicalDirs.push(ports);
    if (domain) canonicalDirs.push(domain);
    if (shared) canonicalDirs.push(shared);
  } else if (hasInternal && (hasPorts || hasAdaptersDrivers || hasDomain)) {
    pattern = 'Hexagonal (Ports & Adapters)';
    if (hasCmd) canonicalDirs.push('cmd/api/');
    canonicalDirs.push('internal/core/domain/');
    canonicalDirs.push('internal/core/ports/');
    canonicalDirs.push('internal/adapters/handlers/');
    canonicalDirs.push('internal/adapters/storage/');
  } else if (hasDomain && (hasInfrastructure || hasApplication || hasUseCases)) {
    pattern = 'Clean Architecture';
    const dom = dirs.find((d) => d.includes('domain'));
    const app = dirs.find((d) => d.includes('application') || d.includes('usecase'));
    const infra = dirs.find((d) => d.includes('infrastructure') || d.includes('adapters'));
    if (dom) canonicalDirs.push(dom);
    if (app) canonicalDirs.push(app);
    if (infra) canonicalDirs.push(infra);
  } else if (hasUseCases) {
    pattern = 'Clean Architecture';
    canonicalDirs.push('domain/', 'usecases/', 'delivery/', 'repository/');
  }

  // Fallback to top-level directories if canonicalDirs is sparse
  if (canonicalDirs.length === 0) {
    const topLevelDirs = dirs.filter((d) => !d.includes('/') || d.indexOf('/') === d.length - 1);
    canonicalDirs.push(...topLevelDirs.slice(0, 6));
  }

  // Clean deduplication
  const uniqueDirs = Array.from(new Set(canonicalDirs)).sort();

  return {
    pattern,
    directories: uniqueDirs,
  };
}
