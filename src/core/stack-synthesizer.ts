import { InvariantRule, AskRule, NeverRule, StackDetectionRule } from './schema.js';
import { normalizeFlag } from './stack-detector.js';

export interface SynthesizedStack {
  slug: string;
  name: string;
  description: string;
  requiredFlags: string[];
  detection?: StackDetectionRule;
  initialInvariants?: InvariantRule[];
  initialAsks?: AskRule[];
  initialNevers?: NeverRule[];
}

export function buildStackSynthesisPrompt(userPrompt: string): string {
  return `Eres un arquitecto de software especializado en diseño de sistemas y gobernanza tecnológica.
El usuario desea definir un STACK TECNOLÓGICO para organizar normas de arquitectura (ej: "go con gin y gorm", "nest con typeorm y postgres").

Entrada del usuario:
"${userPrompt}"

Tu tarea es sintetizar este Stack Tecnológico devolviendo ÚNICAMENTE un bloque JSON válido con el siguiente esquema:
{
  "slug": "identificador-kebab-case (ej: go-gin, nest-typeorm, sol-hardhat)",
  "name": "Nombre Legible del Stack (ej: Go + Gin REST API)",
  "description": "Breve descripción del propósito y ámbito de este stack",
  "requiredFlags": ["lista", "de", "banderas", "tecnologicas", "minusculas"],
  "detectionFiles": [
    {
      "path": "archivo relativo para detectar este stack (ej: go.mod, package.json)",
      "contains": ["patron-o-dependencia-clave-ej-github.com/gin-gonic/gin"]
    }
  ],
  "suggestedRules": [
    {
      "id": "slug-regla",
      "type": "invariant",
      "title": "Título de la regla",
      "surface": "superficie afectada (ej: internal/handlers, src/modules)",
      "description": "Descripción de la norma arquitectónica"
    }
  ]
}

Reglas obligatorias:
1. "slug" debe ser conciso, alfanumérico en minúsculas separado por guiones.
2. "requiredFlags" deben ser tokens tecnológicos normalizados (ej: ["go", "gin"] o ["typescript", "nest", "typeorm"]).
3. Solo genera JSON puro. Sin explicaciones, sin markdown exterior.`;
}

export function parseSynthesizedStack(rawOutput: string, fallbackPrompt?: string): SynthesizedStack {
  let cleaned = rawOutput.trim();
  const jsonMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (jsonMatch) {
    cleaned = jsonMatch[1].trim();
  }

  try {
    const parsed = JSON.parse(cleaned);
    const slug = (parsed.slug || '')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '');
    const name = parsed.name || (slug ? slug.toUpperCase() : 'Custom Stack');
    const description = parsed.description || `Stack tecnológico para ${name}`;
    const rawFlags: string[] = Array.isArray(parsed.requiredFlags) ? parsed.requiredFlags : [];
    const requiredFlags = Array.from(new Set(rawFlags.map(normalizeFlag).filter(Boolean)));

    const detectionFiles = Array.isArray(parsed.detectionFiles)
      ? parsed.detectionFiles.filter((f: any) => f && typeof f.path === 'string')
      : undefined;

    const initialInvariants: InvariantRule[] = [];
    if (Array.isArray(parsed.suggestedRules)) {
      for (const r of parsed.suggestedRules) {
        if (r && r.id && r.title && r.description) {
          initialInvariants.push({
            id: r.id.toLowerCase().replace(/[^a-z0-9_-]+/g, '-'),
            type: 'invariant',
            title: r.title,
            surface: r.surface || 'src/',
            description: r.description,
          });
        }
      }
    }

    if (slug && requiredFlags.length > 0) {
      return {
        slug,
        name,
        description,
        requiredFlags,
        detection: detectionFiles ? { requiredFlags, files: detectionFiles } : undefined,
        initialInvariants: initialInvariants.length > 0 ? initialInvariants : undefined,
      };
    }
  } catch {
    // Si falla el parseo JSON, continuar al fallback heurístico
  }

  return heuristicFallbackStack(fallbackPrompt || rawOutput);
}

/**
 * Fallback heurístico determinista cuando no hay modelo disponible o falla el JSON.
 */
export function heuristicFallbackStack(userPrompt: string): SynthesizedStack {
  const text = userPrompt.toLowerCase();
  const flags: string[] = [];

  if (/\b(?:go|golang)\b/.test(text)) flags.push('go');
  if (/\bgin\b/.test(text)) flags.push('gin');
  if (/\bfiber\b/.test(text)) flags.push('fiber');
  if (/\bgorm\b/.test(text)) flags.push('gorm');
  if (/\b(?:ts|typescript)\b/.test(text)) flags.push('typescript');
  if (/\b(?:js|javascript)\b/.test(text)) flags.push('javascript');
  if (/\bnest(?:js)?\b/.test(text)) flags.push('nest');
  if (/\bexpress\b/.test(text)) flags.push('express');
  if (/\btypeorm\b/.test(text)) flags.push('typeorm');
  if (/\bprisma\b/.test(text)) flags.push('prisma');
  if (/\breact\b/.test(text)) flags.push('react');
  if (/\bnext(?:js)?\b/.test(text)) flags.push('next');
  if (/\bsolidity\b/.test(text)) flags.push('solidity');
  if (/\bhardhat\b/.test(text)) flags.push('hardhat');
  if (/\bpython\b/.test(text)) flags.push('python');
  if (/\bfastapi\b/.test(text)) flags.push('fastapi');
  if (/\bdjango\b/.test(text)) flags.push('django');
  if (/\brust\b/.test(text)) flags.push('rust');

  const cleanSlug = flags.length > 0
    ? flags.join('-')
    : userPrompt
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'custom-stack';

  const normalizedFlags = Array.from(new Set(flags.map(normalizeFlag)));
  if (normalizedFlags.length === 0) {
    normalizedFlags.push(cleanSlug);
  }

  return {
    slug: cleanSlug,
    name: normalizedFlags.map((f) => f.toUpperCase()).join(' + '),
    description: `Stack configurado para ${userPrompt.trim()}`,
    requiredFlags: normalizedFlags,
  };
}
