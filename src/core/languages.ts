export interface SupportedLanguage {
  id: string;
  name: string;
  aliases: string[];
}

export const SUPPORTED_LANGUAGES: readonly SupportedLanguage[] = [
  { id: 'go', name: 'Go (Golang)', aliases: ['go', 'golang'] },
  { id: 'typescript', name: 'TypeScript', aliases: ['typescript', 'ts', 'tsx'] },
  { id: 'javascript', name: 'JavaScript', aliases: ['javascript', 'js', 'jsx', 'node'] },
  { id: 'python', name: 'Python', aliases: ['python', 'py'] },
  { id: 'rust', name: 'Rust', aliases: ['rust', 'rs'] },
  { id: 'csharp', name: 'C# (.NET)', aliases: ['csharp', 'cs', 'c#', 'dotnet'] },
  { id: 'java', name: 'Java', aliases: ['java'] },
  { id: 'kotlin', name: 'Kotlin', aliases: ['kotlin', 'kt'] },
  { id: 'php', name: 'PHP', aliases: ['php'] },
  { id: 'ruby', name: 'Ruby', aliases: ['ruby', 'rb'] },
  { id: 'cpp', name: 'C / C++', aliases: ['cpp', 'c++', 'c'] },
  { id: 'swift', name: 'Swift', aliases: ['swift'] },
  { id: 'dart', name: 'Dart / Flutter', aliases: ['dart', 'flutter'] },
  { id: 'elixir', name: 'Elixir', aliases: ['elixir', 'ex', 'exs'] },
  { id: 'solidity', name: 'Solidity', aliases: ['solidity', 'sol'] },
] as const;

export function getLanguageMenuLabels(): string[] {
  return SUPPORTED_LANGUAGES.map((l) => l.name);
}

export function resolveLanguage(input: string): string {
  if (!input) return 'generic';
  const trimmed = input.trim().toLowerCase();

  // 1. Direct match with id
  const directId = SUPPORTED_LANGUAGES.find((l) => l.id === trimmed);
  if (directId) return directId.id;

  // 2. Direct match with display name (case-insensitive)
  const directName = SUPPORTED_LANGUAGES.find((l) => l.name.toLowerCase() === trimmed);
  if (directName) return directName.id;

  // 3. Match with aliases
  const byAlias = SUPPORTED_LANGUAGES.find((l) => l.aliases.includes(trimmed));
  if (byAlias) return byAlias.id;

  // 4. Substring / partial matching
  const partial = SUPPORTED_LANGUAGES.find(
    (l) => l.name.toLowerCase().includes(trimmed) || trimmed.includes(l.id)
  );
  if (partial) return partial.id;

  // Fallback to sanitized input
  return trimmed.replace(/[^a-z0-9_-]/g, '');
}
