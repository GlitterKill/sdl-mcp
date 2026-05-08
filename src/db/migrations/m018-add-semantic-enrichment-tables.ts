import type { Connection } from "kuzu";
import { execDdl } from "../ladybug-core.js";
import { IDEMPOTENT_DDL_ERROR_RE } from "../migration-runner.js";

export const version = 18;
export const description = "Add semantic enrichment provider run tables";

const TABLE_DDLS = [
  `CREATE NODE TABLE IF NOT EXISTS SemanticProviderRun (
    runId STRING PRIMARY KEY,
    repoId STRING,
    providerType STRING,
    providerId STRING,
    providerVersion STRING,
    languagesJson STRING DEFAULT '[]',
    sourceIndexPath STRING,
    sourceHash STRING,
    cacheKey STRING,
    configHash STRING,
    ledgerVersion STRING,
    status STRING,
    startedAt STRING,
    finishedAt STRING,
    documentsProcessed INT64 DEFAULT 0,
    symbolsMatched INT64 DEFAULT 0,
    edgesCreated INT64 DEFAULT 0,
    edgesUpgraded INT64 DEFAULT 0,
    edgesReplaced INT64 DEFAULT 0,
    edgesSkipped INT64 DEFAULT 0,
    diagnosticsCount INT64 DEFAULT 0,
    precisionScore DOUBLE DEFAULT 0.0,
    cacheHit BOOL DEFAULT false,
    canAffectPass2 BOOL DEFAULT false,
    selected BOOL DEFAULT true,
    metadataJson STRING DEFAULT '{}',
    error STRING
  )`,
  `CREATE NODE TABLE IF NOT EXISTS SemanticDiagnostic (
    id STRING PRIMARY KEY,
    repoId STRING,
    runId STRING,
    providerType STRING,
    providerId STRING,
    languageId STRING,
    sourcePath STRING,
    severity STRING,
    message STRING,
    code STRING,
    rangeJson STRING,
    createdAt STRING
  )`,
  `CREATE NODE TABLE IF NOT EXISTS SemanticPrecisionMetric (
    id STRING PRIMARY KEY,
    repoId STRING,
    runId STRING,
    languageId STRING,
    providerType STRING,
    providerId STRING,
    score DOUBLE DEFAULT 0.0,
    filesCovered INT64 DEFAULT 0,
    filesEligible INT64 DEFAULT 0,
    symbolMatchRate DOUBLE DEFAULT 0.0,
    resolvedEdgeRate DOUBLE DEFAULT 0.0,
    diagnosticsAvailable BOOL DEFAULT false,
    pass2SkipRate DOUBLE DEFAULT 0.0,
    computedAt STRING,
    metadataJson STRING DEFAULT '{}'
  )`,
];

const INDEX_DDLS = [
  `CREATE INDEX idx_semantic_run_repoId ON SemanticProviderRun(repoId)`,
  `CREATE INDEX idx_semantic_run_startedAt ON SemanticProviderRun(startedAt)`,
  `CREATE INDEX idx_semantic_diagnostic_repoId ON SemanticDiagnostic(repoId)`,
  `CREATE INDEX idx_semantic_diagnostic_runId ON SemanticDiagnostic(runId)`,
  `CREATE INDEX idx_semantic_diagnostic_sourcePath ON SemanticDiagnostic(sourcePath)`,
  `CREATE INDEX idx_semantic_metric_repoId ON SemanticPrecisionMetric(repoId)`,
  `CREATE INDEX idx_semantic_metric_runId ON SemanticPrecisionMetric(runId)`,
  `CREATE INDEX idx_semantic_metric_languageId ON SemanticPrecisionMetric(languageId)`,
];

export async function up(conn: Connection): Promise<void> {
  for (const ddl of TABLE_DDLS) {
    try {
      await execDdl(conn, ddl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (IDEMPOTENT_DDL_ERROR_RE.test(msg)) {
        continue;
      }
      throw err;
    }
  }

  for (const ddl of INDEX_DDLS) {
    try {
      await execDdl(conn, ddl);
    } catch {
      // Secondary indexes are performance-only and CREATE INDEX support varies
      // across LadybugDB versions. Fresh-schema creation uses the same policy.
    }
  }
}
