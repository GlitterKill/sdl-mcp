/**
 * retrieval-index-lifecycle.test.ts
 *
 * Tests for src/retrieval/index-lifecycle.ts.
 *
 * index-lifecycle.ts depends on kuzu (LadybugDB) connections and
 * src/db/ladybug.ts which transitively imports src/util/tracing.ts — an
 * OTel module that breaks in the tsx unit-test environment.  Tests therefore
 * use source-reading and structural validation instead of live imports.
 *
 * Structural / shape tests confirm the module exports the expected API
 * and that IndexHealthResult values satisfy the documented interface.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  indexMatchesExactIdentity,
  type IndexHealthResult,
} from "../../dist/retrieval/index-lifecycle.js";

// ---------------------------------------------------------------------------
// Source text fixture
// ---------------------------------------------------------------------------

const src = readFileSync(
  join(process.cwd(), "src/retrieval/index-lifecycle.ts"),
  "utf8",
);
const safeRebuildSrc = readFileSync(
  join(process.cwd(), "src/db/ladybug-safe-rebuild.ts"),
  "utf8",
);
const safeRebuildCliSrc = readFileSync(
  join(process.cwd(), "src/cli/commands/index-safe-rebuild.ts"),
  "utf8",
);

// ---------------------------------------------------------------------------
// IndexHealthResult structure
// ---------------------------------------------------------------------------

describe("IndexHealthResult structure", () => {
  it("satisfies the expected shape: fts object + vectors array", () => {
    const result: IndexHealthResult = {
      fts: {
        exists: false,
        healthy: false,
        indexName: "symbol_search_text_v1",
      },
      vectors: [],
    };

    assert.ok(typeof result.fts === "object", "fts should be an object");
    assert.ok(typeof result.fts.exists === "boolean", "fts.exists should be boolean");
    assert.ok(typeof result.fts.healthy === "boolean", "fts.healthy should be boolean");
    assert.ok(
      result.fts.indexName === null || typeof result.fts.indexName === "string",
      "fts.indexName should be string or null",
    );

    assert.ok(Array.isArray(result.vectors), "vectors should be an array");
    assert.strictEqual(result.vectors.length, 0, "fixed Symbol vector health is removed");

    for (const v of result.vectors) {
      assert.ok(typeof v.model === "string", "vector.model should be string");
      assert.ok(typeof v.exists === "boolean", "vector.exists should be boolean");
      assert.ok(typeof v.healthy === "boolean", "vector.healthy should be boolean");
      assert.ok(
        v.indexName === null || typeof v.indexName === "string",
        "vector.indexName should be string or null",
      );
    }
  });

  it("fts.indexName can be null", () => {
    const result: IndexHealthResult = {
      fts: { exists: false, healthy: false, indexName: null },
      vectors: [],
    };
    assert.strictEqual(result.fts.indexName, null);
  });

  it("vectors array can be empty", () => {
    const result: IndexHealthResult = {
      fts: { exists: false, healthy: false, indexName: "x" },
      vectors: [],
    };
    assert.deepStrictEqual(result.vectors, []);
  });
});

// ---------------------------------------------------------------------------
// ensureIndexes — source verification
// ---------------------------------------------------------------------------

describe("ensureIndexes source verification", () => {
  it("source exports ensureIndexes", () => {
    assert.ok(
      src.includes("export async function ensureIndexes"),
      "ensureIndexes should be exported",
    );
  });

  it("ensureIndexes checks getExtensionCapabilities before creating indexes", () => {
    const fnStart = src.indexOf("export async function ensureIndexes");
    const fnBody = src.slice(fnStart, fnStart + 800);
    assert.ok(
      fnBody.includes("getExtensionCapabilities()"),
      "ensureIndexes should call getExtensionCapabilities()",
    );
  });

  it("ensureIndexes skips when FTS extension unavailable", () => {
    const fnStart = src.indexOf("export async function ensureIndexes");
    const fnBody = src.slice(fnStart, fnStart + 1800);
    assert.ok(
      fnBody.includes("!caps.fts"),
      "ensureIndexes should check !caps.fts before creating FTS index",
    );
  });

  it("does not bootstrap fixed Symbol vector indexes", () => {
    const fnStart = src.indexOf("export async function ensureIndexes");
    const fnEnd = src.indexOf(
      "export async function ensureEntityIndexes",
      fnStart,
    );
    const fnBody = src.slice(fnStart, fnEnd);
    assert.ok(!fnBody.includes("CREATE_VECTOR_INDEX"));
    assert.ok(!fnBody.includes("hasCompleteSymbolVectorEmbedding"));
    assert.ok(!fnBody.includes("SYMBOL_VECTOR_EMBEDDING_TABLE"));
  });

  it("ensureIndexes can skip Symbol FTS during deferred semantic readiness", () => {
    const fnStart = src.indexOf("export async function ensureIndexes");
    const fnBody = src.slice(fnStart, fnStart + 3500);
    assert.ok(
      fnBody.includes("includeFtsIndex"),
      "ensureIndexes should accept an includeFtsIndex option",
    );
    assert.ok(
      fnBody.includes("options.includeFtsIndex !== false"),
      "ensureIndexes should leave Symbol FTS enabled by default",
    );
  });

  it("ensureIndexes records deferred retrieval timing subphases", () => {
    const fnStart = src.indexOf("export async function ensureIndexes");
    const fnBody = src.slice(fnStart, fnStart + 5000);
    assert.ok(
      fnBody.includes("recordTiming"),
      "ensureIndexes should accept a timing recorder option",
    );
    assert.ok(
      fnBody.includes('"symbolDiscovery"'),
      "ensureIndexes should time Symbol index discovery",
    );
    assert.ok(
      fnBody.includes('"symbolFts"'),
      "ensureIndexes should time Symbol FTS work",
    );
  });

  it("ensureIndexes returns IndexEnsureResult with created/skipped/failed arrays", () => {
    assert.ok(src.includes("created: []"), "should initialise created array");
    assert.ok(src.includes("skipped: []"), "should initialise skipped array");
    assert.ok(src.includes("failed: []"), "should initialise failed array");
  });

  it("source exports checkIndexHealth", () => {
    assert.ok(
      src.includes("export async function checkIndexHealth"),
      "checkIndexHealth should be exported",
    );
  });

  it("source exports createFtsIndex", () => {
    assert.ok(
      src.includes("export async function createFtsIndex"),
      "createFtsIndex should be exported",
    );
  });

  it("source exports createVectorIndex", () => {
    assert.ok(
      src.includes("export async function createVectorIndex"),
      "createVectorIndex should be exported",
    );
  });

  it("source exports showIndexes", () => {
    assert.ok(
      src.includes("export async function showIndexes"),
      "showIndexes should be exported",
    );
  });
});

// ---------------------------------------------------------------------------
// IndexEnsureResult structural validation
// ---------------------------------------------------------------------------

describe("IndexEnsureResult structure", () => {
  it("has created, skipped, failed string arrays", () => {
    const result = { created: ["idx_a"], skipped: ["idx_b"], failed: [] as string[] };
    assert.ok(Array.isArray(result.created));
    assert.ok(Array.isArray(result.skipped));
    assert.ok(Array.isArray(result.failed));
  });

  it("empty result has all three empty arrays", () => {
    const result = { created: [] as string[], skipped: [] as string[], failed: [] as string[] };
    assert.strictEqual(result.created.length, 0);
    assert.strictEqual(result.skipped.length, 0);
    assert.strictEqual(result.failed.length, 0);
  });
});

// ---------------------------------------------------------------------------
// showIndexes — SHOW_INDEXES() RETURN * compatibility
// ---------------------------------------------------------------------------
describe("showIndexes — SHOW_INDEXES() RETURN * compatibility", () => {
  it("source uses CALL SHOW_INDEXES() RETURN * (not bare SHOW_INDEXES())", () => {
    // The fix: Kuzu requires RETURN * to actually return rows
    const fnStart = src.indexOf("export async function showIndexes");
    assert.ok(fnStart !== -1, "showIndexes function must exist");
    const fnBody = src.slice(fnStart, fnStart + 500);
    assert.ok(
      fnBody.includes('CALL SHOW_INDEXES() RETURN *'),
      "showIndexes must use 'CALL SHOW_INDEXES() RETURN *' syntax",
    );
    assert.ok(
      !fnBody.includes('queryAll<ShowIndexRow>(conn, "CALL SHOW_INDEXES()")'),
      "showIndexes must NOT use bare 'CALL SHOW_INDEXES()' without RETURN *",
    );
  });

  it("ShowIndexRow interface includes property_names array field", () => {
    assert.ok(
      src.includes("property_names?: string[]"),
      "ShowIndexRow should have a property_names array field for FTS indexes",
    );
  });

  it("ShowIndexRow interface includes table_name field", () => {
    assert.ok(
      src.includes("table_name?: string"),
      "ShowIndexRow should have a table_name field",
    );
  });

  it("ShowIndexRow interface includes extension_loaded field", () => {
    assert.ok(
      src.includes("extension_loaded?: boolean"),
      "ShowIndexRows should preserve extension_loaded so persisted unloaded indexes are not reported healthy",
    );
  });

  it("IndexInfo keeps tableName for table-aware index checks", () => {
    assert.ok(
      src.includes("tableName?: string"),
      "IndexInfo should expose tableName so same-name indexes on other tables do not confuse lifecycle checks",
    );
  });

  it("parsing prioritises index_name over name", () => {
    const fnStart = src.indexOf("function parseShowIndexRows");
    const fnBody = src.slice(fnStart, fnStart + 800);
    // The fix: Kuzu RETURN * columns are index_name, not name
    assert.ok(
      fnBody.includes("row.index_name ?? row.name"),
      "Should prioritise index_name (Kuzu convention) over name",
    );
  });

  it("parsing handles property_names array for FTS rows", () => {
    const fnStart = src.indexOf("function parseShowIndexRows");
    const fnBody = src.slice(fnStart, fnStart + 1000);
    assert.ok(
      fnBody.includes("Array.isArray(row.property_names)"),
      "Should check for property_names array (FTS rows)",
    );
  });

  it("empty-array fallback only on real errors (not on valid empty result)", () => {
    const fnStart = src.indexOf("export async function showIndexes");
    const fnBody = src.slice(fnStart, fnStart + 1500);
    // The catch block should return [] only on actual errors
    assert.ok(
      fnBody.includes("catch (err)"),
      "showIndexes should have a catch block for error fallback",
    );
    assert.ok(
      fnBody.includes("RETURN * unavailable"),
      "Error log should reference 'RETURN *' syntax in message",
    );
  });
});

describe("fixed Symbol vector bootstrap removal", () => {
  it("checkIndexHealth reports no global Symbol vector entries", () => {
    const fnStart = src.indexOf("export async function checkIndexHealth");
    const fnEnd = src.indexOf("export async function ensureIndexes", fnStart);
    const fnBody = src.slice(fnStart, fnEnd);
    assert.ok(fnBody.includes("vectors: []"));
    assert.ok(!fnBody.includes("SYMBOL_VECTOR_EMBEDDING_TABLE"));
  });

  it("keeps entity vector index checks table-aware", () => {
    assert.ok(
      src.includes(
        'indexExistsForTable(existing, "FileSummary", indexName, "vector")',
      ),
    );
    assert.ok(
      src.includes(
        'indexExistsForTable(existing, "AgentFeedback", indexName, "vector")',
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// createFtsIndex — safe literal query path
// ---------------------------------------------------------------------------
describe("createFtsIndex — safe literal query", () => {
  it("uses the stored-procedure helper for FTS index creation", () => {
    const fnStart = src.indexOf("export async function createFtsIndex");
    assert.ok(fnStart !== -1, "createFtsIndex function must exist");
    const fnBody = src.slice(fnStart, fnStart + 800);
    assert.ok(
      fnBody.includes("execStoredProc("),
      "createFtsIndex should use execStoredProc for Kuzu procedure calls",
    );
  });

  it("validates table and index names before interpolation", () => {
    const fnStart = src.indexOf("export async function createFtsIndex");
    const fnBody = src.slice(fnStart, fnStart + 800);
    assert.ok(
      fnBody.includes("validateIdentifier"),
      "createFtsIndex should validate identifiers to prevent injection",
    );
  });

  it("uses literal string interpolation for CREATE_FTS_INDEX call", () => {
    const fnStart = src.indexOf("export async function createFtsIndex");
    const fnBody = src.slice(fnStart, fnStart + 800);
    assert.ok(
      fnBody.includes("CREATE_FTS_INDEX("),
      "should call CREATE_FTS_INDEX",
    );
    // Should NOT use exec() for DDL procedures
    assert.ok(
      !fnBody.includes("await exec("),
      "should NOT use exec() for Kuzu DDL procedures",
    );
  });
});

// ---------------------------------------------------------------------------
// dropFtsIndex - safe literal query path
// ---------------------------------------------------------------------------
describe("dropFtsIndex - safe literal query", () => {
  it("exports a stored-procedure helper for FTS index deletion", () => {
    const fnStart = src.indexOf("export async function dropFtsIndex");
    assert.ok(fnStart !== -1, "dropFtsIndex function must exist");
    const fnBody = src.slice(fnStart, fnStart + 1000);
    assert.ok(
      fnBody.includes("execStoredProc("),
      "dropFtsIndex should use execStoredProc for Kuzu procedure calls",
    );
  });

  it("parsing maps extension_loaded false to unknown health", () => {
    const fnStart = src.indexOf("function parseShowIndexRows");
    const fnBody = src.slice(fnStart, fnStart + 1600);
    assert.ok(fnBody.includes("row.extension_loaded"));
    assert.ok(
      fnBody.includes(
        'status: extensionLoaded === false ? "unknown" : "healthy"',
      ),
    );
  });

  it("parsing maps table_name to IndexInfo.tableName", () => {
    const fnStart = src.indexOf("function parseShowIndexRows");
    const fnBody = src.slice(fnStart, fnStart + 1600);
    assert.ok(
      fnBody.includes("row.table_name"),
      "showIndexes should read table_name from SHOW_INDEXES rows",
    );
    assert.ok(
      fnBody.includes("tableName"),
      "showIndexes should preserve table_name as tableName",
    );
  });

  it("validates identifiers before DROP_FTS_INDEX interpolation", () => {
    const fnStart = src.indexOf("export async function dropFtsIndex");
    const fnBody = src.slice(fnStart, fnStart + 1000);
    assert.ok(
      fnBody.includes("validateIdentifier"),
      "dropFtsIndex should validate identifiers to prevent injection",
    );
    assert.ok(
      fnBody.includes("DROP_FTS_INDEX("),
      "dropFtsIndex should call DROP_FTS_INDEX",
    );
  });

  it("uses FTS-specific absent-index matching plus SHOW_INDEXES confirmation", () => {
    const fnStart = src.indexOf("export async function dropFtsIndex");
    const fnBody = src.slice(fnStart, fnStart + 2400);
    assert.ok(
      fnBody.includes("isAbsentFtsIndexError(msg, tableName, indexName)"),
      "dropFtsIndex should not use the generic vector absent-index matcher",
    );
    assert.ok(
      fnBody.includes("dependencies.showIndexes(conn)"),
      "dropFtsIndex should confirm absent FTS indexes through SHOW_INDEXES",
    );
    assert.ok(
      fnBody.includes("indexExistsForTable("),
      "dropFtsIndex should check the named FTS index on the requested table specifically",
    );
  });
});

// ---------------------------------------------------------------------------
// createVectorIndex — current Kuzu API with efc
// ---------------------------------------------------------------------------
describe("createVectorIndex — current Kuzu API", () => {
  it("uses efc parameter (not efs) for build-time construction", () => {
    const fnStart = src.indexOf("export async function createVectorIndex");
    assert.ok(fnStart !== -1, "createVectorIndex function must exist");
    const fnBody = src.slice(fnStart, fnStart + 800);
    assert.ok(
      fnBody.includes("efc: number"),
      "createVectorIndex should use efc parameter name",
    );
  });

  it("validates identifiers before interpolation", () => {
    const fnStart = src.indexOf("export async function createVectorIndex");
    const fnBody = src.slice(fnStart, fnStart + 800);
    assert.ok(
      fnBody.includes("validateIdentifier"),
      "createVectorIndex should validate identifiers",
    );
  });

  it("uses literal CREATE_VECTOR_INDEX with metric and efc", () => {
    const fnStart = src.indexOf("export async function createVectorIndex");
    const fnBody = src.slice(fnStart, fnStart + 800);
    assert.ok(
      fnBody.includes("metric"),
      "should specify metric in CREATE_VECTOR_INDEX call",
    );
    assert.ok(
      fnBody.includes("efc :="),
      "should pass efc as named parameter to Kuzu",
    );
  });

  it("builds a validated literal probe for QUERY_VECTOR_INDEX", () => {
    const fnStart = src.indexOf("export async function queryVectorIndexProbe");
    assert.ok(fnStart !== -1, "queryVectorIndexProbe function must exist");
    const fnBody = src.slice(fnStart, fnStart + 2_400);
    assert.ok(fnBody.includes("validateIdentifier(identity.indexName"));
    assert.ok(fnBody.includes("Number.isFinite"));
    assert.ok(fnBody.includes("QUERY_VECTOR_INDEX"));
    assert.ok(fnBody.includes("identity.tableName"));
    assert.ok(fnBody.includes("node.symbolId AS symbolId"));
    assert.ok(fnBody.includes("row.distance"));
    assert.ok(fnBody.includes("near-zero"));
    assert.ok(src.includes("@param efc - HNSW ef_construction"));
  });

  it("safe rebuild validates repository vector table identities", () => {
    assert.ok(!safeRebuildSrc.includes("SYMBOL_VECTOR_EMBEDDING_TABLE"));
    assert.ok(
      safeRebuildCliSrc.includes("assessRepositorySymbolVectorHealth"),
    );
    assert.ok(
      safeRebuildCliSrc.includes("resolveSymbolVectorPhysicalIdentity"),
    );
    assert.ok(
      safeRebuildCliSrc.includes("listRepositorySymbolVectorTableNames"),
    );
  });
});

describe("indexMatchesExactIdentity", () => {
  const index = {
    name: "symbol_vec_jina_code_v2",
    type: "vector" as const,
    property: "embeddingJinaCodeVec",
    tableName: "RepoVectorTable",
    status: "healthy" as const,
  };

  it("rejects a configured name attached to another model property", () => {
    assert.equal(
      indexMatchesExactIdentity(
        { ...index, property: "embeddingNomicVec" },
        "RepoVectorTable",
        "symbol_vec_jina_code_v2",
        "vector",
        "embeddingJinaCodeVec",
      ),
      false,
    );
  });

  it("accepts only the exact table, name, type, and property", () => {
    assert.equal(
      indexMatchesExactIdentity(
        index,
        "RepoVectorTable",
        "symbol_vec_jina_code_v2",
        "vector",
        "embeddingJinaCodeVec",
      ),
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Startup bootstrap — ladybug.ts wiring
// ---------------------------------------------------------------------------
describe("initLadybugDb bootstrap wiring", () => {
  const ladybugSrc = readFileSync(
    join(process.cwd(), "src/db/ladybug.ts"),
    "utf8",
  );
  const indexerSrc = readFileSync(
    join(process.cwd(), "src/indexer/indexer.ts"),
    "utf8",
  );

  it("imports ensureIndexes and ensureEntityIndexes", () => {
    assert.ok(
      ladybugSrc.includes("ensureIndexes"),
      "ladybug.ts should import ensureIndexes",
    );
    assert.ok(
      ladybugSrc.includes("ensureEntityIndexes"),
      "ladybug.ts should import ensureEntityIndexes",
    );
  });

  it("calls ensureIndexes during initLadybugDb", () => {
    const fnStart = ladybugSrc.indexOf("async function initLadybugDbInternal");
    assert.ok(fnStart !== -1, "initLadybugDb must exist");
    const fnBody = ladybugSrc.slice(fnStart, fnStart + 8000);
    assert.ok(
      fnBody.includes("ensureIndexes("),
      "initLadybugDb should call ensureIndexes during startup",
    );
  });

  it("calls ensureEntityIndexes during initLadybugDb", () => {
    const fnStart = ladybugSrc.indexOf("async function initLadybugDbInternal");
    const fnBody = ladybugSrc.slice(fnStart, fnStart + 8000);
    assert.ok(
      fnBody.includes("ensureEntityIndexes("),
      "initLadybugDb should call ensureEntityIndexes during startup",
    );
  });

  it("deferred index builds can leave semantic vectors for semantic refresh", () => {
    const fnStart = ladybugSrc.indexOf("export async function buildDeferredIndexes");
    assert.ok(fnStart !== -1, "buildDeferredIndexes must exist");
    const fnBody = ladybugSrc.slice(fnStart, fnStart + 5000);
    assert.ok(
      fnBody.includes("deferSemanticVectorIndexes"),
      "buildDeferredIndexes should expose a deferred semantic vector option",
    );
    assert.ok(
      fnBody.includes("includeVectorIndexes: !options.deferSemanticVectorIndexes"),
      "buildDeferredIndexes should pass Symbol vector suppression to ensureIndexes",
    );
    assert.ok(
      fnBody.includes("includeFileSummaryVectorIndexes: !options.deferSemanticVectorIndexes"),
      "buildDeferredIndexes should pass FileSummary vector suppression to ensureEntityIndexes",
    );
  });

  it("deferred index builds can leave semantic text indexes for readiness recovery", () => {
    const fnStart = ladybugSrc.indexOf("export async function buildDeferredIndexes");
    assert.ok(fnStart !== -1, "buildDeferredIndexes must exist");
    const fnBody = ladybugSrc.slice(fnStart, fnStart + 5000);
    assert.ok(
      fnBody.includes("deferSemanticTextIndexes"),
      "buildDeferredIndexes should expose a deferred semantic text-index option",
    );
    assert.ok(
      fnBody.includes("includeFtsIndex: !options.deferSemanticTextIndexes"),
      "buildDeferredIndexes should pass Symbol FTS suppression to ensureIndexes",
    );
    assert.ok(
      fnBody.includes("includeEntityFtsIndexes: !options.deferSemanticTextIndexes"),
      "buildDeferredIndexes should pass entity FTS suppression to ensureEntityIndexes",
    );
  });

  it("deferred index builds record retrieval index subphase timings", () => {
    const fnStart = ladybugSrc.indexOf("export async function buildDeferredIndexes");
    assert.ok(fnStart !== -1, "buildDeferredIndexes must exist");
    const fnBody = ladybugSrc.slice(fnStart, fnStart + 5000);
    assert.ok(
      fnBody.includes("recordRetrievalIndexTiming"),
      "buildDeferredIndexes should prefix retrieval lifecycle timing",
    );
    assert.ok(
      fnBody.includes("buildDeferredIndexes.retrieval."),
      "retrieval index subphases should be reported under the deferred index namespace",
    );
    assert.ok(
      fnBody.includes("recordTiming: recordRetrievalIndexTiming"),
      "retrieval lifecycle helpers should receive the timing recorder",
    );
  });

  it("deferred index builds surface required retrieval index failures", () => {
    const fnStart = ladybugSrc.indexOf("export async function buildDeferredIndexes");
    assert.ok(fnStart !== -1, "buildDeferredIndexes must exist");
    const fnBody = ladybugSrc.slice(fnStart, fnStart + 6000);
    assert.ok(
      ladybugSrc.includes("function collectIndexEnsureFailures"),
      "deferred builds should aggregate failed ensure results",
    );
    assert.ok(
      fnBody.includes("collectIndexEnsureFailures("),
      "buildDeferredIndexes should inspect ensure failures",
    );
    assert.ok(
      fnBody.includes("Deferred retrieval index build failed for required index(es)"),
      "buildDeferredIndexes should emit an actionable retrieval-index failure",
    );
    assert.ok(
      fnBody.includes("throw err instanceof DatabaseError"),
      "buildDeferredIndexes should rethrow retrieval-index failures",
    );
  });

  it("critical Symbol FTS does not depend on process-local deferred state", () => {
    const fnStart = ladybugSrc.indexOf("export async function ensureCriticalSymbolFtsIndex");
    assert.ok(fnStart !== -1, "ensureCriticalSymbolFtsIndex must exist");
    const fnEnd = ladybugSrc.indexOf(
      "export async function buildDeferredIndexes",
      fnStart,
    );
    assert.ok(fnEnd > fnStart, "buildDeferredIndexes should follow critical FTS");
    const fnBody = ladybugSrc.slice(fnStart, fnEnd);
    assert.ok(
      !fnBody.includes("deferredIndexesPending"),
      "critical Symbol FTS must not depend on deferredIndexesPending",
    );
    assert.ok(
      fnBody.includes("includeFtsIndex: true"),
      "critical Symbol FTS should force Symbol FTS creation",
    );
    assert.ok(
      fnBody.includes("includeVectorIndexes: false"),
      "critical Symbol FTS should not move vector work before algorithms",
    );
    assert.ok(
      fnBody.includes("Deferred retrieval index build failed for required index(es)"),
      "critical Symbol FTS should use required-index failure policy",
    );
  });

  it("builds critical Symbol FTS before derived algorithm refresh", () => {
    const ensureIndex = indexerSrc.indexOf("await ensureCriticalSymbolFtsIndex(");
    const derivedIndex = indexerSrc.indexOf("finalizeDerivedState({");

    assert.ok(ensureIndex >= 0, "indexer should call ensureCriticalSymbolFtsIndex");
    assert.ok(derivedIndex >= 0, "indexer should call finalizeDerivedState");
    assert.ok(
      ensureIndex < derivedIndex,
      "critical Symbol FTS must be built before derived algorithms",
    );
  });

  it("index bootstrap failure does not block DB init", () => {
    const fnStart = ladybugSrc.indexOf("async function initLadybugDbInternal");
    const fnBody = ladybugSrc.slice(fnStart, fnStart + 8000);
    assert.ok(
      fnBody.includes("non-fatal"),
      "index bootstrap failure should be logged as non-fatal",
    );
  });
});

// ---------------------------------------------------------------------------
// Numeric array storage (Task 4)
// ---------------------------------------------------------------------------
describe("numeric array vector storage", () => {
  const schemaSrc = readFileSync(
    join(process.cwd(), "src/db/ladybug-schema.ts"),
    "utf8",
  );
  const mappingSrc = readFileSync(
    join(process.cwd(), "src/retrieval/model-mapping.ts"),
    "utf8",
  );
  const migIdxSrc = readFileSync(
    join(process.cwd(), "src/db/migrations/index.ts"),
    "utf8",
  );

  it("schema creates DOUBLE[] embedding columns for Symbol", () => {
    assert.ok(
      schemaSrc.includes("embeddingJinaCodeVec DOUBLE[768]"),
      "Schema should have embeddingJinaCodeVec DOUBLE[768] on Symbol",
    );
    assert.ok(
      schemaSrc.includes("embeddingNomicVec DOUBLE[768]"),
      "Schema should have embeddingNomicVec DOUBLE[768] on Symbol",
    );
    assert.ok(
      schemaSrc.includes("embeddingJinaCodeVec DOUBLE[768]"),
      "Schema should have embeddingJinaCodeVec DOUBLE[768] on Symbol",
    );
  });

  it("migration m013 is registered", () => {
    assert.ok(
      migIdxSrc.includes("m013"),
      "migrations/index.ts should include m013",
    );
  });

  it("model mapping includes vecProperty for each model", () => {
    assert.ok(
      mappingSrc.includes("vecProperty"),
      "model-mapping should have vecProperty field",
    );
    assert.ok(
      mappingSrc.includes("embeddingJinaCodeVec"),
      "Jina should map to embeddingJinaCodeVec",
    );
    assert.ok(
      mappingSrc.includes("embeddingNomicVec"),
      "Nomic should map to embeddingNomicVec",
    );
    assert.ok(
      mappingSrc.includes("embeddingJinaCodeVec"),
      "Jina should map to embeddingJinaCodeVec",
    );
  });

  it("model mapping exports getVecPropertyName helper", () => {
    assert.ok(
      mappingSrc.includes("export function getVecPropertyName"),
      "model-mapping should export getVecPropertyName",
    );
  });

  it("keeps vecProperty mapping out of fixed Symbol bootstrap", () => {
    const fnStart = src.indexOf("export async function ensureIndexes");
    const fnEnd = src.indexOf(
      "export async function ensureEntityIndexes",
      fnStart,
    );
    assert.ok(!src.slice(fnStart, fnEnd).includes("getVecPropertyName"));
  });
});

// ---------------------------------------------------------------------------
// Embedding persistence paths (Task 5)
// ---------------------------------------------------------------------------
describe("embedding persistence uses numeric arrays", () => {
  const embSrc = readFileSync(
    join(process.cwd(), "src/db/ladybug-symbol-embeddings.ts"),
    "utf8",
  );
  const callerSrc = readFileSync(
    join(process.cwd(), "src/indexer/embeddings.ts"),
    "utf8",
  );

  it("setRepoSymbolVectorEmbedding requires a numeric vector", () => {
    assert.ok(
      embSrc.includes("vectorArray: number[]"),
      "setRepoSymbolVectorEmbedding should require a numeric vector",
    );
  });

  it("writes vectors to the model-specific numeric column", () => {
    assert.ok(
      embSrc.includes("e.${vectorProperty} = r.vectorArray"),
      "Should write to the selected numeric vector column",
    );
  });

  it("routes single-row replacement through the batch delete/reinsert path", () => {
    const fnStart = embSrc.indexOf(
      "export async function setRepoSymbolVectorEmbedding(",
    );
    const fnEnd = embSrc.indexOf(
      "export async function setRepoSymbolVectorEmbeddingBatch(",
      fnStart,
    );
    const fnBody = embSrc.slice(fnStart, fnEnd);

    assert.match(fnBody, /setRepoSymbolVectorEmbeddingBatch\(/);
    assert.doesNotMatch(fnBody, /MERGE \(e:/);
  });

  it("resolves the model-specific vector property", () => {
    assert.ok(
      embSrc.includes("getVecPropertyName(model)"),
      "storage should resolve the model-specific vector property",
    );
  });

  it("embedding caller passes raw vector array via batch", () => {
    const callSite = callerSrc.indexOf("setRepoSymbolVectorEmbeddingBatch(");
    assert.ok(callSite > 0, "Should call setRepoSymbolVectorEmbeddingBatch");
    assert.match(
      callerSrc,
      /const replacementItems:[\s\S]*?vectorArray,[\s\S]*?setRepoSymbolVectorEmbeddingBatch\([\s\S]*?replacementItems,/,
      "Caller should pass raw vector arrays in repository batch items",
    );
  });
});

// ---------------------------------------------------------------------------
// Vector index API alignment (Task 6)
// ---------------------------------------------------------------------------
describe("vector index API — efc/efs config distinction", () => {
  const configSrc = readFileSync(
    join(process.cwd(), "src/config/types.ts"),
    "utf8",
  );

  it("config schema has efc field for build-time construction", () => {
    assert.ok(
      configSrc.includes("efc:"),
      "Config should have efc field",
    );
  });

  it("config schema retains efs for query-time", () => {
    assert.ok(
      configSrc.includes("efs:"),
      "Config should retain efs field for query-time",
    );
  });

  it("createVectorIndex uses efc parameter", () => {
    const fnStart = src.indexOf("export async function createVectorIndex");
    const fnBody = src.slice(fnStart, fnStart + 800);
    assert.ok(
      fnBody.includes("efc: number"),
      "createVectorIndex should accept efc parameter",
    );
  });

  it("does not consume vector config in fixed Symbol bootstrap", () => {
    const fnStart = src.indexOf("export async function ensureIndexes");
    const fnEnd = src.indexOf(
      "export async function ensureEntityIndexes",
      fnStart,
    );
    const fnBody = src.slice(fnStart, fnEnd);
    assert.ok(!fnBody.includes("vectorConfig"));
    assert.ok(!fnBody.includes("CREATE_VECTOR_INDEX"));
  });
});

// ---------------------------------------------------------------------------
// Model-aware routing (Task 7)
// ---------------------------------------------------------------------------
describe("model-aware hybrid retrieval routing", () => {
  const orchSrc = readFileSync(
    join(process.cwd(), "src/retrieval/orchestrator.ts"),
    "utf8",
  );

  it("prioritises Jina for Symbol vector retrieval", () => {
    assert.ok(
      orchSrc.includes("Prioritize Jina"),
      "Orchestrator should prioritise Jina for Symbol retrieval",
    );
  });

  it("sorts models with jina-code first", () => {
    assert.ok(
      orchSrc.includes("sortedModels"),
      "Orchestrator should sort models by priority",
    );
  });

  it("reports specific retrieval source types", () => {
    assert.ok(
      orchSrc.includes("vector:jinacode"),
      "Evidence should report vector:jinacode source",
    );
    assert.ok(
      orchSrc.includes("vector:nomic"),
      "Evidence should report vector:nomic source",
    );
  });

  it("model-mapping exports getVecPropertyName for vector column resolution", () => {
    const mappingSrc = readFileSync(
      join(process.cwd(), "src/retrieval/model-mapping.ts"),
      "utf8",
    );
    assert.ok(
      mappingSrc.includes("export function getVecPropertyName"),
      "model-mapping should export getVecPropertyName",
    );
  });
});
