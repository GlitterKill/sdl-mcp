export function computeCoverage({ changedFiles, retrievedSymbols, contextTargets }) {
  if (!contextTargets) return null;
  const targetFiles = [...new Set(contextTargets.files ?? [])];
  const targetSymbols = [...new Map((contextTargets.symbols ?? []).map((s) => [s.toLowerCase(), s])).values()];
  if (targetFiles.length === 0 && targetSymbols.length === 0) return null;

  const changed = new Set(changedFiles ?? []);
  const retrieved = new Set((retrievedSymbols ?? []).map((s) => s.toLowerCase()));
  const filesFound = targetFiles.filter((f) => changed.has(f));
  const symbolsFound = targetSymbols.filter((s) => retrieved.has(s.toLowerCase()));
  const editAvailable = Array.isArray(changedFiles) && targetFiles.length > 0;
  const retrievalAvailable = Array.isArray(retrievedSymbols) && targetSymbols.length > 0;
  const fileCoverage = editAvailable ? percent(filesFound.length, targetFiles.length) : null;
  const symbolCoverage = retrievalAvailable ? percent(symbolsFound.length, targetSymbols.length) : null;

  return {
    editCoverage: {
      available: editAvailable,
      recall: fileCoverage,
      precision: editAvailable ? percent(filesFound.length, changed.size) : null,
    },
    retrievalRelevance: {
      available: retrievalAvailable,
      recall: symbolCoverage,
      precision: retrievalAvailable ? percent(symbolsFound.length, retrieved.size) : null,
      scope: "observed-symbols-only",
    },
    // Legacy aliases retain their narrow meaning. Mixed edit/retrieval scores are invalid.
    fileCoverage,
    symbolCoverage,
    contextCoverage: null,
    precision: null,
    recall: null,
    filesFound,
    symbolsFound,
    targetFiles,
    targetSymbols,
  };
}

function percent(found, total) {
  return total > 0 ? Math.round((found / total) * 10000) / 100 : 0;
}
