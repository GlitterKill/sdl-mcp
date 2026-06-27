export function auditFairness({
  baselinePromptTokens,
  sdlPromptTokens,
  sdlInjectedFiles = [],
  baselineInjectedFiles = [],
  sdlTokenizer,
  baselineTokenizer,
}) {
  const sdlInjectionTokens = sdlInjectedFiles.reduce((sum, file) => {
    const est = sdlTokenizer?.(file) ?? estimateTokens(file.content ?? "");
    return sum + est;
  }, 0);

  const baselineInjectionTokens = baselineInjectedFiles.reduce((sum, file) => {
    const est = baselineTokenizer?.(file) ?? estimateTokens(file.content ?? "");
    return sum + est;
  }, 0);

  const promptTokenImbalance = (sdlPromptTokens + sdlInjectionTokens) - (baselinePromptTokens + baselineInjectionTokens);
  const toolBudgetImbalance = sdlInjectionTokens;

  const netSavings = (baselinePromptTokens + baselineInjectionTokens) - (sdlPromptTokens + sdlInjectionTokens);
  const netSavingsPct = baselinePromptTokens + baselineInjectionTokens > 0
    ? Math.round((netSavings / (baselinePromptTokens + baselineInjectionTokens)) * 10000) / 100
    : 0;

  const recommendedDeduction = Math.max(0, sdlInjectionTokens);

  return {
    promptTokenImbalance,
    toolBudgetImbalance,
    netSavings,
    netSavingsPct,
    recommendedDeduction,
    sdlInjectionTokens,
    baselineInjectionTokens,
    sdlInjectedFiles: sdlInjectedFiles.map((f) => f.path ?? f.name ?? "unknown"),
  };
}

function estimateTokens(text) {
  return Math.ceil(String(text).length / 4);
}
