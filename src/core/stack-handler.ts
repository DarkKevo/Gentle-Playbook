import { PlaybookStorage } from './storage.js';
import { Playbook, InvariantRule, AskRule, NeverRule } from './schema.js';
import {
  buildStackSynthesisPrompt,
  parseSynthesizedStack,
  heuristicFallbackStack,
  SynthesizedStack,
} from './stack-synthesizer.js';
import { formatPlaybookForDisplay } from './parser.js';
import { detectActiveStacks } from './stack-detector.js';
import { detectProjectLanguage } from '../extract/extractor.js';
import { upsertRuleInPlaybook } from './extract-triage.js';

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

/**
 * Detecta y resuelve proactivamente contradicciones o colisiones entre stacks activos,
 * aterrizando la decisión del usuario en el playbook.md local como autoridad suprema.
 */
export async function checkAndResolveMultiStackConflicts(
  cwd: string,
  activeStacks: Playbook[],
  storage: PlaybookStorage,
  ctx: any,
  pi: any
): Promise<void> {
  if (activeStacks.length < 2) return;

  const localPb = await storage.getLocalProjectPlaybook(cwd);

  for (let i = 0; i < activeStacks.length; i++) {
    for (let j = i + 1; j < activeStacks.length; j++) {
      const sA = activeStacks[i];
      const sB = activeStacks[j];

      const allRulesA = [
        ...(sA.invariants || []),
        ...(sA.askRules || []),
        ...(sA.neverRules || []),
      ];

      for (const rA of allRulesA) {
        if (!rA.surface || rA.surface === 'src/' || rA.surface === 'general') continue;

        // Si el playbook local ya tiene una regla que gobierna esta superficie, ya está zanjado
        if (localPb) {
          const localHasSurface = [
            ...(localPb.invariants || []),
            ...(localPb.askRules || []),
            ...(localPb.neverRules || []),
          ].some(
            (lr) =>
              lr.surface &&
              (lr.surface === rA.surface ||
                lr.surface.startsWith(rA.surface) ||
                rA.surface.startsWith(lr.surface))
          );
          if (localHasSurface) continue;
        }

        // Buscar colisión en sB
        const collisions = findCollidingRules(rA, [
          { scopeLabel: sB.stackName || sB.stackId || 'Stack B', playbook: sB },
        ]);

        if (collisions.length > 0) {
          const col = collisions[0];
          const rB = col.rule;

          const conflictCard =
            `⚠️ Conflicto detectado entre Stack [${sA.stackId}] y Stack [${sB.stackId}] en superficie \`${rA.surface}\`:\n\n` +
            `[STACK: ${sA.stackId}] ${rA.title}\n` +
            `- Tipo: ${rA.type.toUpperCase()}\n` +
            `- Regla: ${rA.description}\n\n` +
            `VS\n\n` +
            `[STACK: ${sB.stackId}] ${rB.title}\n` +
            `- Tipo: ${rB.type.toUpperCase()}\n` +
            `- Regla: ${rB.description}\n\n` +
            `*La opción que elijas se aterrizará como autoridad en el playbook.md local del repositorio.*`;

          pi?.sendMessage?.({
            customType: 'gentle-playbook-stack-conflict',
            content: `### ⚔️ Conflicto entre Stacks Activos\n\n${conflictCard}`,
            display: true,
          });

          if (ctx.ui?.select) {
            const choice = await ctx.ui.select(
              `Conflicto en superficie \`${rA.surface}\`: ¿Cuál regla deseas aterrizar en playbook.md?`,
              [
                `1. Adoptar regla de [${sA.stackId}]`,
                `2. Adoptar regla de [${sB.stackId}]`,
                `3. Redactar una regla personalizada para este proyecto`,
              ]
            );

            if (!choice) continue;

            let targetLocal = await storage.getLocalProjectPlaybook(cwd);
            if (!targetLocal) {
              targetLocal = {
                language: 'project',
                scope: 'project',
                version: 1,
                updatedAt: new Date().toISOString().split('T')[0],
                topology: { pattern: 'Project Custom Layout', directories: ['src/'] },
                invariants: [],
                askRules: [],
                snippets: [],
              };
            }

            if (choice.includes(`[${sA.stackId}]`)) {
              upsertRuleInPlaybook(targetLocal, rA);
            } else if (choice.includes(`[${sB.stackId}]`)) {
              upsertRuleInPlaybook(targetLocal, rB);
            } else if (choice.includes('Redactar') && ctx.ui?.input) {
              const customDesc = await ctx.ui.input(
                `Escribe la norma arquitectónica local para \`${rA.surface}\`:`,
                rA.description
              );
              if (customDesc) {
                upsertRuleInPlaybook(targetLocal, {
                  id: `local-${rA.id}`,
                  type: rA.type,
                  title: `Norma local para ${rA.surface}`,
                  surface: rA.surface,
                  description: customDesc.trim(),
                } as any);
              }
            }

            targetLocal.version += 1;
            targetLocal.updatedAt = new Date().toISOString().split('T')[0];
            await storage.saveLocalProjectPlaybook(targetLocal, cwd);
            ctx.ui?.notify(
              `✓ Conflicto resuelto y persistido en playbook.md local del proyecto.`,
              'info'
            );
          }
        }
      }
    }
  }
}

/**
 * Reúne todos los playbooks aplicables a un workspace respetando el orden jerárquico de autoridad:
 * 1. LOCAL (playbook.md en raíz)
 * 2. STACK (todos los stacks activos por sus banderas requeridas)
 * 3. GLOBAL (lenguaje base detectado y otros lenguajes en monorepos)
 * 4. AGENTE (preferencias de supervisión y gobernanza)
 */
export async function getActiveWorkspacePlaybooks(
  cwd: string,
  storage: PlaybookStorage
): Promise<Playbook[]> {
  const list: Playbook[] = [];

  // 1. LOCAL (máxima autoridad)
  const localPb = await storage.getLocalProjectPlaybook(cwd);
  if (localPb) {
    list.push(localPb);
  }

  // 2. STACK
  const allStackSlugs = await storage.listStacks();
  const allStackPbs: Playbook[] = [];
  for (const slug of allStackSlugs) {
    const s = await storage.getStack(slug);
    if (s) allStackPbs.push(s);
  }
  const activeStacks = await detectActiveStacks(cwd, allStackPbs);
  for (const s of activeStacks) {
    list.push(s);
  }

  // 3. GLOBAL
  const detectedLang = await detectProjectLanguage(cwd);
  if (detectedLang && detectedLang !== 'generic') {
    const globPb = await storage.getPlaybook(detectedLang);
    if (globPb) list.push(globPb);
  }

  // Soporte monorepo para otros lenguajes instalados
  if (typeof (storage as any).listLanguages === 'function') {
    const allLangs = await (storage as any).listLanguages();
    for (const lang of allLangs) {
      if (lang !== 'agents-preferences' && lang !== detectedLang) {
        const extraPb = await storage.getPlaybook(lang);
        if (extraPb && !list.some((p) => p.language === extraPb.language)) {
          list.push(extraPb);
        }
      }
    }
  }

  // 4. AGENTE
  const agentPrefs = await storage.getAgentPreferences();
  if (agentPrefs) {
    list.push(agentPrefs);
  }

  return list;
}

/**
 * Filtra y enmascara reglas en playbooks subordinados (Stack, Global) si una regla
 * en una capa superior (Local Project playbook.md) ya gobierna o establece una norma
 * para esa misma superficie o ruta.
 */
export function maskSubordinatePlaybooks(playbooks: Playbook[]): Playbook[] {
  if (playbooks.length <= 1) return playbooks;

  // Coleccionar superficies gobernadas por capas superiores en orden
  const governedSurfaces: string[] = [];
  const result: Playbook[] = [];

  for (const pb of playbooks) {
    // Las preferencias de agente nunca se enmascaran por reglas de código
    if (pb.language === 'agents-preferences' || pb.scope === 'agents') {
      result.push(pb);
      continue;
    }

    const isLocalProject = pb.scope === 'project' || pb.language === 'project';

    if (isLocalProject) {
      // Registrar todas las superficies de la capa local suprema
      for (const r of [...pb.invariants, ...pb.askRules, ...(pb.neverRules || [])]) {
        if (r.surface && r.surface !== 'src/' && r.surface !== 'general') {
          governedSurfaces.push(r.surface.trim().toLowerCase());
        }
      }
      result.push(pb);
      continue;
    }

    // Para capas subordinadas (Stack, Global), filtrar reglas que colisionen con superficies ya gobernadas
    const isSurfaceMasked = (surface?: string) => {
      if (!surface || surface === 'src/' || surface === 'general') return false;
      const norm = surface.trim().toLowerCase();
      return governedSurfaces.some(
        (gov) => gov === norm || norm.startsWith(gov) || gov.startsWith(norm)
      );
    };

    const filteredInvariants = pb.invariants.filter((r) => !isSurfaceMasked(r.surface));
    const filteredAsks = pb.askRules.filter((r) => !isSurfaceMasked(r.surface));
    const filteredNevers = pb.neverRules ? pb.neverRules.filter((r) => !isSurfaceMasked(r.surface)) : undefined;

    // Registrar superficies de este stack para enmascarar capas aún más bajas (Global)
    for (const r of [...filteredInvariants, ...filteredAsks, ...(filteredNevers || [])]) {
      if (r.surface && r.surface !== 'src/' && r.surface !== 'general') {
        governedSurfaces.push(r.surface.trim().toLowerCase());
      }
    }

    result.push({
      ...pb,
      invariants: filteredInvariants,
      askRules: filteredAsks,
      neverRules: filteredNevers && filteredNevers.length > 0 ? filteredNevers : undefined,
    });
  }

  return result;
}
