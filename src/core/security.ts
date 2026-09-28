/**
 * gentle-playbook: Security & Prompt Injection Defense Module
 *
 * Implements structural data quoting boundaries, XML escaping,
 * and multi-language meta-instruction detection.
 */

export interface InjectionCheckResult {
  isSuspicious: boolean;
  reason?: string;
  matchedPattern?: string;
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
 * Multi-language patterns for detecting prompt injection, persona hijacking,
 * and meta-instructions aimed at controlling LLM behavior rather than code style.
 * Uses unicode-safe boundaries instead of ASCII-only \b.
 */
const INJECTION_PATTERNS: Array<{ regex: RegExp; label: string }> = [
  // 1. Universal LLM Chat / Role Delimiters (Turn Hijacking)
  { regex: /<\|(?:im_start|im_end|system|user|assistant|endoftext)\|>/i, label: 'ChatML special token' },
  { regex: /\[\/?(?:INST|SYS|SYSTEM|HUMAN|ASSISTANT)\]/i, label: 'System/User role delimiter tag' },
  { regex: /<<\/?SYS>>/i, label: 'Llama SYS delimiter' },

  // 2. English: Instruction Disregard / System Overrides / Hijacks
  { regex: /(?:^|[\s.,;:!?])(?:ignore|disregard|forget|override)\s+(?:all\s+)?(?:previous|prior|system|above)\s+(?:instructions|prompts|directives|rules)/iu, label: 'Ignore instructions directive (EN)' },
  { regex: /(?:^|[\s.,;:!?])(?:new|system)\s+(?:system\s+)?prompt\s*:/iu, label: 'New system prompt declaration (EN)' },
  { regex: /(?:^|[\s.,;:!?])you\s+are\s+now\s+(?:a|an)\s+[a-z0-9_-]+/iu, label: 'Persona hijack: you are now (EN)' },
  { regex: /(?:^|[\s.,;:!?])act\s+as\s+(?:a|an)?\s*(?:unrestricted|jailbroken|evil|unfiltered|dan|hacker|root|admin)/iu, label: 'Adversarial persona adoption (EN)' },
  { regex: /(?:^|[\s.,;:!?])(?:always\s+)?(?:start|begin)\s+(?:all\s+)?(?:replies|responses)\s+with/iu, label: 'Reply prefix hijack (EN)' },
  { regex: /(?:^|[\s.,;:!?])always\s+reply\s+with/iu, label: 'Mandatory reply hijack (EN)' },
  { regex: /canary-gp-inject/iu, label: 'Known test canary token' },
  { regex: /(?:^|[\s.,;:!?])reveal\s+(?:your\s+)?(?:system\s+prompt|initial\s+instructions)/iu, label: 'Prompt extraction attack (EN)' },
  { regex: /(?:^|[\s.,;:!?])bypass\s+(?:system\s+)?(?:safety|guardrails|filters|permissions)/iu, label: 'Safety bypass directive (EN)' },

  // 3. Spanish: Instruction Disregard / System Overrides
  { regex: /(?:^|[\s.,;:!?])(?:olvid[aá]|ignor[aá]|desestim[aá]|omit[eé])\s+(?:todas?\s+)?(?:las?\s+)?instrucciones(?:\s+(?:anteriores|previas|de\s+sistema))?/iu, label: 'Ignore instructions directive (ES)' },
  { regex: /(?:^|[\s.,;:!?])olv[ií]date\s+de\s+todo/iu, label: 'Forget everything directive (ES)' },
  { regex: /(?:^|[\s.,;:!?])(?:nuevo\s+prompt\s+de\s+sistema|nuevas\s+instrucciones\s+de\s+sistema)/iu, label: 'New system prompt declaration (ES)' },
  { regex: /(?:^|[\s.,;:!?])(?:ahora\s+(?:sos|eres)|act[uú]a\s+como)\s+(?:un|una)?\s*(?:asistente\s+sin\s+l[ií]mites|hacker|root|admin|ia\s+desbloqueada)/iu, label: 'Persona hijack (ES)' },
  { regex: /(?:^|[\s.,;:!?])(?:siempre\s+)?(?:respond[eé]|empez[aá]|empiez[aá]|comienz[aá]|comenz[aá]|inici[aá])\s+(?:(?:(?:todas?\s+)?(?:tus\s+)?respuestas?\s+)?con)/iu, label: 'Reply prefix hijack (ES)' },

  // 4. Portuguese: Instruction Disregard
  { regex: /(?:^|[\s.,;:!?])(?:ignore|esque[cç]a|desconsidere)\s+(?:(?:todas\s+as|as)\s+)?instru[cç][oõ]es(?:\s+(?:anteriores|pr[eé]vias))?/iu, label: 'Ignore instructions directive (PT)' },
  { regex: /(?:^|[\s.,;:!?])(?:voc[eê]\s+agora\s+[eé]|atue\s+como)\s+(?:um|uma)?\s*(?:hacker|assistente\s+sem\s+limites)/iu, label: 'Persona hijack (PT)' },

  // 5. French: Instruction Disregard
  { regex: /(?:^|[\s.,;:!?])(?:ignore[rz]?|oubliez)\s+(?:(?:toutes\s+les|les)\s+)?instructions(?:\s+(?:pr[eé]c[eé]dentes|ant[eé]rieures))?/iu, label: 'Ignore instructions directive (FR)' },
  { regex: /(?:^|[\s.,;:!?])(?:tu\s+es\s+maintenant|agis\s+comme)\s+(?:un|une)?\s*(?:hacker|assistant\s+sans\s+limites)/iu, label: 'Persona hijack (FR)' },
  { regex: /(?:^|[\s.,;:!?])nouveau\s+prompt\s+syst[eè]me/iu, label: 'New system prompt declaration (FR)' },

  // 6. German: Instruction Disregard
  { regex: /(?:^|[\s.,;:!?])(?:ignoriere|vergiss)\s+(?:alle\s+)?(?:vorherigen|bisherigen)\s+anweisungen/iu, label: 'Ignore instructions directive (DE)' },
  { regex: /(?:^|[\s.,;:!?])du\s+bist\s+jetzt\s+(?:ein|eine)?\s*(?:hacker|jailbroken\s+assistent)/iu, label: 'Persona hijack (DE)' },
  { regex: /(?:^|[\s.,;:!?])handle\s+als\s+(?:ein|eine)?\s*(?:hacker|jailbroken\s+assistent)/iu, label: 'Persona hijack: handle als (DE)' },

  // 7. Structural Tag Breakout attempts
  { regex: /<\/(?:convention|constraint|restricted|confirmation_checkpoint|checkpoint|prohibition|playbook|architectural_reference_context)>/i, label: 'Direct XML tag breakout' },
];

/**
 * Checks whether a given text input contains prompt injection patterns or meta-instructions.
 */
export function detectPromptInjection(text: string): InjectionCheckResult {
  if (!text) return { isSuspicious: false };

  for (const { regex, label } of INJECTION_PATTERNS) {
    if (regex.test(text)) {
      return {
        isSuspicious: true,
        reason: label,
        matchedPattern: label,
      };
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
