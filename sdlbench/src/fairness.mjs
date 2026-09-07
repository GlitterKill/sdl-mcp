export function auditFairness({
  baselinePromptTokens,
  sdlPromptTokens,
  sdlInjectedFiles = [],
  baselineInjectedFiles = [],
  sdlTokenizer,
  baselineTokenizer,
  sdlToolBudget,
  baselineToolBudget,
}) {
  const sdlInjectionTokens = countInjection(sdlInjectedFiles, sdlTokenizer);
  const baselineInjectionTokens = countInjection(baselineInjectedFiles, baselineTokenizer);
  const tokensAvailable = [baselinePromptTokens, sdlPromptTokens, sdlInjectionTokens, baselineInjectionTokens].every(knownCount);
  const budgetsAvailable = [sdlToolBudget, baselineToolBudget].every(knownCount);
  const baselineTotal = tokensAvailable ? baselinePromptTokens + baselineInjectionTokens : null;
  const promptTokenImbalance = tokensAvailable
    ? sdlPromptTokens + sdlInjectionTokens - baselineTotal
    : null;
  const toolBudgetImbalance = budgetsAvailable ? sdlToolBudget - baselineToolBudget : null;
  const available = tokensAvailable && budgetsAvailable;

  return {
    available,
    // Product-specific injection can cost more in an otherwise fair experiment.
    passed: available && baselinePromptTokens === sdlPromptTokens && toolBudgetImbalance === 0,
    promptTokenImbalance,
    toolBudgetImbalance,
    netSavings: tokensAvailable ? -promptTokenImbalance : null,
    netSavingsPct: baselineTotal > 0 ? Math.round((-promptTokenImbalance / baselineTotal) * 10000) / 100 : null,
    recommendedDeduction: sdlInjectionTokens,
    sdlInjectionTokens,
    baselineInjectionTokens,
    sdlInjectedFiles: sdlInjectedFiles.map((f) => f.path ?? f.name ?? "unknown"),
  };
}

function knownCount(value) {
  return Number.isFinite(value) && value >= 0;
}

function countInjection(files, tokenizer) {
  if (files.length === 0) return 0;
  if (typeof tokenizer !== "function") return null;
  const counts = files.map((file) => tokenizer(file));
  return counts.every(knownCount) ? counts.reduce((sum, count) => sum + count, 0) : null;
}
