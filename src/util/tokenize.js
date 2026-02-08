const CHARS_PER_TOKEN = 4;
export function estimateTokens(text) {
    if (!text)
        return 0;
    return Math.ceil(text.length / CHARS_PER_TOKEN);
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