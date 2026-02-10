const PROSE_CHARS_PER_TOKEN = 3.5;
const STRUCTURAL_TOKEN_CHARS = new Set(["{", "}", "[", "]", ":", ",", "\""]);
export function estimateTokens(text) {
    if (!text)
        return 0;
    let structuralChars = 0;
    for (const char of text) {
        if (STRUCTURAL_TOKEN_CHARS.has(char)) {
            structuralChars++;
        }
    }
    const proseChars = Math.max(0, text.length - structuralChars);
    return Math.ceil(structuralChars + proseChars / PROSE_CHARS_PER_TOKEN);
}
export function calculateRemainingBudget(used, total) {
    return Math.max(0, total - used);
}
export function canFitTokens(tokens, budget) {
    return tokens <= budget;
}
export function tokenize(text) {
    if (!text)
        return [];
    return text
        .toLowerCase()
        .replace(/[^\w\s.-]/g, ' ')
        .split(/\s+/)
        .filter(token => token.length > 0);
}
//# sourceMappingURL=tokenize.js.map
