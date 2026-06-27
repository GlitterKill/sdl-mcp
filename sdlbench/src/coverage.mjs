export function computeCoverage({ changedFiles, retrievedSymbols, contextTargets }) {
  if (!contextTargets) return null;

  const targetFiles = contextTargets.files ?? [];
  const targetSymbols = contextTargets.symbols ?? [];
  if (targetFiles.length === 0 && targetSymbols.length === 0) return null;

  const changed = new Set(changedFiles ?? []);
  const retrieved = new Set((retrievedSymbols ?? []).map((s) => s.toLowerCase()));

  const filesFound = targetFiles.filter((f) => changed.has(f));
  const symbolsFound = targetSymbols.filter((s) => retrieved.has(s.toLowerCase()));

  const fileCoverage = targetFiles.length > 0
    ? Math.round((filesFound.length / targetFiles.length) * 10000) / 100
    : 0;
  const symbolCoverage = targetSymbols.length > 0
    ? Math.round((symbolsFound.length / targetSymbols.length) * 10000) / 100
    : 0;

  const totalTargets = targetFiles.length + targetSymbols.length;
  const totalFound = filesFound.length + symbolsFound.length;
  const contextCoverage = totalTargets > 0
    ? Math.round((totalFound / totalTargets) * 10000) / 100
    : 0;

  const retrievedCount = (retrievedSymbols ?? []).length;
  const changedCount = (changedFiles ?? []).length;
  const totalReturned = retrievedCount + changedCount;
  const precision = totalReturned > 0
    ? Math.round((totalFound / totalReturned) * 10000) / 100
    : 0;
  const recall = totalTargets > 0
    ? Math.round((totalFound / totalTargets) * 10000) / 100
    : 0;

  return {
    fileCoverage,
    symbolCoverage,
    contextCoverage,
    precision,
    recall,
    filesFound,
    symbolsFound,
    targetFiles,
    targetSymbols,
  };
}
