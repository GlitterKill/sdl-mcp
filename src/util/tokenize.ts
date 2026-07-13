const PROSE_CHARS_PER_TOKEN = 3.5;
const STRUCTURAL_TOKEN_CHARS = new Set(["{", "}", "[", "]", ":", ",", "\""]);

export function estimateTokens(text: string): number {
  if (!text) return 0;
  let structuralChars = 0;
  for (const char of text) {
    if (STRUCTURAL_TOKEN_CHARS.has(char)) {
      structuralChars++;
    }
  }

  const proseChars = Math.max(0, text.length - structuralChars);
  return Math.ceil(structuralChars + proseChars / PROSE_CHARS_PER_TOKEN);
}

/**
 * Coarse chars/4 estimate. Use ONLY where a fast upper-bound is needed and
 * the result is compared against other chars/4 estimates. For budget
 * enforcement against policy caps, use estimateTokens().
 */
export function estimateTokensCoarse(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Token estimate for SDL-MCP packed wire format. Empirical chars/token ratio
 * is ~3.2 (vs JSON's 3.5) because the packed format strips structural sigils
 * and interns redundant prefixes. Plain length / 3.2 over-estimates more
 * conservatively than estimateTokens, so policy caps remain safe.
 */
export function estimatePackedTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 3.2);
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
