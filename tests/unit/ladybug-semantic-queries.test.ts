import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "node:os";
import { dirname, join } from "path";

const TEST_DB_PATH = join(
  tmpdir(),
  `.lbug-semantic-queries-${Date.now()}-${Math.random().toString(16).slice(2)}.lbug`,
);

interface LadybugConnection {
  close: () => Promise<void>;
}

interface LadybugDatabase {
  close: () => Promise<void>;
}

async function createTestDb(): Promise<{
  db: LadybugDatabase;
  conn: import("kuzu").Connection;
}> {
  cleanupDbFiles(TEST_DB_PATH);
  mkdirSync(dirname(TEST_DB_PATH), { recursive: true });

  const kuzu = await import("kuzu");
  const db = new kuzu.Database(TEST_DB_PATH);
  const conn = new kuzu.Connection(db);

  return { db, conn };
}

async function cleanupTestDb(
  db: LadybugDatabase,
  conn: LadybugConnection,
): Promise<void> {
  try {
    await conn.close();
  } catch {}
  try {
    await db.close();
  } catch {}
  try {
    cleanupDbFiles(TEST_DB_PATH);
  } catch {}
}

function cleanupDbFiles(dbPath: string): void {
  for (const path of [dbPath, `${dbPath}.wal`, `${dbPath}.lock`, `${dbPath}.shm`]) {
    if (existsSync(path)) {
      rmSync(path, { recursive: true, force: true });
    }
  }
}

describe("LadybugDB semantic enrichment queries", () => {
  let db: LadybugDatabase;
  let conn: import("kuzu").Connection;
  let queries: typeof import("../../dist/db/ladybug-queries.js");
  let ladybugAvailable = true;

  beforeEach(async () => {
    try {
      ({ db, conn } = await createTestDb());
      const { createSchema } = await import("../../dist/db/ladybug-schema.js");
      await createSchema(conn);
      queries = await import("../../dist/db/ladybug-queries.js");
    } catch {
      ladybugAvailable = false;
    }
  });

  afterEach(async () => {
    if (!ladybugAvailable) return;
    await cleanupTestDb(db, conn);
  });

  it(
    "upserts provider runs, diagnostics, and precision metrics",
    { skip: !ladybugAvailable },
    async () => {
      await queries.mergeSemanticProviderRun(conn, {
        runId: "run-1",
        repoId: "repo-1",
        providerType: "scip",
        providerId: "scip-typescript",
        providerVersion: "1.0.0",
        languages: ["typescript"],
        sourceIndexPath: "index.scip",
        sourceHash: "hash-1",
        cacheKey: "cache-1",
        configHash: "config-1",
        ledgerVersion: "v1",
        status: "completed",
        startedAt: "2026-05-07T00:00:00.000Z",
        finishedAt: "2026-05-07T00:00:01.000Z",
        documentsProcessed: 1,
        symbolsMatched: 2,
        edgesCreated: 3,
        edgesUpgraded: 4,
        edgesReplaced: 0,
        edgesSkipped: 1,
        diagnosticsCount: 1,
        precisionScore: 0.95,
        cacheHit: false,
        canAffectPass2: true,
        selected: true,
        metadataJson: '{"tier":"scip"}',
      });

      const runs = await queries.getLatestSemanticProviderRuns(conn, "repo-1");
      assert.strictEqual(runs.length, 1);
      assert.deepStrictEqual(runs[0].languages, ["typescript"]);
      assert.strictEqual(runs[0].cacheKey, "cache-1");
      assert.strictEqual(runs[0].canAffectPass2, true);
      assert.strictEqual(runs[0].metadataJson, '{"tier":"scip"}');

      await queries.mergeSemanticDiagnostics(conn, [
        {
          id: "diag-1",
          repoId: "repo-1",
          runId: "run-1",
          providerType: "scip",
          providerId: "scip-typescript",
          languageId: "typescript",
          sourcePath: "src/example.ts",
          severity: "warning",
          message: "demo",
          range: { startLine: 1, startCol: 2, endLine: 1, endCol: 8 },
        },
      ]);

      await queries.mergeSemanticPrecisionMetric(conn, {
        id: "metric-1",
        repoId: "repo-1",
        runId: "run-1",
        languageId: "typescript",
        providerType: "scip",
        providerId: "scip-typescript",
        score: 0.95,
        filesCovered: 1,
        filesEligible: 1,
        symbolMatchRate: 1,
        resolvedEdgeRate: 1,
        diagnosticsAvailable: true,
        pass2SkipRate: 1,
        computedAt: "2026-05-07T00:00:02.000Z",
        metadataJson: '{"inputs":"fixture"}',
      });

      const rows = await queries.queryAll<{
        diagnosticCount: unknown;
        metricCount: unknown;
        metadataJson: string;
      }>(
        conn,
        `MATCH (d:SemanticDiagnostic)
         MATCH (m:SemanticPrecisionMetric {id: 'metric-1'})
         RETURN count(d) AS diagnosticCount,
                count(m) AS metricCount,
                m.metadataJson AS metadataJson`,
        {},
      );
      assert.strictEqual(Number(rows[0].diagnosticCount), 1);
      assert.strictEqual(Number(rows[0].metricCount), 1);
      assert.strictEqual(rows[0].metadataJson, '{"inputs":"fixture"}');
    },
  );

  it(
    "writes semantic DEPENDS_ON provenance without returning unrelated edges",
    { skip: !ladybugAvailable },
    async () => {
      for (const symbolId of ["source", "target", "other"]) {
        await queries.exec(conn, `CREATE (:Symbol {symbolId: $symbolId})`, {
          symbolId,
        });
      }

      await queries.batchMergeSemanticEdges(conn, [
        {
          sourceSymbolId: "source",
          targetSymbolId: "target",
          edgeType: "call",
          confidence: 0.8,
          resolution: "exact",
          resolverId: "scip:typescript",
          resolutionPhase: "semantic-enrichment",
          provenance: '{"runId":"run-1","capability":"definition"}',
        },
        {
          sourceSymbolId: "source",
          targetSymbolId: "other",
          edgeType: "call",
          confidence: 0.7,
          resolution: "heuristic",
          resolverId: "scip:typescript",
          resolutionPhase: "semantic-enrichment",
          provenance: '{"runId":"run-1","capability":"reference"}',
        },
      ]);

      const existing = await queries.batchGetSemanticEdges(conn, [
        { sourceId: "source", targetId: "target", edgeType: "call" },
      ]);
      assert.deepStrictEqual(
        [...existing.values()].map((edge) => edge.targetSymbolId),
        ["target"],
      );

      await queries.batchMergeSemanticEdges(conn, [
        {
          sourceSymbolId: "source",
          targetSymbolId: "target",
          edgeType: "call",
          confidence: 0.8,
          resolution: "heuristic",
          resolverId: "lsp:tsserver",
          resolutionPhase: "semantic-enrichment",
          provenance: '{"runId":"run-2","capability":"definition"}',
        },
      ]);

      const rows = await queries.queryAll<{
        confidence: unknown;
        resolution: string;
        resolverId: string;
        provenance: string;
      }>(
        conn,
        `MATCH (:Symbol {symbolId: 'source'})-[d:DEPENDS_ON {edgeType: 'call'}]->(:Symbol {symbolId: 'target'})
         RETURN d.confidence AS confidence,
                d.resolution AS resolution,
                d.resolverId AS resolverId,
                d.provenance AS provenance`,
        {},
      );

      assert.strictEqual(Number(rows[0].confidence), 0.8);
      assert.strictEqual(rows[0].resolution, "exact");
      assert.strictEqual(rows[0].resolverId, "scip:typescript");
      assert.strictEqual(
        rows[0].provenance,
        '{"runId":"run-1","capability":"definition"}',
      );
    },
  );

  it(
    "replaces only the intended unresolved target for each semantic edge",
    { skip: !ladybugAvailable },
    async () => {
      const writer = await import("../../dist/semantic/writer.js");
      await queries.exec(
        conn,
        `CREATE (:Repo {repoId: 'repo-1', rootPath: '.', configJson: '{}', createdAt: 'now'})`,
        {},
      );
      await queries.exec(
        conn,
        `CREATE (:File {fileId: 'file-1', relPath: 'src/example.ts', contentHash: 'hash', language: 'typescript', byteSize: 100, lastIndexedAt: 'now', directory: 'src'})`,
        {},
      );
      for (const symbolId of [
        "source",
        "actualA",
        "actualB",
        "unresolved:call:firstMissing",
        "unresolved:call:secondMissing",
      ]) {
        await queries.exec(
          conn,
          `CREATE (:Symbol {symbolId: $symbolId, repoId: 'repo-1', kind: 'function', name: $symbolId, exported: true, language: 'typescript', rangeStartLine: 1, rangeEndLine: 3})`,
          { symbolId },
        );
        await queries.exec(
          conn,
          `MATCH (s:Symbol {symbolId: $symbolId}), (r:Repo {repoId: 'repo-1'}), (f:File {fileId: 'file-1'})
           CREATE (s)-[:SYMBOL_IN_REPO]->(r), (s)-[:SYMBOL_IN_FILE]->(f)`,
          { symbolId },
        );
      }
      for (const targetId of [
        "unresolved:call:firstMissing",
        "unresolved:call:secondMissing",
      ]) {
        await queries.exec(
          conn,
          `MATCH (source:Symbol {symbolId: 'source'}), (target:Symbol {symbolId: $targetId})
           CREATE (source)-[:DEPENDS_ON {edgeType: 'call', confidence: 0.5, resolution: 'unresolved', resolverId: 'pass1-generic', resolutionPhase: 'pass1'}]->(target)`,
          { targetId },
        );
      }

      const result = await writer.writeSemanticIndex(conn, {
        repoId: "repo-1",
        runId: "run-lsp",
        providerType: "lsp",
        providerId: "mock-lsp",
        generatedAt: "2026-05-07T00:00:00.000Z",
        documents: [
          {
            languageId: "typescript",
            sourcePath: "src/example.ts",
            occurrences: [],
            diagnostics: [],
          },
        ],
        symbols: [],
        edges: [
          {
            sourceSymbolId: "source",
            targetSymbolId: "actualA",
            replaceTargetSymbolId: "unresolved:call:firstMissing",
            edgeType: "call",
            confidence: 0.95,
            resolution: "exact",
            resolverId: "lsp:mock-lsp",
            resolutionPhase: "semantic-enrichment:lsp",
            capability: "definition",
            provenance: {
              providerType: "lsp",
              providerId: "mock-lsp",
              capability: "definition",
              confidence: 0.95,
              runId: "run-lsp",
              resolutionPhase: "semantic-enrichment:lsp",
            },
          },
          {
            sourceSymbolId: "source",
            targetSymbolId: "actualB",
            replaceTargetSymbolId: "unresolved:call:secondMissing",
            edgeType: "call",
            confidence: 0.95,
            resolution: "exact",
            resolverId: "lsp:mock-lsp",
            resolutionPhase: "semantic-enrichment:lsp",
            capability: "definition",
            provenance: {
              providerType: "lsp",
              providerId: "mock-lsp",
              capability: "definition",
              confidence: 0.95,
              runId: "run-lsp",
              resolutionPhase: "semantic-enrichment:lsp",
            },
          },
        ],
        diagnostics: [],
      });

      assert.strictEqual(result.edgesReplaced, 2);
      const rows = await queries.queryAll<{ target: string; resolution: string }>(
        conn,
        `MATCH (:Symbol {symbolId: 'source'})-[d:DEPENDS_ON {edgeType: 'call'}]->(target:Symbol)
         RETURN target.symbolId AS target, d.resolution AS resolution
         ORDER BY target.symbolId`,
        {},
      );
      assert.deepStrictEqual(rows, [
        { target: "actualA", resolution: "exact" },
        { target: "actualB", resolution: "exact" },
      ]);
    },
  );

  it(
    "does not replace unresolved targets without an explicit replacement target",
    { skip: !ladybugAvailable },
    async () => {
      const writer = await import("../../dist/semantic/writer.js");
      await queries.exec(
        conn,
        `CREATE (:Repo {repoId: 'repo-1', rootPath: '.', configJson: '{}', createdAt: 'now'})`,
        {},
      );
      await queries.exec(
        conn,
        `CREATE (:File {fileId: 'file-1', relPath: 'src/example.ts', contentHash: 'hash', language: 'typescript', byteSize: 100, lastIndexedAt: 'now', directory: 'src'})`,
        {},
      );
      for (const symbolId of [
        "source",
        "actualA",
        "unresolved:call:firstMissing",
        "unresolved:call:secondMissing",
      ]) {
        await queries.exec(
          conn,
          `CREATE (:Symbol {symbolId: $symbolId, repoId: 'repo-1', kind: 'function', name: $symbolId, exported: true, language: 'typescript', rangeStartLine: 1, rangeEndLine: 3})`,
          { symbolId },
        );
        await queries.exec(
          conn,
          `MATCH (s:Symbol {symbolId: $symbolId}), (r:Repo {repoId: 'repo-1'}), (f:File {fileId: 'file-1'})
           CREATE (s)-[:SYMBOL_IN_REPO]->(r), (s)-[:SYMBOL_IN_FILE]->(f)`,
          { symbolId },
        );
      }
      for (const targetId of [
        "unresolved:call:firstMissing",
        "unresolved:call:secondMissing",
      ]) {
        await queries.exec(
          conn,
          `MATCH (source:Symbol {symbolId: 'source'}), (target:Symbol {symbolId: $targetId})
           CREATE (source)-[:DEPENDS_ON {edgeType: 'call', confidence: 0.5, resolution: 'unresolved', resolverId: 'pass1-generic', resolutionPhase: 'pass1'}]->(target)`,
          { targetId },
        );
      }

      const result = await writer.writeSemanticIndex(conn, {
        repoId: "repo-1",
        runId: "run-lsif",
        providerType: "lsif",
        providerId: "fixture",
        generatedAt: "2026-05-07T00:00:00.000Z",
        documents: [
          {
            languageId: "typescript",
            sourcePath: "src/example.ts",
            occurrences: [],
            diagnostics: [],
          },
        ],
        symbols: [],
        edges: [
          {
            sourceSymbolId: "source",
            targetSymbolId: "actualA",
            edgeType: "call",
            confidence: 0.95,
            resolution: "exact",
            resolverId: "lsif:fixture",
            resolutionPhase: "semantic-enrichment:lsif",
            capability: "definition",
            provenance: {
              providerType: "lsif",
              providerId: "fixture",
              capability: "definition",
              confidence: 0.95,
              runId: "run-lsif",
              resolutionPhase: "semantic-enrichment:lsif",
            },
          },
        ],
        diagnostics: [],
      });

      assert.strictEqual(result.edgesCreated, 1);
      assert.strictEqual(result.edgesReplaced, 0);
      const rows = await queries.queryAll<{ target: string; resolution: string }>(
        conn,
        `MATCH (:Symbol {symbolId: 'source'})-[d:DEPENDS_ON {edgeType: 'call'}]->(target:Symbol)
         RETURN target.symbolId AS target, d.resolution AS resolution
         ORDER BY target.symbolId`,
        {},
      );
      assert.deepStrictEqual(rows, [
        { target: "actualA", resolution: "exact" },
        { target: "unresolved:call:firstMissing", resolution: "unresolved" },
        { target: "unresolved:call:secondMissing", resolution: "unresolved" },
      ]);
    },
  );

  it(
    "maps provider range symbols onto existing SDL symbols before writing edges",
    { skip: !ladybugAvailable },
    async () => {
      const writer = await import("../../dist/semantic/writer.js");
      await queries.exec(
        conn,
        `CREATE (:Repo {repoId: 'repo-1', rootPath: '.', configJson: '{}', createdAt: 'now'})`,
        {},
      );
      await queries.exec(
        conn,
        `CREATE (:File {fileId: 'file-1', relPath: 'src/example.ts', contentHash: 'hash', language: 'typescript', byteSize: 100, lastIndexedAt: 'now', directory: 'src'})`,
        {},
      );
      for (const symbol of [
        { id: "source", name: "caller", start: 1, end: 3 },
        { id: "target", name: "callee", start: 5, end: 7 },
      ]) {
        await queries.exec(
          conn,
          `CREATE (:Symbol {symbolId: $symbolId, repoId: 'repo-1', kind: 'function', name: $name, exported: true, language: 'typescript', rangeStartLine: $startLine, rangeEndLine: $endLine, source: 'treesitter', external: false, symbolStatus: 'real'})`,
          {
            symbolId: symbol.id,
            name: symbol.name,
            startLine: symbol.start,
            endLine: symbol.end,
          },
        );
        await queries.exec(
          conn,
          `MATCH (s:Symbol {symbolId: $symbolId}), (r:Repo {repoId: 'repo-1'}), (f:File {fileId: 'file-1'})
           CREATE (s)-[:SYMBOL_IN_REPO]->(r), (s)-[:SYMBOL_IN_FILE]->(f)`,
          { symbolId: symbol.id },
        );
      }

      const result = await writer.writeSemanticIndex(conn, {
        repoId: "repo-1",
        runId: "run-lsif",
        providerType: "lsif",
        providerId: "lsif",
        sourceIndexPath: "index.lsif",
        generatedAt: "2026-05-07T00:00:00.000Z",
        documents: [
          {
            languageId: "typescript",
            sourcePath: "src/example.ts",
            occurrences: [],
            diagnostics: [],
          },
        ],
        symbols: [
          {
            providerSymbolId: "lsif:source",
            name: "caller",
            languageId: "typescript",
            sourcePath: "src/example.ts",
            range: { startLine: 1, startCol: 2, endLine: 1, endCol: 8 },
          },
          {
            providerSymbolId: "lsif:target",
            name: "callee",
            languageId: "typescript",
            sourcePath: "src/example.ts",
            range: { startLine: 5, startCol: 0, endLine: 5, endCol: 6 },
          },
        ],
        edges: [
          {
            sourceProviderSymbolId: "lsif:source",
            targetProviderSymbolId: "lsif:target",
            edgeType: "call",
            confidence: 0.9,
            resolution: "exact",
            resolverId: "lsif:fixture",
            resolutionPhase: "lsif",
            capability: "definition",
            provenance: {
              providerType: "lsif",
              providerId: "fixture",
              capability: "definition",
              confidence: 0.9,
              runId: "run-lsif",
              resolutionPhase: "lsif",
            },
          },
        ],
        diagnostics: [],
      });

      assert.strictEqual(result.edgesCreated, 1);
      const rows = await queries.queryAll<{ target: string }>(
        conn,
        `MATCH (:Symbol {symbolId: 'source'})-[d:DEPENDS_ON {edgeType: 'call'}]->(target:Symbol)
         RETURN target.symbolId AS target`,
        {},
      );
      assert.deepStrictEqual(rows, [{ target: "target" }]);
    },
  );
});
