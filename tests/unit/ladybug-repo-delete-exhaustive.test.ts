import assert from "node:assert";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import type { Connection } from "kuzu";

const DB_PATH = join(tmpdir(), `sdl-repo-delete-exhaustive-${process.pid}.lbug`);

describe("deleteRepo exhaustive current-schema cleanup", () => {
  let db: import("kuzu").Database;
  let conn: Connection;
  let queries: typeof import("../../dist/db/ladybug-queries.js");

  async function exec(statement: string): Promise<void> {
    const result = await conn.query(statement);
    result.close();
  }

  async function count(statement: string): Promise<number> {
    const result = await conn.query(statement);
    try {
      const row = await result.getNext();
      return Number(row.c ?? 0);
    } finally {
      result.close();
    }
  }

  async function seedRepo(repoId: string): Promise<void> {
    const id = repoId.replaceAll("-", "_");
    await queries.upsertRepo(conn, {
      repoId,
      rootPath: `C:/tmp/${repoId}`,
      configJson: "{}",
      createdAt: "2026-07-17T00:00:00.000Z",
    });
    const statements = [
      `CREATE (:File {fileId: 'file_${id}', relPath: 'src/${id}.ts'})`,
      `CREATE (:Symbol {symbolId: 'symbol_${id}', repoId: '${repoId}'})`,
      `CREATE (:Symbol {symbolId: 'placeholder_${id}', repoId: '${repoId}', external: true, symbolStatus: 'placeholder'})`,
      `CREATE (:Version {versionId: 'version_${id}'})`,
      `CREATE (:SymbolVersion {id: 'symbol_version_${id}', versionId: 'version_${id}', symbolId: 'symbol_${id}'})`,
      `CREATE (:SymbolVersion {id: 'placeholder_version_${id}', versionId: 'orphan_placeholder_version_${id}', symbolId: 'placeholder_${id}'})`,
      `CREATE (:Metrics {symbolId: 'symbol_${id}'})`,
      `CREATE (:Metrics {symbolId: 'placeholder_${id}'})`,
      `CREATE (:MetricsFingerprint {repoId: '${repoId}'})`,
      `CREATE (:ShadowCluster {shadowClusterId: 'shadow_${id}', repoId: '${repoId}'})`,
      `CREATE (:Cluster {clusterId: 'cluster_${id}', repoId: '${repoId}'})`,
      `CREATE (:FileSummary {fileId: 'file_${id}', repoId: '${repoId}'})`,
      `CREATE (:Process {processId: 'process_${id}', repoId: '${repoId}'})`,
      `CREATE (:SliceHandle {handle: 'slice_${id}', repoId: '${repoId}'})`,
      `CREATE (:Audit {eventId: 'audit_${id}', repoId: '${repoId}'})`,
      `CREATE (:AgentFeedback {feedbackId: 'feedback_${id}', repoId: '${repoId}'})`,
      `CREATE (:SymbolEmbedding {symbolId: 'symbol_${id}'})`,
      `CREATE (:SymbolEmbedding {symbolId: 'placeholder_${id}'})`,
      `CREATE (:SummaryCache {symbolId: 'symbol_${id}'})`,
      `CREATE (:SummaryCache {symbolId: 'placeholder_${id}'})`,
      `CREATE (:SyncArtifact {artifactId: 'sync_${id}', repoId: '${repoId}'})`,
      `CREATE (:SymbolReference {refId: 'reference_${id}', repoId: '${repoId}', fileId: 'file_${id}'})`,
      `CREATE (:Memory {memoryId: 'memory_${id}', repoId: '${repoId}'})`,
      `CREATE (:UsageSnapshot {snapshotId: 'usage_${id}', repoId: '${repoId}'})`,
      `CREATE (:PrefetchOutcome {outcomeId: 'outcome_${id}', repoId: '${repoId}'})`,
      `CREATE (:PrefetchPolicyAggregate {aggregateKey: 'aggregate_${id}', repoId: '${repoId}'})`,
      `CREATE (:ScipIngestion {id: 'scip_${id}', repoId: '${repoId}'})`,
      `CREATE (:SemanticProviderRun {runId: 'semantic_run_${id}', repoId: '${repoId}'})`,
      `CREATE (:SemanticDiagnostic {id: 'semantic_diagnostic_${id}', repoId: '${repoId}'})`,
      `CREATE (:SemanticPrecisionMetric {id: 'semantic_metric_${id}', repoId: '${repoId}'})`,
      `CREATE (:DerivedState {repoId: '${repoId}'})`,
      `MATCH (f:File {fileId: 'file_${id}'}), (r:Repo {repoId: '${repoId}'}) CREATE (f)-[:FILE_IN_REPO]->(r)`,
      `MATCH (s:Symbol {symbolId: 'symbol_${id}'}), (f:File {fileId: 'file_${id}'}) CREATE (s)-[:SYMBOL_IN_FILE]->(f)`,
      `MATCH (s:Symbol), (r:Repo {repoId: '${repoId}'}) WHERE s.symbolId IN ['symbol_${id}', 'placeholder_${id}'] CREATE (s)-[:SYMBOL_IN_REPO]->(r)`,
      `MATCH (s:Symbol {symbolId: 'symbol_${id}'}), (p:Symbol {symbolId: 'placeholder_${id}'}) CREATE (s)-[:DEPENDS_ON]->(p)`,
      `MATCH (v:Version {versionId: 'version_${id}'}), (r:Repo {repoId: '${repoId}'}) CREATE (v)-[:VERSION_OF_REPO]->(r)`,
      `MATCH (s:Symbol {symbolId: 'symbol_${id}'}), (c:Cluster {clusterId: 'cluster_${id}'}) CREATE (s)-[:BELONGS_TO_CLUSTER]->(c)`,
      `MATCH (s:Symbol {symbolId: 'placeholder_${id}'}), (c:ShadowCluster {shadowClusterId: 'shadow_${id}'}) CREATE (s)-[:BELONGS_TO_SHADOW_CLUSTER]->(c)`,
      `MATCH (c:ShadowCluster {shadowClusterId: 'shadow_${id}'}), (r:Repo {repoId: '${repoId}'}) CREATE (c)-[:SHADOW_CLUSTER_IN_REPO]->(r)`,
      `MATCH (s:Symbol {symbolId: 'symbol_${id}'}), (p:Process {processId: 'process_${id}'}) CREATE (s)-[:PARTICIPATES_IN]->(p)`,
      `MATCH (c:Cluster {clusterId: 'cluster_${id}'}), (r:Repo {repoId: '${repoId}'}) CREATE (c)-[:CLUSTER_IN_REPO]->(r)`,
      `MATCH (p:Process {processId: 'process_${id}'}), (r:Repo {repoId: '${repoId}'}) CREATE (p)-[:PROCESS_IN_REPO]->(r)`,
      `MATCH (r:Repo {repoId: '${repoId}'}), (m:Memory {memoryId: 'memory_${id}'}) CREATE (r)-[:HAS_MEMORY]->(m)`,
      `MATCH (m:Memory {memoryId: 'memory_${id}'}), (s:Symbol {symbolId: 'symbol_${id}'}) CREATE (m)-[:MEMORY_OF]->(s)`,
      `MATCH (m:Memory {memoryId: 'memory_${id}'}), (f:File {fileId: 'file_${id}'}) CREATE (m)-[:MEMORY_OF_FILE]->(f)`,
      `MATCH (s:FileSummary {fileId: 'file_${id}'}), (r:Repo {repoId: '${repoId}'}) CREATE (s)-[:FILE_SUMMARY_IN_REPO]->(r)`,
      `MATCH (s:FileSummary {fileId: 'file_${id}'}), (f:File {fileId: 'file_${id}'}) CREATE (s)-[:SUMMARY_OF_FILE]->(f)`,
    ];
    for (const statement of statements) await exec(statement);
  }

  before(async () => {
    rmSync(DB_PATH, { recursive: true, force: true });
    const kuzu = await import("kuzu");
    db = new kuzu.Database(DB_PATH);
    conn = new kuzu.Connection(db);
    const { createSchema } = await import("../../dist/db/ladybug-schema.js");
    await createSchema(conn);
    queries = await import("../../dist/db/ladybug-queries.js");
    await exec("CREATE (:CardHash {cardHash: 'global_card'})");
    await exec("CREATE (:ToolPolicyHash {policyHash: 'global_policy'})");
    await exec("CREATE (:TsconfigHash {tsconfigHash: 'global_tsconfig'})");
    await seedRepo("remove-repo");
    await seedRepo("keep-repo");
    for (const statement of [
      "CREATE (:Symbol {symbolId: 'shared_placeholder', repoId: 'remove-repo', external: true, symbolStatus: 'placeholder'})",
      "CREATE (:SymbolVersion {id: 'shared_placeholder_version', versionId: 'shared_orphan_version', symbolId: 'shared_placeholder'})",
      "CREATE (:Metrics {symbolId: 'shared_placeholder'})",
      "CREATE (:SymbolEmbedding {symbolId: 'shared_placeholder'})",
      "CREATE (:SummaryCache {symbolId: 'shared_placeholder'})",
      "MATCH (s:Symbol {symbolId: 'shared_placeholder'}), (r:Repo) WHERE r.repoId IN ['remove-repo', 'keep-repo'] CREATE (s)-[:SYMBOL_IN_REPO]->(r)",
      "MATCH (s:Symbol {symbolId: 'symbol_keep_repo'}), (p:Symbol {symbolId: 'shared_placeholder'}) CREATE (s)-[:DEPENDS_ON]->(p)",
    ]) {
      await exec(statement);
    }
  });

  after(async () => {
    await conn.close();
    await db.close();
    if (existsSync(DB_PATH)) rmSync(DB_PATH, { recursive: true, force: true });
  });

  it("deletes all owned nodes and relations while preserving global and unrelated state", async () => {
    await queries.deleteRepo(conn, "remove-repo");

    assert.strictEqual(await queries.getRepo(conn, "remove-repo"), null);
    assert.ok(await queries.getRepo(conn, "keep-repo"));

    const repoScopedTables = [
      "Symbol",
      "MetricsFingerprint",
      "ShadowCluster",
      "Cluster",
      "FileSummary",
      "Process",
      "SliceHandle",
      "Audit",
      "AgentFeedback",
      "SyncArtifact",
      "SymbolReference",
      "Memory",
      "UsageSnapshot",
      "PrefetchOutcome",
      "PrefetchPolicyAggregate",
      "ScipIngestion",
      "SemanticProviderRun",
      "SemanticDiagnostic",
      "SemanticPrecisionMetric",
      "DerivedState",
    ];
    for (const table of repoScopedTables) {
      assert.strictEqual(
        await count(`MATCH (n:${table} {repoId: 'remove-repo'}) RETURN count(n) AS c`),
        0,
        `${table} target rows remain`,
      );
      assert.ok(
        (await count(`MATCH (n:${table} {repoId: 'keep-repo'}) RETURN count(n) AS c`)) > 0,
        `${table} control rows were removed`,
      );
    }

    for (const [table, key, target, keeper] of [
      ["File", "fileId", "file_remove_repo", "file_keep_repo"],
      ["Version", "versionId", "version_remove_repo", "version_keep_repo"],
      ["SymbolVersion", "id", "symbol_version_remove_repo", "symbol_version_keep_repo"],
      ["Metrics", "symbolId", "symbol_remove_repo", "symbol_keep_repo"],
      ["SymbolEmbedding", "symbolId", "symbol_remove_repo", "symbol_keep_repo"],
      ["SummaryCache", "symbolId", "symbol_remove_repo", "symbol_keep_repo"],
      ["SymbolVersion", "id", "placeholder_version_remove_repo", "placeholder_version_keep_repo"],
      ["Metrics", "symbolId", "placeholder_remove_repo", "placeholder_keep_repo"],
      ["SymbolEmbedding", "symbolId", "placeholder_remove_repo", "placeholder_keep_repo"],
      ["SummaryCache", "symbolId", "placeholder_remove_repo", "placeholder_keep_repo"],
    ]) {
      assert.strictEqual(await count(`MATCH (n:${table} {${key}: '${target}'}) RETURN count(n) AS c`), 0);
      assert.strictEqual(await count(`MATCH (n:${table} {${key}: '${keeper}'}) RETURN count(n) AS c`), 1);
    }

    const relationCounts: Record<string, number> = {
      FILE_IN_REPO: 1,
      SYMBOL_IN_FILE: 1,
      SYMBOL_IN_REPO: 3,
      DEPENDS_ON: 2,
      VERSION_OF_REPO: 1,
      BELONGS_TO_CLUSTER: 1,
      BELONGS_TO_SHADOW_CLUSTER: 1,
      SHADOW_CLUSTER_IN_REPO: 1,
      PARTICIPATES_IN: 1,
      CLUSTER_IN_REPO: 1,
      PROCESS_IN_REPO: 1,
      HAS_MEMORY: 1,
      MEMORY_OF: 1,
      MEMORY_OF_FILE: 1,
      FILE_SUMMARY_IN_REPO: 1,
      SUMMARY_OF_FILE: 1,
    };
    for (const [relation, expected] of Object.entries(relationCounts)) {
      assert.strictEqual(
        await count(`MATCH ()-[r:${relation}]->() RETURN count(r) AS c`),
        expected,
        `${relation} was not isolated to the control repository`,
      );
    }

    assert.strictEqual(await count("MATCH (n:CardHash) RETURN count(n) AS c"), 1);
    assert.strictEqual(await count("MATCH (n:ToolPolicyHash) RETURN count(n) AS c"), 1);
    assert.strictEqual(await count("MATCH (n:TsconfigHash) RETURN count(n) AS c"), 1);
    assert.strictEqual(
      await count(
        "MATCH (s:Symbol {symbolId: 'shared_placeholder', repoId: 'keep-repo'}) RETURN count(s) AS c",
      ),
      1,
    );
    for (const table of ["SymbolVersion", "Metrics", "SymbolEmbedding", "SummaryCache"]) {
      assert.strictEqual(
        await count(
          `MATCH (n:${table}) WHERE n.symbolId = 'shared_placeholder' RETURN count(n) AS c`,
        ),
        1,
        `${table} for the shared placeholder was removed`,
      );
    }

    await conn.close();
    await db.close();
    const kuzu = await import("kuzu");
    db = new kuzu.Database(DB_PATH);
    conn = new kuzu.Connection(db);
    assert.strictEqual(await queries.getRepo(conn, "remove-repo"), null);
    assert.ok(await queries.getRepo(conn, "keep-repo"));
    assert.strictEqual(
      await count(
        "MATCH (s:Symbol {symbolId: 'shared_placeholder', repoId: 'keep-repo'})-[:SYMBOL_IN_REPO]->(:Repo {repoId: 'keep-repo'}) RETURN count(s) AS c",
      ),
      1,
    );
  });
});
