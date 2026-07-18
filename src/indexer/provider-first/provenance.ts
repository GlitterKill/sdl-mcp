import type { Connection } from "kuzu";

import {
  mergeSemanticDiagnostics,
  mergeSemanticProviderRun,
  type SemanticProviderRunRecord,
} from "../../db/ladybug-semantic.js";
import type { SemanticDiagnostic } from "../../semantic/types.js";
import { hashValue } from "../../util/hashing.js";
import { normalizePath } from "../../util/paths.js";
import type {
  CallProofUnavailableReasonCode,
  CoverageFact,
  DiagnosticFact,
  ProviderFactSet,
  ProviderRunFact,
} from "./types.js";

const COVERAGE_SAMPLE_LIMIT = 25;
const REASON_SAMPLE_LIMIT = 10;

export interface ProviderFirstSemanticProvenanceRecords {
  providerRuns: SemanticProviderRunRecord[];
  diagnostics: SemanticDiagnostic[];
}

export async function persistProviderFirstProvenance(
  conn: Connection,
  facts: ProviderFactSet,
): Promise<ProviderFirstSemanticProvenanceRecords> {
  const records = providerFactsToSemanticProvenanceRecords(facts);
  for (const run of records.providerRuns) {
    await mergeSemanticProviderRun(conn, run);
  }
  await mergeSemanticDiagnostics(conn, records.diagnostics);
  return records;
}

export function providerFactsToSemanticProvenanceRecords(
  facts: ProviderFactSet,
): ProviderFirstSemanticProvenanceRecords {
  const coverageDiagnostics = coverageFactsToDiagnostics(facts);
  const directDiagnostics = facts.diagnostics.map((diagnostic) =>
    diagnosticFactToSemanticDiagnostic(diagnostic, facts),
  );
  const diagnostics = [...directDiagnostics, ...coverageDiagnostics];
  const diagnosticsByRun = countDiagnosticsByRun(diagnostics);
  const diagnosticSeveritiesByRun = summarizeDiagnosticSeveritiesByRun(diagnostics);

  return {
    providerRuns: facts.providerRuns.map((run) =>
      providerRunFactToSemanticProviderRun(
        run,
        facts,
        diagnosticsByRun,
        diagnosticSeveritiesByRun,
      ),
    ),
    diagnostics,
  };
}

function providerRunFactToSemanticProviderRun(
  run: ProviderRunFact,
  facts: ProviderFactSet,
  diagnosticsByRun: ReadonlyMap<string, number>,
  diagnosticSeveritiesByRun: ReadonlyMap<
    string,
    Record<SemanticDiagnostic["severity"], number>
  >,
): SemanticProviderRunRecord {
  return {
    runId: run.runId,
    repoId: run.repoId,
    providerType: run.providerType,
    providerId: run.providerId,
    providerVersion: run.providerVersion,
    languages: providerRunLanguages(run, facts),
    sourceIndexPath: run.sourceIndexPath
      ? normalizePath(run.sourceIndexPath)
      : undefined,
    status: semanticRunStatus(run.status),
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    documentsProcessed: run.fileCount,
    symbolsMatched: run.symbolCount,
    edgesCreated: run.edgeCount,
    edgesUpgraded: 0,
    edgesReplaced: 0,
    edgesSkipped: 0,
    diagnosticsCount: diagnosticsByRun.get(run.runId) ?? run.diagnosticCount,
    cacheHit: false,
    canAffectPass2: run.status === "succeeded",
    selected: true,
    metadataJson: JSON.stringify({
      schemaVersion: 1,
      coverage: summarizeCoverageForProvider(run, facts.coverage),
      diagnosticsBySeverity: diagnosticSeveritiesByRun.get(run.runId) ?? {
        error: 0,
        warning: 0,
        information: 0,
        hint: 0,
      },
    }),
    error: run.errorMessage,
  };
}

function providerRunLanguages(
  run: ProviderRunFact,
  facts: ProviderFactSet,
): string[] {
  const languages = new Set<string>();
  for (const file of facts.files) {
    if (file.providerId !== run.providerId) continue;
    if (file.languageId) languages.add(file.languageId);
  }
  return [...languages].sort((left, right) => left.localeCompare(right));
}

function semanticRunStatus(
  status: ProviderRunFact["status"],
): SemanticProviderRunRecord["status"] {
  switch (status) {
    case "succeeded":
      return "completed";
    default:
      return status;
  }
}

function diagnosticFactToSemanticDiagnostic(
  diagnostic: DiagnosticFact,
  facts: ProviderFactSet,
): SemanticDiagnostic {
  return {
    id: diagnostic.diagnosticId,
    repoId: diagnostic.repoId,
    runId: `${diagnostic.generationId}:${diagnostic.providerId}`,
    providerType: diagnostic.providerType,
    providerId: diagnostic.providerId,
    languageId: languageForPath(
      facts,
      diagnostic.relPath,
      diagnostic.providerId,
    ),
    sourcePath: normalizePath(diagnostic.relPath),
    severity: diagnostic.severity,
    message: diagnostic.message,
    code: diagnostic.code,
    range: diagnostic.range,
  };
}

function coverageFactsToDiagnostics(
  facts: ProviderFactSet,
): SemanticDiagnostic[] {
  const diagnostics: SemanticDiagnostic[] = [];
  for (const coverage of facts.coverage) {
    diagnostics.push(...coverageFactToDiagnostics(coverage, facts));
  }
  for (const run of facts.providerRuns) {
    if (run.status !== "failed" || !run.errorMessage) continue;
    diagnostics.push({
      id: hashValue({
        type: "providerFirst.runFailed",
        runId: run.runId,
        providerId: run.providerId,
        message: run.errorMessage,
      }),
      repoId: run.repoId,
      runId: run.runId,
      providerType: run.providerType,
      providerId: run.providerId,
      languageId: "unknown",
      sourcePath: normalizePath(run.sourceIndexPath ?? "."),
      severity: "error",
      code: "providerFirst.runFailed",
      message: run.errorMessage,
    });
  }
  return diagnostics;
}

function coverageFactToDiagnostics(
  coverage: CoverageFact,
  facts: ProviderFactSet,
): SemanticDiagnostic[] {
  const diagnostics: SemanticDiagnostic[] = [];
  const base = {
    repoId: coverage.repoId,
    runId: `${coverage.generationId}:${coverage.providerId}`,
    providerType: coverage.providerType,
    providerId: coverage.providerId,
    languageId: languageForPath(facts, coverage.relPath, coverage.providerId),
    sourcePath: normalizePath(coverage.relPath),
  } satisfies Pick<
    SemanticDiagnostic,
    | "repoId"
    | "runId"
    | "providerType"
    | "providerId"
    | "languageId"
    | "sourcePath"
  >;

  if (coverage.symbolCoverage !== "full") {
    diagnostics.push(
      coverageDiagnostic(base, coverage, "providerFirst.coverage.symbol", {
        severity:
          coverage.symbolCoverage === "none" ? "warning" : "information",
        message: `Provider emitted ${coverage.emittedSymbols}/${coverage.totalSymbols} local symbols`,
      }),
    );
  }
  if (coverage.referenceCoverage !== "full") {
    diagnostics.push(
      coverageDiagnostic(base, coverage, "providerFirst.coverage.reference", {
        severity: "information",
        message: `Provider left ${coverage.unresolvedOccurrences}/${coverage.totalOccurrences} occurrence(s) unresolved`,
      }),
    );
  }
  if (coverage.callProofCoverage !== "full") {
    diagnostics.push(
      coverageDiagnostic(base, coverage, "providerFirst.coverage.callProof", {
        severity: "warning",
        message: `Provider call proof unavailable for ${coverage.callProofUnavailableReferences}/${coverage.totalResolvedReferences} resolved reference(s)`,
      }),
    );
  }
  if (coverage.legacyFallback !== "skip") {
    diagnostics.push(
      coverageDiagnostic(
        base,
        coverage,
        "providerFirst.coverage.legacyFallback",
        {
          severity: "warning",
          message: `Provider coverage requires ${coverage.legacyFallback} legacy fallback`,
        },
      ),
    );
  }

  for (const reason of coverage.callProofUnavailableReasons ?? []) {
    diagnostics.push(
      coverageDiagnostic(
        base,
        coverage,
        `providerFirst.callProof.${reason.code}`,
        {
          severity: "warning",
          message: `Provider call proof unavailable for ${reason.references} reference(s): ${reason.code}`,
        },
      ),
    );
  }

  return diagnostics;
}

function coverageDiagnostic(
  base: Pick<
    SemanticDiagnostic,
    | "repoId"
    | "runId"
    | "providerType"
    | "providerId"
    | "languageId"
    | "sourcePath"
  >,
  coverage: CoverageFact,
  code: string,
  params: Pick<SemanticDiagnostic, "severity" | "message">,
): SemanticDiagnostic {
  return {
    id: hashValue({
      code,
      runId: base.runId,
      providerId: base.providerId,
      relPath: coverage.relPath,
    }),
    ...base,
    code,
    severity: params.severity,
    message: params.message,
  };
}

function languageForPath(
  facts: ProviderFactSet,
  relPath: string,
  providerId: string,
): string {
  const normalized = normalizePath(relPath);
  return (
    facts.files.find(
      (file) =>
        file.providerId === providerId &&
        normalizePath(file.relPath) === normalized,
    )?.languageId ?? "unknown"
  );
}

function countDiagnosticsByRun(
  diagnostics: readonly SemanticDiagnostic[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const diagnostic of diagnostics) {
    counts.set(diagnostic.runId, (counts.get(diagnostic.runId) ?? 0) + 1);
  }
  return counts;
}

function summarizeDiagnosticSeveritiesByRun(
  diagnostics: readonly SemanticDiagnostic[],
): Map<string, Record<SemanticDiagnostic["severity"], number>> {
  const summaries = new Map<
    string,
    Record<SemanticDiagnostic["severity"], number>
  >();
  for (const diagnostic of diagnostics) {
    const summary = summaries.get(diagnostic.runId) ?? {
      error: 0,
      warning: 0,
      information: 0,
      hint: 0,
    };
    summary[diagnostic.severity] += 1;
    summaries.set(diagnostic.runId, summary);
  }
  return summaries;
}

function summarizeCoverageForProvider(
  run: ProviderRunFact,
  coverageFacts: readonly CoverageFact[],
): Record<string, unknown> {
  const coverage = coverageFacts.filter(
    (fact) => fact.providerId === run.providerId,
  );
  const legacyFallback = { skip: 0, targeted: 0, full: 0 };
  const symbolCoverage = { none: 0, partial: 0, full: 0 };
  const referenceCoverage = { none: 0, partial: 0, full: 0 };
  const callProofCoverage = { none: 0, partial: 0, full: 0 };
  const callProofUnavailableReasons = new Map<
    CallProofUnavailableReasonCode,
    number
  >();
  let callProofUnavailableReferences = 0;

  for (const fact of coverage) {
    legacyFallback[fact.legacyFallback]++;
    symbolCoverage[fact.symbolCoverage]++;
    referenceCoverage[fact.referenceCoverage]++;
    callProofCoverage[fact.callProofCoverage]++;
    callProofUnavailableReferences += fact.callProofUnavailableReferences;
    for (const reason of fact.callProofUnavailableReasons ?? []) {
      callProofUnavailableReasons.set(
        reason.code,
        (callProofUnavailableReasons.get(reason.code) ?? 0) + reason.references,
      );
    }
  }

  return {
    files: coverage.length,
    legacyFallback,
    symbolCoverage,
    referenceCoverage,
    callProofCoverage,
    callProofUnavailableReferences,
    callProofUnavailableReasons: [...callProofUnavailableReasons.entries()]
      .sort(
        (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
      )
      .slice(0, REASON_SAMPLE_LIMIT)
      .map(([code, references]) => ({ code, references })),
    samples: coverage
      .filter(
        (fact) =>
          fact.legacyFallback !== "skip" ||
          fact.symbolCoverage !== "full" ||
          fact.referenceCoverage !== "full" ||
          fact.callProofCoverage !== "full",
      )
      .slice(0, COVERAGE_SAMPLE_LIMIT)
      .map((fact) => ({
        relPath: normalizePath(fact.relPath),
        legacyFallback: fact.legacyFallback,
        symbolCoverage: fact.symbolCoverage,
        referenceCoverage: fact.referenceCoverage,
        callProofCoverage: fact.callProofCoverage,
        callProofUnavailableReferences: fact.callProofUnavailableReferences,
      })),
  };
}
