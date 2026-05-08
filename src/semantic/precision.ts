import type {
  SemanticPrecisionInputs,
  SemanticPrecisionMetric,
  SemanticProviderType,
} from "./types.js";

const PROVIDER_TIER_WEIGHT: Record<SemanticProviderType, number> = {
  scip: 1,
  lsif: 0.9,
  lsp: 0.8,
};

function rate(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.max(0, Math.min(1, numerator / denominator));
}

export function computeSemanticPrecisionScore(
  inputs: SemanticPrecisionInputs,
): number {
  const coverage = rate(inputs.filesCovered, inputs.filesEligible);
  const symbolMatch = rate(inputs.symbolsMatched, inputs.symbolsTotal);
  const edgeResolution = rate(inputs.resolvedEdges, inputs.totalEdges);
  const pass2Skip = rate(inputs.pass2SkippedFiles, inputs.pass2EligibleFiles);
  const diagnostics = inputs.diagnosticsAvailable ? 1 : 0;
  const providerTier = PROVIDER_TIER_WEIGHT[inputs.providerType];

  const score =
    coverage * 0.25 +
    symbolMatch * 0.25 +
    edgeResolution * 0.25 +
    providerTier * 0.1 +
    diagnostics * 0.05 +
    pass2Skip * 0.1;

  return Math.round(score * 1000) / 1000;
}

export function buildSemanticPrecisionMetric(params: {
  id: string;
  repoId: string;
  runId: string;
  languageId: string;
  providerType: SemanticProviderType;
  providerId: string;
  inputs: SemanticPrecisionInputs;
  computedAt?: string;
}): SemanticPrecisionMetric {
  return {
    id: params.id,
    repoId: params.repoId,
    runId: params.runId,
    languageId: params.languageId,
    providerType: params.providerType,
    providerId: params.providerId,
    score: computeSemanticPrecisionScore(params.inputs),
    filesCovered: params.inputs.filesCovered,
    filesEligible: params.inputs.filesEligible,
    symbolMatchRate: rate(
      params.inputs.symbolsMatched,
      params.inputs.symbolsTotal,
    ),
    resolvedEdgeRate: rate(
      params.inputs.resolvedEdges,
      params.inputs.totalEdges,
    ),
    diagnosticsAvailable: params.inputs.diagnosticsAvailable,
    pass2SkipRate: rate(
      params.inputs.pass2SkippedFiles,
      params.inputs.pass2EligibleFiles,
    ),
    computedAt: params.computedAt ?? new Date().toISOString(),
  };
}
