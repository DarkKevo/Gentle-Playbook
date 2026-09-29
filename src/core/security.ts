/**
 * gentle-playbook: Security & Prompt Injection Defense Module
 *
 * Implements structural data quoting boundaries, XML escaping,
 * and multi-language meta-instruction detection.
 */

import { INJECTION_PATTERNS as EXTENDED_INJECTION_PATTERNS, HIGH_SIGNAL_PHRASES } from './security.patterns.js';

export interface InjectionCheckResult {
  isSuspicious: boolean;
  reason?: string;
  matchedPattern?: string;
}

/**
 * Normalizes input text before inspection:
 * - Unicode NFKC normalization
 * - Strips invisible zero-width and bidi characters
 * - Basic homoglyph / leetspeak conversion
 * - Collapses repeated whitespace
 */
export function normalizeSecurityText(text: string): string {
  if (!text) return '';
  return text
    .normalize('NFKC')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g, '')
    .replace(/[\u{E0000}-\u{E007F}]/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Escapes raw strings for safe inclusion in XML elements and attributes.
 * Prevents prompt breakout via tag injection (e.g. </convention>, <script>, etc.)
 * and attribute breakout by converting double quotes to single quotes.
 */
export function escapeXml(unsafe: string): string {
  if (!unsafe) return '';
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, "'");
}

/**
 * Legacy core patterns for backward-compatible targeted matching.
 */
const CORE_INJECTION_PATTERNS: Array<{ regex: RegExp; label: string }> = [
  // 1. Universal LLM Chat / Role Delimiters (Turn Hijacking)
  { regex: /<\|(?:im_start|im_end|system|user|assistant|endoftext)\|>/i, label: 'ChatML special token' },
  { regex: /\[\/?(?:INST|SYS|SYSTEM|HUMAN|ASSISTANT)\]/i, label: 'System/User role delimiter tag' },
  { regex: /<<\/?SYS>>/i, label: 'Llama SYS delimiter' },

  // 2. Structural Tag Breakout attempts
  { regex: /<\/(?:convention|constraint|restricted|confirmation_checkpoint|checkpoint|prohibition|playbook|architectural_reference_context)>/i, label: 'Direct XML tag breakout' },
];

/**
 * Checks whether a given text input contains prompt injection patterns, meta-instructions,
 * canary tokens, exfiltration vectors, or jailbreak phrasing.
 */
export function detectPromptInjection(text: string): InjectionCheckResult {
  if (!text) return { isSuspicious: false };

  const normalized = normalizeSecurityText(text);

  // Fast-path: Check high-signal exact substring phrases
  for (const phrase of HIGH_SIGNAL_PHRASES) {
    if (normalized.includes(phrase)) {
      return {
        isSuspicious: true,
        reason: `High-signal injection phrase detected: "${phrase}"`,
        matchedPattern: phrase,
      };
    }
  }

  // Check Core Patterns on raw input (for tag breakouts and special tokens)
  for (const { regex, label } of CORE_INJECTION_PATTERNS) {
    if (regex.test(text)) {
      return {
        isSuspicious: true,
        reason: label,
        matchedPattern: label,
      };
    }
  }

  // Check Extended Injection Patterns catalog across all categories
  for (const [category, patterns] of Object.entries(EXTENDED_INJECTION_PATTERNS)) {
    for (const regex of patterns) {
      if (regex.test(text) || regex.test(normalized)) {
        return {
          isSuspicious: true,
          reason: `Catalog detection [${category}]: ${regex.source}`,
          matchedPattern: category,
        };
      }
    }
  }

  return { isSuspicious: false };
}

/**
 * Sanitizes rule text for prompt inclusion:
 * 1. Inspects for hostile meta-instructions / jailbreaks.
 * 2. If flagged, safely neutralizes the entire payload rather than leaving orphaned words (e.g. "PWNED").
 * 3. Applies strict XML escaping to guarantee tag isolation.
 */
export function sanitizeRuleText(text: string, maxLength = 500): string {
  if (!text) return '';

  const trimmed = text.slice(0, maxLength);

  // Check if text is an injection attempt
  const check = detectPromptInjection(trimmed);
  if (check.isSuspicious) {
    return '[neutralized] (suspicious prompt injection / meta-instruction blocked)';
  }

  // XML escape to eliminate tag breakout completely
  const escaped = escapeXml(trimmed);

  // Normalize excessive spaces and linebreaks
  return escaped.replace(/[\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

/**
 * Validates a rule's fields against prompt injection and hostile meta-instructions.
 * Returns { valid: true } or { valid: false, reason: string }.
 */
export function validateRuleContent(rule: {
  id?: string;
  title?: string;
  description?: string;
  surface?: string;
  trigger?: string;
  prompt?: string;
}): { valid: boolean; reason?: string } {
  const fieldsToCheck = [
    { name: 'id', val: rule.id },
    { name: 'title', val: rule.title },
    { name: 'description', val: rule.description },
    { name: 'surface', val: rule.surface },
    { name: 'trigger', val: rule.trigger },
    { name: 'prompt', val: rule.prompt },
  ];

  for (const { name, val } of fieldsToCheck) {
    if (val) {
      const check = detectPromptInjection(val);
      if (check.isSuspicious) {
        return {
          valid: false,
          reason: `Field '${name}' triggered security filter: ${check.reason}`,
        };
      }
    }
  }

  return { valid: true };
}

/**
 * Filters a Playbook object, discarding any rule that fails security validation.
 */
export function filterPlaybookRules(playbook: import('./schema.js').Playbook): {
  playbook: import('./schema.js').Playbook;
  discardedCount: number;
} {
  let discardedCount = 0;

  const validInvariants = playbook.invariants.filter((r) => {
    const res = validateRuleContent(r);
    if (!res.valid) {
      discardedCount++;
      return false;
    }
    return true;
  });

  const validAskRules = playbook.askRules.filter((r) => {
    const res = validateRuleContent(r);
    if (!res.valid) {
      discardedCount++;
      return false;
    }
    return true;
  });

  let validNeverRules = playbook.neverRules;
  if (playbook.neverRules) {
    validNeverRules = playbook.neverRules.filter((r) => {
      const res = validateRuleContent(r);
      if (!res.valid) {
        discardedCount++;
        return false;
      }
      return true;
    });
  }

  const cleaned: import('./schema.js').Playbook = {
    ...playbook,
    invariants: validInvariants,
    askRules: validAskRules,
    neverRules: validNeverRules && validNeverRules.length > 0 ? validNeverRules : undefined,
  };

  return { playbook: cleaned, discardedCount };
}

