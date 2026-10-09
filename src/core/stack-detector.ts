import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Playbook, StackDetectionFileRule } from './schema.js';

export interface ProjectFlags {
  flags: Set<string>;
  manifests: {
    packageJson?: any;
    goMod?: string;
    cargoToml?: string;
    requirementsTxt?: string;
    pyprojectToml?: string;
  };
}

const MAX_MANIFEST_SIZE_BYTES = 2 * 1024 * 1024; // 2 MB guard against DoS

/**
 * Normaliza una bandera tecnológica para matching consistente.
 */
export function normalizeFlag(flag: string): string {
  const f = flag.trim().toLowerCase();
  if (f === 'golang') return 'go';
  if (f === 'ts') return 'typescript';
  if (f === 'js') return 'javascript';
  if (f === 'py') return 'python';
  if (f === 'sol') return 'solidity';
  if (f === 'nextjs') return 'next';
  if (f === 'nestjs') return 'nest';
  return f;
}

/**
 * Confinar una ruta relativa dentro del proyecto para neutralizar Path Traversal.
 * Devuelve la ruta resuelta absoluta si está confinada, o null si escapa.
 */
export function resolveSafeProjectPath(projectPath: string, relPath: string): string | null {
  if (!relPath || typeof relPath !== 'string') return null;
  const canonicalRoot = path.resolve(projectPath);
  const resolved = path.resolve(canonicalRoot, relPath);

  // Asegurar que comience con la ruta del proyecto seguido del separador o sea idéntico
  if (resolved === canonicalRoot || resolved.startsWith(canonicalRoot + path.sep)) {
    return resolved;
  }
  return null;
}

/**
 * Escanea un proyecto y detecta el conjunto de banderas tecnológicas (lenguajes, frameworks, herramientas).
 */
export async function detectProjectFlags(
  projectPath: string,
  extraRules: StackDetectionFileRule[] = []
): Promise<Set<string>> {
  const flags = new Set<string>();

  const fileExists = async (relPath: string): Promise<boolean> => {
    const safePath = resolveSafeProjectPath(projectPath, relPath);
    if (!safePath) return false;
    try {
      await fs.access(safePath);
      return true;
    } catch {
      return false;
    }
  };

  const readFileSafe = async (relPath: string): Promise<string | null> => {
    const safePath = resolveSafeProjectPath(projectPath, relPath);
    if (!safePath) return null;
    try {
      const stats = await fs.stat(safePath);
      if (stats.size > MAX_MANIFEST_SIZE_BYTES) return null;
      return await fs.readFile(safePath, 'utf-8');
    } catch {
      return null;
    }
  };

  // 1. Go Ecosystem
  const goModContent = await readFileSafe('go.mod');
  if (goModContent !== null) {
    flags.add('go');
    if (/github\.com\/gin-gonic\/gin\b/i.test(goModContent)) flags.add('gin');
    if (/github\.com\/gofiber\/fiber\b/i.test(goModContent)) flags.add('fiber');
    if (/github\.com\/go-chi\/chi\b/i.test(goModContent)) flags.add('chi');
    if (/gorm\.io\/gorm\b/i.test(goModContent)) flags.add('gorm');
    if (/github\.com\/labstack\/echo\b/i.test(goModContent)) flags.add('echo');
  } else {
    // Buscar si hay archivos *.go superficialmente
    try {
      const entries = await fs.readdir(projectPath, { withFileTypes: true });
      if (entries.some((e) => e.isFile() && e.name.endsWith('.go'))) {
        flags.add('go');
      }
    } catch {
      // Ignorar error de lectura
    }
  }

  // 2. Node / JS / TS Ecosystem
  const pkgJsonRaw = await readFileSafe('package.json');
  if (pkgJsonRaw !== null) {
    flags.add('javascript');
    try {
      const pkg = JSON.parse(pkgJsonRaw);
      const allDeps = {
        ...(pkg.dependencies || {}),
        ...(pkg.devDependencies || {}),
        ...(pkg.peerDependencies || {}),
      };

      if (allDeps['typescript'] || (await fileExists('tsconfig.json'))) {
        flags.add('typescript');
      }
      if (allDeps['@nestjs/core']) flags.add('nest');
      if (allDeps['express']) flags.add('express');
      if (allDeps['fastify']) flags.add('fastify');
      if (allDeps['typeorm']) flags.add('typeorm');
      if (allDeps['@prisma/client'] || allDeps['prisma'] || (await fileExists('prisma/schema.prisma'))) {
        flags.add('prisma');
      }
      if (allDeps['react']) flags.add('react');
      if (allDeps['next']) flags.add('next');
      if (allDeps['vue']) flags.add('vue');
      if (allDeps['tailwindcss'] || (await fileExists('tailwind.config.js')) || (await fileExists('tailwind.config.ts'))) {
        flags.add('tailwind');
      }
      if (allDeps['hardhat'] || (await fileExists('hardhat.config.js')) || (await fileExists('hardhat.config.ts'))) {
        flags.add('hardhat');
        flags.add('solidity');
      }
    } catch {
      // package.json malformado, continuar
    }
  } else if (await fileExists('tsconfig.json')) {
    flags.add('typescript');
    flags.add('javascript');
  }

  // 3. Solidity Ecosystem
  if (
    (await fileExists('foundry.toml')) ||
    (await fileExists('hardhat.config.js')) ||
    (await fileExists('hardhat.config.ts'))
  ) {
    flags.add('solidity');
    if (await fileExists('foundry.toml')) flags.add('foundry');
    if (await fileExists('hardhat.config.js') || await fileExists('hardhat.config.ts')) flags.add('hardhat');
  }

  // 4. Rust Ecosystem
  const cargoToml = await readFileSafe('Cargo.toml');
  if (cargoToml !== null) {
    flags.add('rust');
    if (/actix-web\b/i.test(cargoToml)) flags.add('actix');
    if (/axum\b/i.test(cargoToml)) flags.add('axum');
    if (/tokio\b/i.test(cargoToml)) flags.add('tokio');
  }

  // 5. Python Ecosystem
  const reqTxt = await readFileSafe('requirements.txt');
  const pyproj = await readFileSafe('pyproject.toml');
  if (reqTxt !== null || pyproj !== null || (await fileExists('Pipfile')) || (await fileExists('setup.py'))) {
    flags.add('python');
    const pyContent = `${reqTxt || ''}\n${pyproj || ''}`;
    if (/\bdjango\b/i.test(pyContent)) flags.add('django');
    if (/\bfastapi\b/i.test(pyContent)) flags.add('fastapi');
    if (/\bflask\b/i.test(pyContent)) flags.add('flask');
    if (/\bsqlalchemy\b/i.test(pyContent)) flags.add('sqlalchemy');
  }

  // 6. Check custom / extra detection rules
  for (const rule of extraRules) {
    const content = await readFileSafe(rule.path);
    if (content !== null) {
      if (rule.contains && rule.contains.length > 0) {
        const matchesAll = rule.contains.every((c) => content.includes(c));
        if (matchesAll) {
          flags.add(rule.path);
        }
      } else {
        flags.add(rule.path);
      }
    }
  }

  return flags;
}

/**
 * Evalúa si un Stack específico está activo en un proyecto basándose en subtipado estructural
 * (requiere que TODAS las banderas obligatorias del stack estén presentes en el proyecto).
 */
export async function isStackActive(
  stack: Playbook,
  projectFlags: Set<string>,
  projectPath?: string
): Promise<boolean> {
  const req = stack.requiredFlags || [];
  if (req.length === 0) {
    // Si no tiene banderas explícitas, verificar por stackId
    if (stack.stackId && projectFlags.has(normalizeFlag(stack.stackId))) {
      return true;
    }
    return false;
  }

  // Subtipado estructural estricto: TODAS las banderas requeridas deben estar presentes
  const flagsMatch = req.every((flag) => projectFlags.has(normalizeFlag(flag)));
  if (!flagsMatch) {
    return false;
  }

  // Si tiene reglas adicionales de archivo personalizadas, verificarlas
  if (stack.detection?.files && projectPath) {
    for (const fRule of stack.detection.files) {
      const safePath = resolveSafeProjectPath(projectPath, fRule.path);
      if (!safePath) return false;
      try {
        const stats = await fs.stat(safePath);
        if (stats.size > MAX_MANIFEST_SIZE_BYTES) return false;
        const content = await fs.readFile(safePath, 'utf-8');
        if (fRule.contains && fRule.contains.length > 0) {
          const allFound = fRule.contains.every((substr) => content.includes(substr));
          if (!allFound) return false;
        }
      } catch {
        // Archivo no existe o no se puede leer
        return false;
      }
    }
  }

  return true;
}

/**
 * Filtra y devuelve todos los stacks activos para un proyecto dado.
 */
export async function detectActiveStacks(
  projectPath: string,
  allStacks: Playbook[]
): Promise<Playbook[]> {
  if (allStacks.length === 0) return [];

  // Extraer banderas adicionales declaradas por los stacks
  const extraRules: StackDetectionFileRule[] = [];
  for (const s of allStacks) {
    if (s.detection?.files) {
      extraRules.push(...s.detection.files);
    }
  }

  const projectFlags = await detectProjectFlags(projectPath, extraRules);
  const active: Playbook[] = [];

  for (const stack of allStacks) {
    if (await isStackActive(stack, projectFlags, projectPath)) {
      active.push(stack);
    }
  }

  return active;
}
