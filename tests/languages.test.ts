import { describe, it, expect } from 'vitest';
import {
  SUPPORTED_LANGUAGES,
  getLanguageMenuLabels,
  resolveLanguage,
} from '../src/core/languages.js';

describe('Supported Languages Catalog', () => {
  it('should list all supported language display names for UI menu', () => {
    const labels = getLanguageMenuLabels();
    expect(labels).toContain('Go (Golang)');
    expect(labels).toContain('TypeScript');
    expect(labels).toContain('Python');
    expect(labels.length).toBe(SUPPORTED_LANGUAGES.length);
  });

  it('should resolve IDs, labels, and aliases to canonical IDs', () => {
    // Exact ID
    expect(resolveLanguage('go')).toBe('go');
    expect(resolveLanguage('typescript')).toBe('typescript');

    // Display labels
    expect(resolveLanguage('Go (Golang)')).toBe('go');
    expect(resolveLanguage('TypeScript')).toBe('typescript');
    expect(resolveLanguage('C# (.NET)')).toBe('csharp');

    // Aliases
    expect(resolveLanguage('ts')).toBe('typescript');
    expect(resolveLanguage('tsx')).toBe('typescript');
    expect(resolveLanguage('golang')).toBe('go');
    expect(resolveLanguage('py')).toBe('python');
    expect(resolveLanguage('rs')).toBe('rust');
    expect(resolveLanguage('cs')).toBe('csharp');
    expect(resolveLanguage('c++')).toBe('cpp');
  });
});
