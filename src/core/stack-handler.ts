import { PlaybookStorage } from './storage.js';
import { Playbook, InvariantRule, AskRule, NeverRule } from './schema.js';
import {
  buildStackSynthesisPrompt,
  parseSynthesizedStack,
  heuristicFallbackStack,
  SynthesizedStack,
} from './stack-synthesizer.js';
import { formatPlaybookForDisplay } from './parser.js';

export interface CollidingRuleInfo {
  scopeLabel: string;
  ruleType: 'invariant' | 'ask' | 'never';
  rule: InvariantRule | AskRule | NeverRule;
  reason: string;
}

/**
 * Busca reglas existentes en otros ámbitos que colisionen o toquen la misma superficie.
 */
export function findCollidingRules(
  newRule: { id: string; surface: string; title: string; description: string },
  candidateLayers: Array<{ scopeLabel: string; playbook: Playbook }>
): CollidingRuleInfo[] {
  const collisions: CollidingRuleInfo[] = [];
  const normSurface = (newRule.surface || '').trim().toLowerCase();
  const normId = (newRule.id || '').trim().toLowerCase();

  for (const layer of candidateLayers) {
    const pb = layer.playbook;
    if (!pb) continue;

    const checkRule = (
      r: InvariantRule | AskRule | NeverRule,
      rType: 'invariant' | 'ask' | 'never'
    ) => {
      const rSurface = (r.surface || '').trim().toLowerCase();
      const rId = (r.id || '').trim().toLowerCase();

      // Conflicto 1: Mismo ID exacto
      if (rId && rId === normId) {
        collisions.push({
          scopeLabel: layer.scopeLabel,
          ruleType: rType,
          rule: r,
          reason: `ID idéntico (${r.id}) en ámbito ${layer.scopeLabel}`,
        });
        return;
      }

      // Conflicto 2: Misma superficie exacta o subsuperficie
      if (
        normSurface &&
        rSurface &&
        normSurface !== 'src/' &&
        rSurface !== 'src/' &&
        (normSurface === rSurface ||
          normSurface.startsWith(rSurface) ||
          rSurface.startsWith(normSurface))
      ) {
        collisions.push({
          scopeLabel: layer.scopeLabel,
          ruleType: rType,
          rule: r,
          reason: `Superficie superpuesta (${r.surface}) en ${layer.scopeLabel}`,
        });
      }
    };

    for (const inv of pb.invariants || []) checkRule(inv, 'invariant');
    for (const ask of pb.askRules || []) checkRule(ask, 'ask');
    for (const nev of pb.neverRules || []) checkRule(nev, 'never');
  }

  return collisions;
}

/**
 * Maneja el comando /playbook stack (list, create, delete o shorthand directo).
 */
export async function handleStackCommand(
  args: string,
  ctx: any,
  storage: PlaybookStorage,
  pi: any
): Promise<void> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const sub = parts[0];

  // 1. List
  if (sub === 'list') {
    const stacks = await storage.listStacks();
    if (stacks.length === 0) {
      ctx.ui?.notify('No hay stacks tecnológicos configurados. Podés crear uno con /playbook stack <prompt>.', 'info');
      return;
    }

    const entries: string[] = [];
    for (const slug of stacks) {
      const pb = await storage.getStack(slug);
      if (pb) {
        const flagStr = pb.requiredFlags && pb.requiredFlags.length > 0 ? pb.requiredFlags.join(', ') : 'sin banderas';
        const ruleCount = pb.invariants.length + pb.askRules.length + (pb.neverRules?.length || 0);
        entries.push(`- **${pb.stackName || slug}** (\`${slug}\`): [${flagStr}] — ${ruleCount} regla(s)`);
      }
    }

    pi.sendMessage({
      customType: 'gentle-playbook-stacks-list',
      content: `### 📦 Stacks Tecnológicos Instalados (${stacks.length})\n\n${entries.join('\n')}`,
      display: true,
    });
    return;
  }

  // 2. Delete
  if (sub === 'delete') {
    const targetSlug = parts[1];
    if (!targetSlug) {
      ctx.ui?.notify('Uso: /playbook stack delete <slug>', 'error');
      return;
    }

    const exists = await storage.hasStack(targetSlug);
    if (!exists) {
      ctx.ui?.notify(`El stack "${targetSlug}" no existe.`, 'error');
      return;
    }

    let confirmed = true;
    if (ctx.ui?.confirm) {
      confirmed = await ctx.ui.confirm(
        'Confirmar eliminación de Stack',
        `¿Eliminar permanentemente el stack "${targetSlug}" de ~/.config/gentle-playbook/stacks/?`
      );
    }
    if (confirmed) {
      await storage.deleteStack(targetSlug);
      ctx.ui?.notify(`✓ Stack "${targetSlug}" eliminado correctamente.`, 'info');
    }
    return;
  }

  // 3. Create (o prompt directo)
  let creationPrompt: string | undefined;
  if (sub === 'create') {
    creationPrompt = parts.slice(1).join(' ').trim();
  } else if (sub) {
    // Shorthand: /playbook stack "go gin con gorm" o /playbook stack nest con typeorm
    creationPrompt = args.trim();
  }

  // Si no se pasó argumento y hay UI interactiva, preguntar qué desea hacer
  if (!creationPrompt) {
    if (ctx.ui?.select) {
      const choice = await ctx.ui.select(
        'Gestión de Stacks Tecnológicos:',
        [
          '➕ Crear nuevo Stack Tecnológico',
          '📋 Listar Stacks Tecnológicos',
          '🗑️ Eliminar un Stack Tecnológico',
        ]
      );
      if (!choice) return;

      if (choice.includes('Listar')) {
        return handleStackCommand('list', ctx, storage, pi);
      }
      if (choice.includes('Eliminar')) {
        const stacks = await storage.listStacks();
        if (stacks.length === 0) {
          ctx.ui?.notify('No hay stacks para eliminar.', 'info');
          return;
        }
        const toDelete = await ctx.ui.select('Selecciona el stack a eliminar:', stacks);
        if (toDelete) {
          return handleStackCommand(`delete ${toDelete}`, ctx, storage, pi);
        }
        return;
      }
    }

    if (ctx.ui?.input) {
      creationPrompt = await ctx.ui.input(
        'Describe el Stack Tecnológico:',
        'Ej: go con gin y gorm, nest con typeorm y postgres, react con tailwind...'
      );
    }
  }

  if (!creationPrompt || !creationPrompt.trim()) {
    ctx.ui?.notify('Operación cancelada: No se ingresó descripción para el stack.', 'info');
    return;
  }

  ctx.ui?.notify(`Sintetizando stack para "${creationPrompt}"...`, 'info');

  let synth: SynthesizedStack;
  if (ctx.modelRegistry && ctx.model) {
    try {
      const prompt = buildStackSynthesisPrompt(creationPrompt);
      const completion = await ctx.modelRegistry.complete(ctx.model, {
        messages: [{ role: 'user', content: prompt }],
      });
      const rawText = completion?.content?.map((c: any) => c.text || '').join('') || '';
      synth = parseSynthesizedStack(rawText, creationPrompt);
    } catch {
      ctx.ui?.notify('⚠️ No se pudo contactar al modelo, usando analizador heurístico local.', 'warning');
      synth = heuristicFallbackStack(creationPrompt);
    }
  } else {
    synth = heuristicFallbackStack(creationPrompt);
  }

  const newStackPb: Playbook = {
    language: synth.slug,
    stackId: synth.slug,
    stackName: synth.name,
    requiredFlags: synth.requiredFlags,
    detection: synth.detection,
    scope: 'stack',
    version: 1,
    updatedAt: new Date().toISOString().split('T')[0],
    topology: {
      pattern: 'Standard Stack Layout',
      directories: ['src/'],
    },
    invariants: synth.initialInvariants || [],
    askRules: synth.initialAsks || [],
    neverRules: synth.initialNevers,
    snippets: [],
  };

  const preview =
    `**Slug:** \`${synth.slug}\`\n` +
    `**Nombre:** ${synth.name}\n` +
    `**Banderas requeridas:** [${synth.requiredFlags.join(', ')}]\n` +
    `**Descripción:** ${synth.description}\n` +
    (newStackPb.invariants.length > 0 ? `**Reglas sugeridas:** ${newStackPb.invariants.length} normativa(s)` : '');

  let confirmed = true;
  if (ctx.ui?.confirm) {
    confirmed = await ctx.ui.confirm(
      `¿Deseas registrar el Stack "${synth.name}"?`,
      preview
    );
  }

  if (!confirmed) {
    ctx.ui?.notify('Creación de stack cancelada.', 'info');
    return;
  }

  await storage.saveStack(newStackPb);
  ctx.ui?.notify(`✓ Stack "${synth.slug}" guardado con éxito en ~/.config/gentle-playbook/stacks/`, 'info');

  pi.sendMessage({
    customType: 'gentle-playbook-stack-created',
    content: `### 📦 Nuevo Stack Tecnológico Registrado\n\n${preview}`,
    display: true,
  });
}
