import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { InvariantRule, AskRule, Snippet } from '../core/schema.js';
import { CodeGraphWrapper, CodeGraphNode } from './codegraph.js';

export interface AnalyzedRules {
  invariants: InvariantRule[];
  askRules: AskRule[];
  snippets: Snippet[];
}

export class CodePatternAnalyzer {
  private cg: CodeGraphWrapper;

  constructor(cg?: CodeGraphWrapper) {
    this.cg = cg || new CodeGraphWrapper();
  }

  async analyze(projectPath: string): Promise<AnalyzedRules> {
    const invariants: InvariantRule[] = [];
    const askRules: AskRule[] = [];
    const snippets: Snippet[] = [];

    // 1. Detect Null-Byte Sanitizer Middleware
    await this.detectSanitizer(projectPath, invariants, snippets);

    // 2. Detect Custom Validators (NotBlank, etc.)
    await this.detectValidators(projectPath, invariants, snippets);

    // 3. Detect API Response Envelope
    await this.detectResponseEnvelope(projectPath, invariants, snippets);

    // 4. Detect RBAC / Role Authorization (Conditional Pattern)
    await this.detectRBAC(projectPath, askRules, snippets);

    // 5. Detect Rate Limiting / Cache (Conditional Patterns)
    await this.detectRateLimiting(projectPath, askRules, snippets);

    return { invariants, askRules, snippets };
  }

  private async readSnippet(projectPath: string, filePath: string, startLine: number, endLine: number): Promise<string> {
    try {
      const fullPath = path.isAbsolute(filePath) ? filePath : path.join(projectPath, filePath);
      const content = await fs.readFile(fullPath, 'utf-8');
      const lines = content.split(/\r?\n/);
      const snippetLines = lines.slice(Math.max(0, startLine - 1), endLine);
      return snippetLines.join('\n');
    } catch {
      return '';
    }
  }

  private async detectSanitizer(projectPath: string, invariants: InvariantRule[], snippets: Snippet[]) {
    const results = await this.cg.query(projectPath, 'sanitizer');
    const sanitizerNode = results.find(
      (r) =>
        r.node.name.toLowerCase().includes('sanitize') ||
        r.node.filePath.toLowerCase().includes('sanitizer')
    )?.node;

    if (sanitizerNode) {
      const relDir = path.dirname(sanitizerNode.filePath) + '/';
      invariants.push({
        id: 'null-byte-sanitizer',
        type: 'invariant',
        title: 'Middleware de Sanitización de Bytes Nulos',
        surface: relDir,
        description:
          'Intercepta y rechaza peticiones HTTP con caracteres nulos (\\x00 o %00) en URI, Query params o Body JSON para evitar excepciones de encoding en PostgreSQL (SQLSTATE 22021).',
      });

      const code = await this.readSnippet(
        projectPath,
        sanitizerNode.filePath,
        sanitizerNode.startLine,
        Math.min(sanitizerNode.startLine + 35, sanitizerNode.endLine || sanitizerNode.startLine + 35)
      );

      if (code) {
        snippets.push({
          id: 'canonical-null-byte-sanitizer',
          title: 'Middleware Sanitizador de Bytes Nulos',
          language: 'go',
          code,
        });
      }
    }
  }

  private async detectValidators(projectPath: string, invariants: InvariantRule[], snippets: Snippet[]) {
    const results = await this.cg.query(projectPath, 'notblank');
    let validatorNode = results.find((r) => r.node.name.toLowerCase().includes('notblank'))?.node;

    if (!validatorNode) {
      // Try searching for custom validator registration
      const customResults = await this.cg.query(projectPath, 'RegisterCustomValidators');
      validatorNode = customResults[0]?.node;
    }

    if (validatorNode) {
      const relDir = path.dirname(validatorNode.filePath) + '/';
      invariants.push({
        id: 'dto-notblank-validation',
        type: 'invariant',
        title: 'Validación NotBlank en DTOs',
        surface: relDir,
        description:
          'Campos string obligatorios en DTOs deben validar que no contengan bytes nulos ni estén compuestos únicamente de espacios en blanco utilizando la regla custom `validate:"notblank"`.',
      });

      const code = await this.readSnippet(
        projectPath,
        validatorNode.filePath,
        validatorNode.startLine,
        validatorNode.endLine || validatorNode.startLine + 25
      );

      if (code) {
        snippets.push({
          id: 'canonical-notblank-validator',
          title: 'Validador Custom NotBlank',
          language: 'go',
          code,
        });
      }
    }
  }

  private async detectResponseEnvelope(projectPath: string, invariants: InvariantRule[], snippets: Snippet[]) {
    const results = await this.cg.query(projectPath, 'APIResponse');
    let respNode = results.find((r) => r.node.name.toLowerCase().includes('apiresponse'))?.node;

    if (!respNode) {
      const successResults = await this.cg.query(projectPath, 'Success');
      respNode = successResults.find((r) => r.node.filePath.includes('response'))?.node;
    }

    if (respNode) {
      const relDir = path.dirname(respNode.filePath) + '/';
      invariants.push({
        id: 'api-response-envelope',
        type: 'invariant',
        title: 'Envelope Universal de Respuesta HTTP',
        surface: relDir,
        description:
          'Todas las respuestas HTTP deben encapsularse en un formato unificado (Data, Error, Success). En producción, enmascarar errores 500 para evitar fuga de detalles sensibles.',
      });

      const code = await this.readSnippet(
        projectPath,
        respNode.filePath,
        respNode.startLine,
        respNode.endLine || respNode.startLine + 30
      );

      if (code) {
        snippets.push({
          id: 'canonical-response-helpers',
          title: 'Helpers de Respuesta Canónica (Success/Error)',
          language: 'go',
          code,
        });
      }
    }
  }

  private async detectRBAC(projectPath: string, askRules: AskRule[], snippets: Snippet[]) {
    const results = await this.cg.query(projectPath, 'RequireRoles');
    const rbacNode = results.find((r) => r.node.name.includes('RequireRoles') || r.node.name.includes('RequireAdminRoles'))?.node;

    if (rbacNode) {
      const callers = await this.cg.callers(projectPath, rbacNode.name);
      const callFiles = callers.map((c) => c.caller?.filePath || '').filter(Boolean);
      const hasSpecificCallers = callFiles.length > 0;

      const relDir = path.dirname(rbacNode.filePath) + '/';
      askRules.push({
        id: 'rbac-authorization',
        type: 'ask',
        title: 'Middleware de Autorización RBAC (Roles)',
        surface: relDir,
        trigger: 'Creación de endpoints protegidos que requieren privilegios de administración o roles específicos.',
        antiTrigger: 'Rutas públicas (/auth/login, /health) o endpoints accesibles a cualquier usuario autenticado sin distinción de rol.',
        prompt: 'Este endpoint requiere restricción de privilegios. ¿Le aplicamos el middleware de control de roles (RBAC) estándar?',
        defaultAction: 'Montar solo AuthMiddleware estándar sin restricción de roles específicos.',
        recipeSnippetId: 'canonical-rbac-middleware',
        description: 'Control de Acceso Basado en Roles (RBAC) fuertemente tipado para restringir endpoints sensibles.',
      });

      const code = await this.readSnippet(
        projectPath,
        rbacNode.filePath,
        rbacNode.startLine,
        rbacNode.endLine || rbacNode.startLine + 35
      );

      if (code) {
        snippets.push({
          id: 'canonical-rbac-middleware',
          title: 'Middleware RBAC Roles',
          language: 'go',
          code,
        });
      }
    }
  }

  private async detectRateLimiting(projectPath: string, askRules: AskRule[], snippets: Snippet[]) {
    const results = await this.cg.query(projectPath, 'ratelimit');
    const rateNode = results.find((r) => r.node.name.toLowerCase().includes('ratelimit'))?.node;

    if (rateNode) {
      const relDir = path.dirname(rateNode.filePath) + '/';
      askRules.push({
        id: 'rate-limiting',
        type: 'ask',
        title: 'Rate Limiter Middleware',
        surface: relDir,
        trigger: 'Creación de endpoints públicos con alta susceptibilidad a abuso (/login, /register, webhooks).',
        antiTrigger: 'Rutas internas autenticadas o llamadas gRPC privadas.',
        prompt: 'Detecto un endpoint público sensible. ¿Le aplicamos el middleware de Rate Limit estándar?',
        defaultAction: 'Sin limitación de tasa específica.',
        recipeSnippetId: 'canonical-rate-limiter',
        description: 'Limitación de tasa de peticiones para mitigar ataques de fuerza bruta y abusos.',
      });

      const code = await this.readSnippet(
        projectPath,
        rateNode.filePath,
        rateNode.startLine,
        rateNode.endLine || rateNode.startLine + 30
      );

      if (code) {
        snippets.push({
          id: 'canonical-rate-limiter',
          title: 'Middleware Rate Limiter',
          language: 'go',
          code,
        });
      }
    }
  }
}
