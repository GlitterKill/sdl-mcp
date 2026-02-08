const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function calculateRemainingBudget(used: number, total: number): number {
  return Math.max(0, total - used);
}

export function canFitTokens(tokens: number, budget: number): boolean {
  return tokens <= budget;
}

export function tokenize(text: string): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[^\w\s.-]/g, ' ')
    .split(/\s+/)
    .filter(token => token.length > 0);
}
