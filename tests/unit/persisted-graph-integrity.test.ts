import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  closeLadybugDb,
  getLadybugConn,
  initLadybugDb,
  withWriteConn,
} from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import * as derivedState from "../../dist/db/ladybug-derived-state.js";
import {
  installObservabilityTap,
  resetObservabilityTap,
  type DbLatencyTapEvent,
  type ObservabilityTap,
} from "../../dist/observability/event-tap.js";
import {
  capturePersistedGraphIntegrity,
  compareGraphIntegrityExpectations,
  completeGraphIntegrityVerification,
  createGraphIntegrityExpectation,
  createGraphIntegrityExpectationFromManifest,
  createGraphIntegrityFileDigest,
  createGraphIntegrityFilelessDelta,
  createGraphIntegrityFilelessEdgeReferences,
  createGraphIntegrityFilelessReferenceTuples,
  createGraphIntegrityFilelessSymbols,
  createGraphIntegrityFileState,
  failActiveGraphIntegrityVerification,
  GraphIntegrityFilelessLivenessLedger,
  GraphIntegrityVerificationError,
  graphIntegrityPlaceholderPruningIsSafe,
  hasActiveGraphIntegrityVerification,
  parseGraphIntegrityCanonicalSymbol,
  parseGraphIntegrityFilelessReferences,
  PersistedGraphIntegritySession,
  verifyPersistedGraphIntegrityRevision,
  verifyNoOpIncrementalGraphIntegrity,
} from "../../dist/indexer/provider-first/persisted-graph-integrity.js";

const {
  graphIntegrityIsVerifiedForVersion,
  graphIntegrityNextBestAction,
  invalidateGraphIntegrity,
  markGraphIntegrityFailedIfVerifying,
  markGraphIntegrityVerified,
  markGraphIntegrityVerifying,
  markUnrevisionedGraphIntegrityFailedIfVerifying,
} = derivedState;

function symbolRow(overrides: Record<string, unknown> = {}) {
  return {
    symbolId: "sym:alpha",
    repoId: "repo",
    fileId: "repo:src/alpha.ts",
    kind: "function",
    name: "alpha",
    exported: true,
    visibility: "public",
    language: "typescript",
    rangeStartLine: 1,
    rangeStartCol: 0,
    rangeEndLine: 3,
    rangeEndCol: 1,
    astFingerprint: "fingerprint-alpha",
    signatureJson: '{"name":"alpha"}',
    summary: null,
    invariantsJson: null,
    sideEffectsJson: null,
    source: "scip",
    scipSymbol: "scip-typescript npm fixture 1.0.0 src/alpha.ts/alpha().",
    updatedAt: "2026-07-16T00:00:00.000Z",
    ...overrides,
  };
}

function externalSymbolRow(symbolId: string, name: string) {
  return {
    symbolId,
    kind: "function",
    name,
    exported: true,
    language: "typescript",
    external: true,
    scipSymbol: symbolId,
    source: "scip" as const,
    updatedAt: "2026-07-16T00:00:00.000Z",
  };
}

function callEdge(fromSymbolId: string, toSymbolId: string, repoId = "repo") {
  return {
    repoId,
    fromSymbolId,
    toSymbolId,
    edgeType: "call",
    weight: 1,
    confidence: 1,
    resolution: "exact",
    provenance: null,
    createdAt: "2026-07-16T00:00:00.000Z",
  };
}

function captureDbLatency(events: DbLatencyTapEvent[]): void {
  const noop = () => {};
  const tap: ObservabilityTap = {
    toolCall: noop,
    indexEvent: noop,
    semanticSearch: noop,
    policyDecision: noop,
    prefetch: noop,
    watcherHealth: noop,
    edgeResolution: noop,
    runtimeExecution: noop,
    setupPipeline: noop,
    summaryGeneration: noop,
    summaryQuality: noop,
    pprResult: noop,
    scipIngest: noop,
    packedWire: noop,
    tokenSavings: noop,
    poolSample: noop,
    resourceSample: noop,
    indexPhase: noop,
    cacheLookup: noop,
    sliceBuild: noop,
    deltaBlastRadius: noop,
    auditBufferSample: noop,
    postIndexSession: noop,
    dbLatency: (event) => events.push(event),
    graphEvent: noop,
  };
  installObservabilityTap(tap);
}

function canonicalFilelessJson(
  symbolId: string,
  overrides: Record<number, unknown> = {},
): string {
  const fields: unknown[] = [
    symbolId,
    "",
    "",
    symbolId,
    "",
    "unknown",
    "unknown",
    0,
    0,
    0,
    0,
    "treesitter",
    "",
    symbolId,
    "unresolved",
    false,
    "import",
    symbolId,
  ];
  for (const [index, value] of Object.entries(overrides)) {
    fields[Number(index)] = value;
  }
  return JSON.stringify(fields);
}

async function seedVersionedGraph(root: string): Promise<void> {
  await initLadybugDb(join(root, "graph.lbug"));
  const row = symbolRow();
  await withWriteConn(async (conn) => {
    await ladybugDb.upsertRepo(conn, {
      repoId: "repo",
      rootPath: root,
      configJson: "{}",
      createdAt: "2026-07-16T00:00:00.000Z",
    });
    await ladybugDb.upsertFile(conn, {
      fileId: row.fileId,
      repoId: "repo",
      relPath: "src/alpha.ts",
      contentHash: "a".repeat(64),
      language: "typescript",
      byteSize: 10,
      lastIndexedAt: "2026-07-16T00:00:00.000Z",
    });
    await ladybugDb.upsertKnownFileSymbols(conn, [row]);
    await ladybugDb.createVersion(conn, {
      versionId: "v1",
      repoId: "repo",
      createdAt: "2026-07-16T00:00:00.000Z",
      reason: "test",
      prevVersionHash: null,
      versionHash: null,
    });
    await ladybugDb.replaceGraphIntegrityManifestInTransaction(conn, "repo", {
      files: [
        createGraphIntegrityFileState(
          "repo",
          row.fileId,
          "src/alpha.ts",
          [row],
          [],
        ),
      ],
      fileless: [],
    });
  });
}

describe("persisted graph integrity", () => {
  let root = "";

  afterEach(async () => {
    resetObservabilityTap();
    await closeLadybugDb().catch(() => {});
    if (root && existsSync(root)) {
      rmSync(root, { recursive: true, force: true });
    }
    root = "";
  });

  it("uses collision-safe tuple state IDs and sorted six-field fileless references", () => {
    const createFileState = createGraphIntegrityFileState;
    const first = createFileState(
      "repo:a",
      "b",
      "src\\alpha.ts",
      [symbolRow({ fileId: "b" })],
      [],
    ) as { stateId: string };
    const second = createFileState(
      "repo",
      "a:b",
      "src/beta.ts",
      [symbolRow({ fileId: "a:b" })],
      [],
    ) as { stateId: string };
    assert.equal(first.stateId, JSON.stringify(["repo:a", "b"]));
    assert.equal(second.stateId, JSON.stringify(["repo", "a:b"]));
    assert.notEqual(first.stateId, second.stateId);

    const zCanonical = canonicalFilelessJson("sym:z");
    const aCanonical = canonicalFilelessJson("sym:a");
    const row = createFileState(
      "repo",
      "file",
      "src\\file.ts",
      [symbolRow({ fileId: "file" })],
      [
        ["sym:z", zCanonical, "source:z", "call", "incoming", 2],
        ["sym:a", aCanonical, null, "import", "outgoing", 1],
      ],
    ) as { relPath: string; filelessReferencesJson: string };
    assert.equal(row.relPath, "src/file.ts");
    assert.deepEqual(JSON.parse(row.filelessReferencesJson), [
      ["sym:a", aCanonical, null, "import", "outgoing", 1],
      ["sym:z", zCanonical, "source:z", "call", "incoming", 2],
    ]);
  });

  it("parses canonical fileless symbols in appendCanonicalSymbol field order", () => {
    const parseCanonical = parseGraphIntegrityCanonicalSymbol;
    const parseReferences = parseGraphIntegrityFilelessReferences;
    const symbolId = "unresolved:module";
    const canonicalJson = canonicalFilelessJson(symbolId, {
      3: "module",
      4: '{"name":"module"}',
      5: "module",
      6: "typescript",
      7: 2,
      8: 3,
      9: 4,
      10: 5,
      11: "scip",
      12: "scip-symbol",
      13: "fingerprint",
      14: "external",
      15: true,
      16: "scip",
      17: "target",
    });
    assert.deepEqual(parseCanonical(canonicalJson), {
      symbolId,
      fileId: "",
      name: "module",
      signatureJson: '{"name":"module"}',
      kind: "module",
      language: "typescript",
      rangeStartLine: 2,
      rangeStartCol: 3,
      rangeEndLine: 4,
      rangeEndCol: 5,
      source: "scip",
      scipSymbol: "scip-symbol",
      astFingerprint: "fingerprint",
      symbolStatus: "external",
      external: true,
      placeholderKind: "scip",
      placeholderTarget: "target",
    });
    assert.deepEqual(
      parseReferences(
        JSON.stringify([
          [symbolId, canonicalJson, null, "import", "incoming", 2],
        ]),
      ),
      [[symbolId, canonicalJson, null, "import", "incoming", 2]],
    );

    for (const malformed of [
      "not json",
      "{}",
      JSON.stringify([[symbolId, canonicalJson, null, "import", "incoming"]]),
      JSON.stringify([[symbolId, "[]", null, "import", "incoming", 1]]),
      JSON.stringify([["wrong", canonicalJson, null, "import", "incoming", 1]]),
    ]) {
      assert.throws(() => parseReferences(malformed), /graph integrity/i);
    }
    assert.throws(() => parseCanonical("[]"), /graph integrity/i);
  });

  it("adjusts only touched fileless rows and gates zero-liveness pruning", () => {
    const createDelta = createGraphIntegrityFilelessDelta;
    const canonical = (symbolId: string) => canonicalFilelessJson(symbolId);
    const state = (symbolId: string, referenceCount: number) => ({
      stateId: JSON.stringify(["repo", symbolId]),
      repoId: "repo",
      symbolId,
      canonicalSymbolJson: canonical(symbolId),
      referenceCount,
    });
    const current = new Map([
      ["sym:keep", state("sym:keep", 3)],
      ["sym:remove", state("sym:remove", 1)],
      ["sym:untouched", state("sym:untouched", 9)],
    ]);
    const previous = [
      ["sym:keep", canonical("sym:keep"), null, "call", "incoming", 2],
      ["sym:remove", canonical("sym:remove"), null, "call", "incoming", 1],
    ];
    const next = [
      ["sym:add", canonical("sym:add"), null, "call", "incoming", 2],
      ["sym:keep", canonical("sym:keep"), null, "call", "incoming", 1],
    ];

    const pruning = createDelta(
      "repo",
      current,
      previous,
      next,
      true,
    ) as { upserts: Array<{ symbolId: string; referenceCount: number }>; deleteSymbolIds: string[] };
    assert.deepEqual(
      pruning.upserts.map((row) => [row.symbolId, row.referenceCount]),
      [
        ["sym:add", 2],
        ["sym:keep", 2],
      ],
    );
    assert.deepEqual(pruning.deleteSymbolIds, ["sym:remove"]);

    const conservative = createDelta(
      "repo",
      current,
      previous,
      next,
      false,
    ) as { upserts: Array<{ symbolId: string; referenceCount: number }>; deleteSymbolIds: string[] };
    assert.deepEqual(
      conservative.upserts.map((row) => [row.symbolId, row.referenceCount]),
      [
        ["sym:add", 2],
        ["sym:keep", 2],
        ["sym:remove", 0],
      ],
    );
    assert.deepEqual(conservative.deleteSymbolIds, []);
    assert.equal(
      conservative.upserts.some((row) => row.symbolId === "sym:untouched"),
      false,
    );
  });

  it("rejects a missing fileless baseline before applying an equal next contribution", () => {
    const createDelta = createGraphIntegrityFilelessDelta;
    const canonical = canonicalFilelessJson("sym:missing");
    const contribution = [
      "sym:missing",
      canonical,
      null,
      "call",
      "incoming",
      1,
    ] as const;

    assert.throws(
      () =>
        createDelta(
          "repo",
          new Map(),
          [contribution],
          [contribution],
          true,
        ),
      { name: "DatabaseError", message: /baseline.*reference count/i },
    );
  });

  it("rejects partial fileless baseline underflow before applying next contributions", () => {
    const createDelta = createGraphIntegrityFilelessDelta;
    const symbolId = "sym:partial";
    const canonicalSymbolJson = canonicalFilelessJson(symbolId);
    const current = new Map([
      [
        symbolId,
        {
          stateId: JSON.stringify(["repo", symbolId]),
          repoId: "repo",
          symbolId,
          canonicalSymbolJson,
          referenceCount: 1,
        },
      ],
    ]);
    const previous = [
      [symbolId, canonicalSymbolJson, null, "call", "incoming", 2] as const,
    ];
    const next = [
      [symbolId, canonicalSymbolJson, null, "call", "incoming", 2] as const,
    ];

    assert.throws(
      () => createDelta("repo", current, previous, next, true),
      { name: "DatabaseError", message: /baseline.*reference count/i },
    );
  });

  it("rebuilds the existing expectation type from file and fileless manifest rows", () => {
    const createFileState = createGraphIntegrityFileState;
    const createExpectationFromManifest = createGraphIntegrityExpectationFromManifest;
    const createFileDigest = createGraphIntegrityFileDigest;
    const createExpectation = createGraphIntegrityExpectation;
    const parseCanonical = parseGraphIntegrityCanonicalSymbol;
    const fileSymbol = symbolRow({ fileId: "file" });
    const file = createFileState("repo", "file", "src/file.ts", [fileSymbol], []);
    const canonicalSymbolJson = canonicalFilelessJson("sym:fileless");
    const fileless = {
      stateId: JSON.stringify(["repo", "sym:fileless"]),
      repoId: "repo",
      symbolId: "sym:fileless",
      canonicalSymbolJson,
      referenceCount: 1,
    };

    const actual = createExpectationFromManifest([file], [fileless]);
    const expected = createExpectation([
      createFileDigest({ fileId: "file", relPath: "src/file.ts", symbols: [fileSymbol] }),
      createFileDigest({ fileId: "", relPath: "", symbols: [parseCanonical(canonicalSymbolJson)] }),
    ]);
    assert.equal((actual as { symbolCount: number }).symbolCount, expected.symbolCount);
    assert.equal((actual as { digest: string }).digest, expected.digest);
    assert.deepEqual(
      (actual as { files: Array<{ fileId: string; relPath: string; symbolCount: number; digest: string }> }).files.map(
        ({ fileId, relPath, symbolCount, digest }) => ({
          fileId,
          relPath,
          symbolCount,
          digest,
        }),
      ),
      (expected as { files: Array<{ fileId: string; relPath: string; symbolCount: number; digest: string }> }).files.map(
        ({ fileId, relPath, symbolCount, digest }) => ({
          fileId,
          relPath,
          symbolCount,
          digest,
        }),
      ),
    );
  });

  it("releases the production read-only snapshot before invoking the publication dependency", async (t) => {
    root = mkdtempSync(join(tmpdir(), "sdl-graph-integrity-publication-order-"));
    await seedVersionedGraph(root);
    const row = symbolRow();
    const file = createGraphIntegrityFileState(
      "repo",
      row.fileId,
      "src/alpha.ts",
      [row],
      [],
    );
    await withWriteConn(async (conn) => {
      await ladybugDb.replaceGraphIntegrityManifestInTransaction(conn, "repo", {
        files: [file],
        fileless: [],
      });
      const expected = createGraphIntegrityExpectationFromManifest([file], []);
      await derivedState.beginGraphIntegrityVersion(
        conn,
        "repo",
        "v1",
        expected.digest,
        true,
      );
      assert.equal(
        await derivedState.advanceGraphIntegrityRevisionInTransaction(
          conn,
          "repo",
          "v1",
          0,
        ),
        1,
      );
    });

    const { Connection } = await import("kuzu");
    const originalClose = Connection.prototype.close;
    let exclusiveConnectionReleased = false;
    t.mock.method(Connection.prototype, "close", async function () {
      await originalClose.call(this);
      exclusiveConnectionReleased = true;
    });

    const result = await verifyPersistedGraphIntegrityRevision(
      "repo",
      "v1",
      1,
      {
        persistSuccessState: async (repoId, versionId, revision, digest) => {
          assert.equal(exclusiveConnectionReleased, true);
          return derivedState.markGraphIntegrityVerifiedIfVerifying(
            repoId,
            versionId,
            revision,
            digest,
          );
        },
      },
    );

    assert.equal(result, "verified");
    assert.equal(
      (await derivedState.getDerivedState("repo"))?.graphIntegrityVerifiedRevision,
      1,
    );
  });

  it("builds the same canonical digest regardless of authoritative row order", () => {
    const createFileDigest = createGraphIntegrityFileDigest;
    const createExpectation = createGraphIntegrityExpectation;
    const first = symbolRow();
    const second = symbolRow({
      symbolId: "sym:beta",
      name: "beta",
      astFingerprint: "fingerprint-beta",
      signatureJson: '{"name":"beta"}',
      scipSymbol: "scip-typescript npm fixture 1.0.0 src/alpha.ts/beta().",
    });

    const forwardFile = createFileDigest({
      fileId: first.fileId,
      relPath: "src/alpha.ts",
      symbols: [first, second],
    });
    const reverseFile = createFileDigest({
      fileId: first.fileId,
      relPath: "src/alpha.ts",
      symbols: [second, first],
    });

    assert.deepEqual(
      createExpectation([forwardFile]),
      createExpectation([reverseFile]),
    );
  });

  it("mirrors persistence by keeping the first duplicate symbol row", () => {
    const createFileDigest = createGraphIntegrityFileDigest;
    const first = symbolRow();
    const duplicate = symbolRow({ name: "duplicate parser row" });

    assert.deepEqual(
      createFileDigest({
        fileId: first.fileId,
        relPath: "src/alpha.ts",
        symbols: [first, duplicate],
      }),
      createFileDigest({
        fileId: first.fileId,
        relPath: "src/alpha.ts",
        symbols: [first],
      }),
    );
  });

  it("matches Ladybug UTF-8 ordering for Unicode paths and symbol ids", async () => {
    root = mkdtempSync(join(tmpdir(), "sdl-graph-integrity-unicode-order-"));
    await initLadybugDb(join(root, "unicode-order.lbug"));
    const createFileDigest = createGraphIntegrityFileDigest;
    const createExpectation = createGraphIntegrityExpectation;
    const capture = capturePersistedGraphIntegrity;
    const compare = compareGraphIntegrityExpectations;
    const suffixes = ["e", "é", "\uE000", "\uFFFD", "😀"];
    const files = suffixes.map((suffix, fileIndex) => {
      const relPath = `src/a${suffix}.ts`;
      const fileId = `repo:${relPath}`;
      const symbols = [...suffixes].reverse().map((symbolSuffix) =>
        symbolRow({
          symbolId: `sym:${fileIndex}:a${symbolSuffix}`,
          fileId,
          name: `a${symbolSuffix}`,
          astFingerprint: `fingerprint-${fileIndex}-${symbolSuffix}`,
          signatureJson: `{"name":"a${symbolSuffix}"}`,
          scipSymbol: `scip-typescript npm fixture 1.0.0 ${relPath}/a${symbolSuffix}().`,
        }),
      );
      return { fileId, relPath, symbols };
    });
    const expected = createExpectation(
      [...files].reverse().map((file) => createFileDigest(file)),
    );

    await withWriteConn(async (conn) => {
      await ladybugDb.upsertRepo(conn, {
        repoId: "repo",
        rootPath: root,
        configJson: "{}",
        createdAt: "2026-07-16T00:00:00.000Z",
      });
      for (const file of files) {
        await ladybugDb.upsertFile(conn, {
          fileId: file.fileId,
          repoId: "repo",
          relPath: file.relPath,
          contentHash: "a".repeat(64),
          language: "typescript",
          byteSize: 10,
          lastIndexedAt: "2026-07-16T00:00:00.000Z",
        });
      }
      await ladybugDb.upsertKnownFileSymbols(
        conn,
        files.flatMap((file) => file.symbols),
      );
    });

    const actual = await capture(await getLadybugConn(), "repo");
    assert.equal(compare(expected, actual), null);
    assert.equal((actual as { digest: string }).digest, expected.digest);
  });

  it("stops integrity paging after a short final page", async () => {
    root = mkdtempSync(join(tmpdir(), "sdl-graph-integrity-short-page-"));
    await initLadybugDb(join(root, "short-page.lbug"));
    const fileId = "repo:src/short.ts";
    const relPath = "src/short.ts";
    const symbol = symbolRow({ fileId });

    await withWriteConn(async (conn) => {
      await ladybugDb.upsertRepo(conn, {
        repoId: "repo",
        rootPath: root,
        configJson: "{}",
        createdAt: "2026-07-22T00:00:00.000Z",
      });
      await ladybugDb.upsertFile(conn, {
        fileId,
        repoId: "repo",
        relPath,
        contentHash: "a".repeat(64),
        language: "typescript",
        byteSize: 10,
        lastIndexedAt: "2026-07-22T00:00:00.000Z",
      });
      await ladybugDb.upsertKnownFileSymbols(conn, [symbol]);
    });

    const events: DbLatencyTapEvent[] = [];
    captureDbLatency(events);
    const actual = await capturePersistedGraphIntegrity(
      await getLadybugConn(),
      "repo",
    );

    assert.equal(actual.symbolCount, 1);
    assert.equal(
      events.filter((event) => event.operation === "queryAll").length,
      1,
    );
  });

  it("filters the integrity cursor before deduplicating joined tuples", () => {
    const source = readFileSync(
      join(process.cwd(), "src/db/ladybug-graph-integrity.ts"),
      "utf8",
    );
    const queryStart = source.indexOf(
      "export async function getPersistedGraphIntegritySymbolPage",
    );
    const aliasIndex = source.indexOf(
      "WITH s, coalesce(f.fileId, '') AS fileId",
      queryStart,
    );
    const cursorIndex = source.indexOf("WHERE true", queryStart);
    const distinctIndex = source.indexOf(
      "WITH DISTINCT s, fileId, relPath",
      queryStart,
    );
    const returnIndex = source.indexOf("RETURN s.symbolId AS symbolId", queryStart);

    assert.ok(queryStart >= 0);
    assert.ok(aliasIndex > queryStart);
    assert.ok(cursorIndex > aliasIndex);
    assert.ok(distinctIndex > cursorIndex);
    assert.ok(returnIndex > distinctIndex);
  });

  it("deduplicates membership tuples across real 16384-row integrity pages", async () => {
    root = mkdtempSync(join(tmpdir(), "sdl-graph-integrity-duplicate-page-"));
    await initLadybugDb(join(root, "duplicate-page.lbug"));
    const fileId = "repo:src/page.ts";
    const relPath = "src/page.ts";
    const symbols = Array.from({ length: 16_385 }, (_, index) => {
      const suffix = String(index).padStart(5, "0");
      return symbolRow({
        symbolId: `sym:${suffix}`,
        fileId,
        name: `symbol-${suffix}`,
        astFingerprint: `fingerprint-${suffix}`,
        scipSymbol: `scip-typescript npm fixture 1.0.0 src/page.ts/symbol-${suffix}().`,
      });
    });

    await withWriteConn(async (conn) => {
      await ladybugDb.upsertRepo(conn, {
        repoId: "repo",
        rootPath: root,
        configJson: "{}",
        createdAt: "2026-07-21T00:00:00.000Z",
      });
      await ladybugDb.upsertFile(conn, {
        fileId,
        repoId: "repo",
        relPath,
        contentHash: "a".repeat(64),
        language: "typescript",
        byteSize: 10,
        lastIndexedAt: "2026-07-21T00:00:00.000Z",
      });
      await ladybugDb.upsertKnownFileSymbols(conn, symbols);
      await ladybugDb.exec(
        conn,
        `UNWIND $duplicates AS duplicateOrdinal
         MATCH (s:Symbol {symbolId: $symbolId}), (r:Repo {repoId: $repoId})
         CREATE (s)-[:SYMBOL_IN_REPO]->(r)`,
        {
          duplicates: [0],
          repoId: "repo",
          symbolId: symbols[0]!.symbolId,
        },
      );
      const duplicateCount = await ladybugDb.querySingle<{ count: unknown }>(
        conn,
        `MATCH (s:Symbol {symbolId: $symbolId})-[rel:SYMBOL_IN_REPO]->(r:Repo {repoId: $repoId})
         RETURN count(rel) AS count`,
        { repoId: "repo", symbolId: symbols[0]!.symbolId },
      );
      assert.equal(ladybugDb.toNumber(duplicateCount?.count ?? 0), 2);
    });

    const expected = createGraphIntegrityExpectation([
      createGraphIntegrityFileDigest({ fileId, relPath, symbols }),
    ]);
    const events: DbLatencyTapEvent[] = [];
    captureDbLatency(events);
    const actual = await capturePersistedGraphIntegrity(
      await getLadybugConn(),
      "repo",
    );

    assert.equal(actual.symbolCount, 16_385);
    assert.equal(
      events.filter((event) => event.operation === "queryAll").length,
      2,
    );
    assert.equal(compareGraphIntegrityExpectations(expected, actual), null);
    assert.equal(actual.digest, expected.digest);
  });

  it("keeps shared fileless placeholders in each repository universe", async () => {
    root = mkdtempSync(join(tmpdir(), "sdl-graph-integrity-shared-placeholder-"));
    await initLadybugDb(join(root, "shared-placeholder.lbug"));
    const capture = capturePersistedGraphIntegrity;
    const targetId = "unresolved:call:__sdl_v1__c2hhcmVkVGFyZ2V0";
    const sourceA = symbolRow({
      symbolId: "repo-a:sym:source",
      repoId: "repo-a",
      fileId: "repo-a:src/index.ts",
    });
    const sourceB = symbolRow({
      symbolId: "repo-b:sym:source",
      repoId: "repo-b",
      fileId: "repo-b:src/index.ts",
    });
    await withWriteConn(async (conn) => {
      for (const [repoId, source] of [
        ["repo-a", sourceA],
        ["repo-b", sourceB],
      ] as const) {
        await ladybugDb.upsertRepo(conn, {
          repoId,
          rootPath: join(root, repoId),
          configJson: "{}",
          createdAt: "2026-07-16T00:00:00.000Z",
        });
        await ladybugDb.upsertFile(conn, {
          fileId: source.fileId,
          repoId,
          relPath: "src/index.ts",
          contentHash: "a".repeat(64),
          language: "typescript",
          byteSize: 10,
          lastIndexedAt: "2026-07-16T00:00:00.000Z",
        });
        await ladybugDb.upsertKnownFileSymbols(conn, [source]);
      }
      await ladybugDb.insertEdges(conn, [
        {
          ...callEdge(sourceA.symbolId, targetId, "repo-a"),
          targetMeta: {
            symbolStatus: "unresolved",
            placeholderKind: "call",
            placeholderTarget: "sharedTarget",
          },
        },
      ]);
    });
    const baselineA = await capture(await getLadybugConn(), "repo-a");

    await withWriteConn(async (conn) => {
      const edge = {
        ...callEdge(sourceB.symbolId, targetId, "repo-b"),
        targetMeta: {
          symbolStatus: "unresolved" as const,
          placeholderKind: "call",
          placeholderTarget: "sharedTarget",
        },
      };
      await ladybugDb.insertEdges(conn, [edge]);
      await ladybugDb.insertEdges(conn, [edge]);
    });

    const [actualA, actualB] = await Promise.all([
      capture(await getLadybugConn(), "repo-a"),
      capture(await getLadybugConn(), "repo-b"),
    ]);
    assert.deepEqual(actualA, baselineA);
    assert.equal((actualA as { symbolCount: number }).symbolCount, 2);
    assert.equal((actualB as { symbolCount: number }).symbolCount, 2);
    const conn = await getLadybugConn();
    assert.equal(
      await ladybugDb.getPersistedGraphIntegrityOtherRepoSymbolCount(
        conn,
        "repo-a",
      ),
      2,
      "repo-b's source and the shared target both remain physical",
    );
    assert.equal(
      await ladybugDb.getPersistedGraphIntegrityOtherRepoSymbolCount(
        conn,
        "repo-b",
      ),
      2,
      "repo-a's source and the shared target both remain physical",
    );

    await withWriteConn((writeConn) =>
      ladybugDb.createVersion(writeConn, {
        versionId: "repo-a-v1",
        repoId: "repo-a",
        createdAt: "2026-07-16T00:00:00.000Z",
        reason: "verified shared baseline",
        prevVersionHash: null,
        versionHash: null,
      }),
    );
    const targetRow = (
      await ladybugDb.getPersistedGraphIntegritySymbolPage(conn, {
        repoId: "repo-a",
        limit: 10,
      })
    ).find((row) => row.symbolId === targetId);
    assert.ok(targetRow);
    const sharedCanonical = JSON.stringify([
      targetRow.symbolId,
      targetRow.fileId ?? "",
      targetRow.relPath ?? "",
      targetRow.name ?? "",
      targetRow.signatureJson ?? "",
      targetRow.kind ?? "",
      targetRow.language ?? "",
      ladybugDb.toNumber(targetRow.rangeStartLine),
      ladybugDb.toNumber(targetRow.rangeStartCol),
      ladybugDb.toNumber(targetRow.rangeEndLine),
      ladybugDb.toNumber(targetRow.rangeEndCol),
      targetRow.source ?? "treesitter",
      targetRow.scipSymbol ?? "",
      targetRow.astFingerprint ?? "",
      targetRow.symbolStatus ?? "real",
      targetRow.external ?? false,
      targetRow.placeholderKind ?? "",
      targetRow.placeholderTarget ?? "",
    ]);
    await withWriteConn((writeConn) =>
      ladybugDb.replaceGraphIntegrityManifestInTransaction(writeConn, "repo-a", {
        files: [
          createGraphIntegrityFileState(
            "repo-a",
            sourceA.fileId,
            "src/index.ts",
            [sourceA],
            [[targetId, sharedCanonical, sourceA.symbolId, "call", "incoming", 1]],
          ),
        ],
        fileless: [{
          stateId: JSON.stringify(["repo-a", targetId]),
          repoId: "repo-a",
          symbolId: targetId,
          canonicalSymbolJson: sharedCanonical,
          referenceCount: 1,
        }],
      }),
    );
    await derivedState.markGraphIntegrityVerified(
      "repo-a",
      "repo-a-v1",
      (baselineA as { digest: string }).digest,
    );
    const createFileDigest = createGraphIntegrityFileDigest;
    const Session = PersistedGraphIntegritySession as unknown as new (
      repoId: string,
      mode: "full" | "incremental",
      enabled: boolean,
    ) => {
      begin: (versionId: string, affectedFileIds: string[]) => Promise<void>;
      applyFile: (file: Record<string, unknown>) => void;
      prepareForPlaceholderPruning: (conn: unknown) => Promise<boolean>;
      complete: (versionId: string) => Promise<void>;
    };
    const session = new Session("repo-a", "incremental", true);
    await session.begin("repo-a-v2", [sourceA.fileId]);
    session.applyFile(
      createFileDigest({
        fileId: sourceA.fileId,
        relPath: "src/index.ts",
        symbols: [],
      }) as Record<string, unknown>,
    );
    await withWriteConn((writeConn) =>
      ladybugDb.deleteFilesByIds(writeConn, [sourceA.fileId]),
    );
    assert.equal(
      await session.prepareForPlaceholderPruning(await getLadybugConn()),
      true,
    );
    assert.equal(
      await ladybugDb.pruneIsolatedPlaceholderSymbols(
        await getLadybugConn(),
        "repo-a",
      ),
      0,
      "repo-b's edge keeps the shared target physically live",
    );
    await withWriteConn((writeConn) =>
      ladybugDb.createVersion(writeConn, {
        versionId: "repo-a-v2",
        repoId: "repo-a",
        createdAt: "2026-07-16T00:00:01.000Z",
        reason: "remove repo-a source",
        prevVersionHash: null,
        versionHash: null,
      }),
    );
    await session.complete("repo-a-v2");
    const [incrementalA, incrementalB] = await Promise.all([
      capture(await getLadybugConn(), "repo-a"),
      capture(await getLadybugConn(), "repo-b"),
    ]);
    assert.equal((incrementalA as { symbolCount: number }).symbolCount, 0);
    assert.equal((incrementalB as { symbolCount: number }).symbolCount, 2);

    await withWriteConn(async (writeConn) => {
      await ladybugDb.upsertFile(writeConn, {
        fileId: sourceA.fileId,
        repoId: "repo-a",
        relPath: "src/index.ts",
        contentHash: "b".repeat(64),
        language: "typescript",
        byteSize: 10,
        lastIndexedAt: "2026-07-16T00:00:02.000Z",
      });
      await ladybugDb.upsertKnownFileSymbols(writeConn, [sourceA]);
      await ladybugDb.insertEdges(writeConn, [
        {
          ...callEdge(sourceA.symbolId, targetId, "repo-a"),
          targetMeta: {
            symbolStatus: "unresolved",
            placeholderKind: "call",
            placeholderTarget: "sharedTarget",
          },
        },
      ]);
    });

    const full = new Session("repo-a", "full", true);
    await full.begin("repo-a-v3", [sourceA.fileId]);
    await withWriteConn((writeConn) =>
      ladybugDb.deleteFilesByIds(writeConn, [sourceA.fileId]),
    );
    assert.equal(
      await full.prepareForPlaceholderPruning(await getLadybugConn()),
      true,
    );
    assert.equal(
      await ladybugDb.pruneIsolatedPlaceholderSymbols(
        await getLadybugConn(),
        "repo-a",
      ),
      0,
      "repo-b's edge keeps the shared target physically live",
    );
    await withWriteConn((writeConn) =>
      ladybugDb.createVersion(writeConn, {
        versionId: "repo-a-v3",
        repoId: "repo-a",
        createdAt: "2026-07-16T00:00:03.000Z",
        reason: "authoritative removal of repo-a source",
        prevVersionHash: null,
        versionHash: null,
      }),
    );
    await full.complete("repo-a-v3");

    const [finalA, finalB] = await Promise.all([
      capture(await getLadybugConn(), "repo-a"),
      capture(await getLadybugConn(), "repo-b"),
    ]);
    assert.equal((finalA as { symbolCount: number }).symbolCount, 0);
    assert.equal((finalB as { symbolCount: number }).symbolCount, 2);
  });

  it("commits every established immutable provider canonical field", () => {
    const createFileDigest = createGraphIntegrityFileDigest;
    const base = symbolRow({
      symbolStatus: "real",
      external: false,
      placeholderKind: "",
      placeholderTarget: "",
    });
    const digest = (row: ReturnType<typeof symbolRow>) =>
      createFileDigest({
        fileId: String(row.fileId),
        relPath: "src/alpha.ts",
        symbols: [row],
      }) as { digest: string };
    const baseline = digest(base).digest;
    const changes: Array<[string, unknown]> = [
      ["symbolStatus", "external"],
      ["external", true],
      ["placeholderKind", "provider-metadata"],
      ["placeholderTarget", "sym:target"],
    ];

    for (const [field, value] of changes) {
      assert.notEqual(
        digest(symbolRow({ ...base, [field]: value })).digest,
        baseline,
        `${field} must participate in the canonical digest`,
      );
    }
    assert.equal(
      digest(symbolRow({ ...base, summarySource: "post-write-llm" })).digest,
      baseline,
      "summarySource is intentionally excluded because semantic refresh mutates it",
    );
  });

  it("derives legacy expectations before either persistence path starts", () => {
    for (const [relativePath, persistenceMarker] of [
      ["src/indexer/parser/process-file.ts", "if (batchAccumulator)"],
      ["src/indexer/parser/rust-process-file.ts", "if (params.batchAccumulator)"],
    ] as const) {
      const source = readFileSync(join(process.cwd(), relativePath), "utf8");
      const digestIndex = source.indexOf(
        "const graphIntegrityFile = createGraphIntegrityFileDigest",
      );
      const persistenceIndex = source.indexOf(persistenceMarker);

      assert.ok(digestIndex >= 0, `${relativePath} must derive a compact digest`);
      assert.ok(
        digestIndex < persistenceIndex,
        `${relativePath} must derive its digest before persistence begins`,
      );
    }
  });

  it("derives empty authoritative expectations before every skip mutation", () => {
    const cases = [
      ["src/indexer/parser/early-exit.ts", "Skipping binary file", "createEmptyProcessFileResult(true"],
      ["src/indexer/parser/early-exit.ts", "not in enabled languages", "createEmptyProcessFileResult(true"],
      ["src/indexer/parser/early-exit.ts", "No adapter found", "createEmptyProcessFileResult(true"],
      ["src/indexer/parser/parse-and-extract.ts", "if (!tree)", "createEmptyProcessFileResult(true"],
      ["src/indexer/parser/rust-process-file.ts", "if (!languages.includes(ext))", "createGraphIntegrityFileDigest"],
    ] as const;

    for (const [relativePath, branchMarker, digestMarker] of cases) {
      const source = readFileSync(join(process.cwd(), relativePath), "utf8");
      const branchStart = source.indexOf(branchMarker);
      assert.ok(branchStart >= 0, `${relativePath} must contain ${branchMarker}`);
      const mutationStart = source.indexOf("await withWriteConn", branchStart);
      const digestStart = source.indexOf(digestMarker, branchStart);
      assert.ok(mutationStart >= 0, `${relativePath} must persist the skip`);
      assert.ok(
        digestStart >= 0 && digestStart < mutationStart,
        `${relativePath} ${branchMarker} must derive its empty digest before persistence`,
      );
    }
  });

  it("derives fileless provider externals and edge placeholders authoritatively", () => {
    const createFilelessSymbols = createGraphIntegrityFilelessSymbols;
    const unresolvedId = "unresolved:call:__sdl_v1__bWlzc2luZw";
    const rows = createFilelessSymbols({
      symbols: [symbolRow()],
      externalSymbols: [
        {
          symbolId: "external:fixture",
          repoId: "repo",
          kind: "class",
          name: "Fixture",
          exported: true,
          language: "external",
          rangeStartLine: 0,
          rangeStartCol: 0,
          rangeEndLine: 0,
          rangeEndCol: 0,
          external: true,
          scipSymbol: "scip-typescript npm fixture 1.0.0 Fixture#",
          source: "scip",
          updatedAt: "2026-07-16T00:00:00.000Z",
        },
      ],
      edges: [
        {
          repoId: "repo",
          fromSymbolId: "sym:alpha",
          toSymbolId: unresolvedId,
          edgeType: "call",
          weight: 0.5,
          confidence: 0.5,
          resolution: "unresolved",
          targetMeta: {
            symbolStatus: "unresolved",
            placeholderKind: "call",
            placeholderTarget: "missing",
          },
          createdAt: "2026-07-16T00:00:00.000Z",
        },
      ],
    }) as Array<Record<string, unknown>>;

    assert.deepEqual(
      rows.map((row) => row.symbolId).sort(),
      ["external:fixture", unresolvedId].sort(),
    );
    assert.ok(rows.every((row) => row.fileId === ""));
    assert.equal(
      rows.find((row) => row.symbolId === "external:fixture")?.astFingerprint,
      "external:fixture",
    );
    assert.equal(
      rows.find((row) => row.symbolId === unresolvedId)?.name,
      unresolvedId,
    );
    assert.equal(
      rows.find((row) => row.symbolId === unresolvedId)?.kind,
      "unknown",
    );
    assert.equal(
      rows.find((row) => row.symbolId === unresolvedId)?.placeholderTarget,
      "missing",
    );

    const createReferences = createGraphIntegrityFilelessEdgeReferences;
    assert.deepEqual(
      createReferences(
        [
          {
            fromSymbolId: "sym:alpha",
            toSymbolId: unresolvedId,
            edgeType: "call",
          },
          {
            fromSymbolId: "sym:alpha",
            toSymbolId: "sym:beta",
            edgeType: "call",
          },
        ],
        rows.map((row) => String(row.symbolId)),
        { trackSources: true },
      ),
      [
        {
          filelessSymbolId: unresolvedId,
          sourceSymbolId: "sym:alpha",
          edgeType: "call",
          direction: "incoming",
          referenceCount: 1,
        },
      ],
    );
    assert.deepEqual(
      createReferences(
        Array.from({ length: 1_000 }, () => ({
          fromSymbolId: "sym:alpha",
          toSymbolId: unresolvedId,
          edgeType: "call",
        })),
        [unresolvedId],
        { trackSources: false },
      ),
      [
        {
          filelessSymbolId: unresolvedId,
          sourceSymbolId: null,
          edgeType: "call",
          direction: "incoming",
          referenceCount: 1_000,
        },
      ],
      "full and baseline plans aggregate repeated references instead of retaining edges",
    );
  });

  it("canonicalizes unresolved fileless metadata from the symbol ID", () => {
    const createFilelessSymbols = createGraphIntegrityFilelessSymbols;
    const unresolvedId = "unresolved:./helpers.sh:*";
    const rows = createFilelessSymbols({
      symbols: [],
      externalSymbols: [],
      edges: [
        {
          repoId: "repo",
          fromSymbolId: "sym:alpha",
          toSymbolId: unresolvedId,
          edgeType: "import",
          weight: 0.5,
          confidence: 0.5,
          resolution: "unresolved",
          targetMeta: {
            symbolStatus: "external",
            placeholderKind: "scip",
            placeholderTarget: "stale edge hint",
          },
          createdAt: "2026-07-16T00:00:00.000Z",
        },
      ],
    }) as Array<Record<string, unknown>>;

    assert.deepEqual(rows, [
      {
        symbolId: unresolvedId,
        fileId: "",
        name: unresolvedId,
        kind: "unknown",
        language: "unknown",
        rangeStartLine: 0,
        rangeStartCol: 0,
        rangeEndLine: 0,
        rangeEndCol: 0,
        signatureJson: null,
        source: "treesitter",
        scipSymbol: null,
        astFingerprint: unresolvedId,
        symbolStatus: "unresolved",
        external: false,
        placeholderKind: "import",
        placeholderTarget: "* (from ./helpers.sh)",
      },
    ]);
  });

  it("promotes a touched placeholder over a legacy blank manifest tuple", () => {
    const unresolvedId = "unresolved:./helpers.sh:*";
    const [canonicalSymbol] = createGraphIntegrityFilelessSymbols({
      symbols: [],
      externalSymbols: [],
      edges: [
        {
          repoId: "repo",
          fromSymbolId: "sym:alpha",
          toSymbolId: unresolvedId,
          edgeType: "import",
          weight: 1,
          confidence: 1,
          resolution: "unresolved",
          provenance: null,
          createdAt: "2026-07-23T00:00:00.000Z",
        },
      ],
    });
    assert.ok(canonicalSymbol);
    const legacyBlank = canonicalFilelessJson(unresolvedId, {
      3: "",
      5: "",
      6: "",
      13: "",
    });
    const tuples = createGraphIntegrityFilelessReferenceTuples(
      [
        {
          filelessSymbolId: unresolvedId,
          sourceSymbolId: "sym:alpha",
          edgeType: "import",
          direction: "incoming",
          referenceCount: 1,
        },
      ],
      [canonicalSymbol],
      new Map([
        [
          unresolvedId,
          {
            stateId: JSON.stringify(["repo", unresolvedId]),
            repoId: "repo",
            symbolId: unresolvedId,
            canonicalSymbolJson: legacyBlank,
            referenceCount: 1,
          },
        ],
      ]),
    );

    const promoted = parseGraphIntegrityCanonicalSymbol(tuples[0]![1]);
    assert.equal(promoted.name, unresolvedId);
    assert.equal(promoted.kind, "unknown");
    assert.equal(promoted.language, "unknown");
    assert.equal(promoted.astFingerprint, unresolvedId);
  });

  it("tracks baseline liveness as counts and current incremental source deltas", () => {
    const Ledger = GraphIntegrityFilelessLivenessLedger as unknown as new (trackSources: boolean) => {
      seedReferenceCount: (row: Record<string, unknown>) => void;
      seedFileReferenceCount: (
        fileId: string,
        row: Record<string, unknown>,
      ) => void;
      removeFile: (fileId: string) => void;
      add: (row: Record<string, unknown>) => void;
      removeOutgoing: (symbolIds: string[], edgeType: string) => void;
      removeTargets: (symbolIds: string[], edgeType: string) => void;
      isReferenced: (symbolId: string) => boolean;
    };
    const ledger = new Ledger(true);
    const target = "external:fixture";
    ledger.seedReferenceCount({
      symbolId: target,
      edgeType: "call",
      referenceCount: 2,
    });
    ledger.seedFileReferenceCount("repo:src/alpha.ts", {
      symbolId: target,
      edgeType: "call",
      referenceCount: 1,
    });
    ledger.removeFile("repo:src/alpha.ts");
    assert.equal(ledger.isReferenced(target), true);

    ledger.add({
      filelessSymbolId: target,
      sourceSymbolId: "sym:changed",
      edgeType: "call",
      direction: "incoming",
      referenceCount: 1,
    });
    ledger.removeOutgoing(["sym:changed"], "call");
    assert.equal(ledger.isReferenced(target), true);
    ledger.removeTargets([target], "call");
    assert.equal(ledger.isReferenced(target), false);
  });

  it("subtracts baseline calls only for exact pass-2 source submissions", async () => {
    root = mkdtempSync(join(tmpdir(), "sdl-graph-integrity-pass2-source-"));
    await initLadybugDb(join(root, "pass2-source.lbug"));
    const capture = capturePersistedGraphIntegrity;
    const Session = PersistedGraphIntegritySession as unknown as new (
      repoId: string,
      mode: "full" | "incremental",
      enabled: boolean,
    ) => {
      begin: (versionId: string) => Promise<void>;
      applyPass2EdgeWrite: (write: Record<string, unknown>) => Promise<void>;
      prepareForPlaceholderPruning: (conn: unknown) => Promise<boolean>;
      complete: (versionId: string) => Promise<void>;
    };
    const refreshedSource = symbolRow();
    const untouchedSource = symbolRow({
      symbolId: "sym:beta",
      name: "beta",
      astFingerprint: "fingerprint-beta",
      signatureJson: '{"name":"beta"}',
    });
    const refreshedTarget = "scip-typescript npm fixture 1.0.0 dep/refresh().";
    const untouchedTarget = "scip-typescript npm fixture 1.0.0 dep/untouched().";
    await withWriteConn(async (conn) => {
      await ladybugDb.upsertRepo(conn, {
        repoId: "repo",
        rootPath: root,
        configJson: "{}",
        createdAt: "2026-07-16T00:00:00.000Z",
      });
      await ladybugDb.upsertFile(conn, {
        fileId: refreshedSource.fileId,
        repoId: "repo",
        relPath: "src/alpha.ts",
        contentHash: "a".repeat(64),
        language: "typescript",
        byteSize: 10,
        lastIndexedAt: "2026-07-16T00:00:00.000Z",
      });
      await ladybugDb.upsertKnownFileSymbols(conn, [
        refreshedSource,
        untouchedSource,
      ]);
      await ladybugDb.batchMergeExternalSymbols(conn, "repo", [
        externalSymbolRow(refreshedTarget, "refresh"),
        externalSymbolRow(untouchedTarget, "untouched"),
      ]);
      await ladybugDb.insertEdges(conn, [
        callEdge(refreshedSource.symbolId, refreshedTarget),
        callEdge(untouchedSource.symbolId, untouchedTarget),
      ]);
      await ladybugDb.createVersion(conn, {
        versionId: "v1",
        repoId: "repo",
        createdAt: "2026-07-16T00:00:00.000Z",
        reason: "verified baseline",
        prevVersionHash: null,
        versionHash: null,
      });
    });
    const baseline = (await capture(await getLadybugConn(), "repo")) as {
      digest: string;
    };
    const refreshedCanonical = JSON.stringify([
      refreshedTarget, "", "", "refresh", "", "function", "typescript",
      0, 0, 0, 0, "scip", refreshedTarget, refreshedTarget,
      "external", true, "scip", refreshedTarget,
    ]);
    const untouchedCanonical = JSON.stringify([
      untouchedTarget, "", "", "untouched", "", "function", "typescript",
      0, 0, 0, 0, "scip", untouchedTarget, untouchedTarget,
      "external", true, "scip", untouchedTarget,
    ]);
    await withWriteConn((conn) =>
      ladybugDb.replaceGraphIntegrityManifestInTransaction(conn, "repo", {
        files: [
          createGraphIntegrityFileState(
            "repo",
            refreshedSource.fileId,
            "src/alpha.ts",
            [refreshedSource, untouchedSource],
            [
              [refreshedTarget, refreshedCanonical, refreshedSource.symbolId, "call", "incoming", 1],
              [untouchedTarget, untouchedCanonical, untouchedSource.symbolId, "call", "incoming", 1],
            ],
          ),
        ],
        fileless: [
          {
            stateId: JSON.stringify(["repo", refreshedTarget]),
            repoId: "repo",
            symbolId: refreshedTarget,
            canonicalSymbolJson: refreshedCanonical,
            referenceCount: 1,
          },
          {
            stateId: JSON.stringify(["repo", untouchedTarget]),
            repoId: "repo",
            symbolId: untouchedTarget,
            canonicalSymbolJson: untouchedCanonical,
            referenceCount: 1,
          },
        ],
      }),
    );
    await derivedState.markGraphIntegrityVerified("repo", "v1", baseline.digest);

    const session = new Session("repo", "incremental", true);
    await session.begin("v2");
    await session.applyPass2EdgeWrite({
      symbolIdsToRefresh: [refreshedSource.symbolId],
      edges: [],
    });
    await withWriteConn((conn) =>
      ladybugDb.deleteOutgoingEdgesByTypeForSymbols(
        conn,
        [refreshedSource.symbolId],
        "call",
      ),
    );
    assert.equal(
      await session.prepareForPlaceholderPruning(await getLadybugConn()),
      true,
    );
    assert.equal(
      await ladybugDb.pruneIsolatedPlaceholderSymbols(
        await getLadybugConn(),
        "repo",
      ),
      1,
      "only the exact refreshed source loses its external target",
    );
    await withWriteConn((conn) =>
      ladybugDb.createVersion(conn, {
        versionId: "v2",
        repoId: "repo",
        createdAt: "2026-07-16T00:00:01.000Z",
        reason: "exact pass-2 refresh",
        prevVersionHash: null,
        versionHash: null,
      }),
    );
    await session.complete("v2");
  });

  it("attributes and later removes a new pass-2 call from an unchanged importer", async () => {
    root = mkdtempSync(join(tmpdir(), "sdl-graph-integrity-pass2-importer-"));
    await initLadybugDb(join(root, "pass2-importer.lbug"));
    const capture = capturePersistedGraphIntegrity;
    const Session = PersistedGraphIntegritySession as unknown as new (
      repoId: string,
      mode: "full" | "incremental",
      enabled: boolean,
    ) => {
      begin: (versionId: string) => Promise<void>;
      applyFile: (file: Record<string, unknown>) => void;
      applyPass2EdgeWrite: (write: Record<string, unknown>) => Promise<void>;
      prepareForPlaceholderPruning: (conn: unknown) => Promise<boolean>;
      stageManifest: (versionId: string) => Promise<number | undefined>;
      complete: (versionId: string) => Promise<void>;
    };
    const changedSource = symbolRow();
    const importerSource = symbolRow({
      symbolId: "sym:importer",
      fileId: "repo:src/importer.ts",
      name: "importer",
      astFingerprint: "fingerprint-importer",
      signatureJson: '{"name":"importer"}',
    });
    const targetId = "unresolved:call:lateTarget";
    await withWriteConn(async (conn) => {
      await ladybugDb.upsertRepo(conn, {
        repoId: "repo",
        rootPath: root,
        configJson: "{}",
        createdAt: "2026-07-16T00:00:00.000Z",
      });
      await ladybugDb.upsertFile(conn, {
        fileId: changedSource.fileId,
        repoId: "repo",
        relPath: "src/alpha.ts",
        contentHash: "a".repeat(64),
        language: "typescript",
        byteSize: 10,
        lastIndexedAt: "2026-07-16T00:00:00.000Z",
      });
      await ladybugDb.upsertFile(conn, {
        fileId: importerSource.fileId,
        repoId: "repo",
        relPath: "src/importer.ts",
        contentHash: "b".repeat(64),
        language: "typescript",
        byteSize: 10,
        lastIndexedAt: "2026-07-16T00:00:00.000Z",
      });
      await ladybugDb.upsertKnownFileSymbols(conn, [
        changedSource,
        importerSource,
      ]);
      await ladybugDb.createVersion(conn, {
        versionId: "v1",
        repoId: "repo",
        createdAt: "2026-07-16T00:00:00.000Z",
        reason: "verified baseline",
        prevVersionHash: null,
        versionHash: null,
      });
    });
    const baseline = await capture(await getLadybugConn(), "repo");
    await withWriteConn((conn) =>
      ladybugDb.replaceGraphIntegrityManifestInTransaction(conn, "repo", {
        files: [
          createGraphIntegrityFileState(
            "repo",
            changedSource.fileId,
            "src/alpha.ts",
            [changedSource],
            [],
          ),
          createGraphIntegrityFileState(
            "repo",
            importerSource.fileId,
            "src/importer.ts",
            [importerSource],
            [],
          ),
        ],
        fileless: [],
      }),
    );
    await derivedState.markGraphIntegrityVerified(
      "repo",
      "v1",
      baseline.digest,
    );
    assert.deepEqual(
      await ladybugDb.getPersistedGraphIntegritySourceReferenceCounts(
        await getLadybugConn(),
        "repo",
        [importerSource.symbolId, importerSource.symbolId],
        "call",
      ),
      [{
        sourceSymbolId: importerSource.symbolId,
        fileId: importerSource.fileId,
        symbolId: null,
        edgeType: "call",
        referenceCount: 0,
      }],
    );

    const addReference = new Session("repo", "incremental", true);
    await addReference.begin("v2");
    addReference.applyFile(
      createGraphIntegrityFileDigest({
        fileId: changedSource.fileId,
        relPath: "src/alpha.ts",
        symbols: [changedSource],
      }) as Record<string, unknown>,
    );
    const newCall = callEdge(importerSource.symbolId, targetId);
    await addReference.applyPass2EdgeWrite({
      symbolIdsToRefresh: [importerSource.symbolId],
      edges: [newCall],
    });
    await withWriteConn(async (conn) => {
      await ladybugDb.insertEdges(conn, [newCall]);
      await ladybugDb.normalizeDependencyPlaceholderSymbols(conn, "repo");
      await ladybugDb.createVersion(conn, {
        versionId: "v2",
        repoId: "repo",
        createdAt: "2026-07-16T00:00:01.000Z",
        reason: "refresh another file and its importer",
        prevVersionHash: null,
        versionHash: null,
      });
    });
    assert.equal(await addReference.stageManifest("v2"), 1);

    const importerManifest = await ladybugDb.getGraphIntegrityFileState(
      await getLadybugConn(),
      "repo",
      importerSource.fileId,
    );
    const importerReferences = parseGraphIntegrityFilelessReferences(
      importerManifest?.filelessReferencesJson ?? "[]",
    );
    assert.equal(importerReferences.length, 1);
    assert.equal(importerReferences[0]?.[0], targetId);
    assert.equal(importerReferences[0]?.[2], importerSource.symbolId);
    assert.equal(importerReferences[0]?.[3], "call");
    assert.equal(importerReferences[0]?.[4], "incoming");
    assert.equal(importerReferences[0]?.[5], 1);
    const stagedFileStates = await ladybugDb.listGraphIntegrityFileStates(
      await getLadybugConn(),
      "repo",
    );
    const stagedFilelessStates = await ladybugDb.listGraphIntegrityFilelessStates(
      await getLadybugConn(),
      "repo",
    );
    assert.equal(
      compareGraphIntegrityExpectations(
        createGraphIntegrityExpectationFromManifest(
          stagedFileStates,
          stagedFilelessStates,
        ),
        await capture(await getLadybugConn(), "repo"),
      ),
      null,
    );
    await addReference.complete("v2");
    let fileless = await ladybugDb.listGraphIntegrityFilelessStates(
      await getLadybugConn(),
      "repo",
    );
    assert.deepEqual(
      fileless.map((row) => [row.symbolId, row.referenceCount]),
      [[targetId, 1]],
    );
    let state = await derivedState.getDerivedState("repo");
    assert.equal(state?.graphIntegrityState, "verified");
    assert.equal(state?.graphIntegrityRevision, 1);
    assert.equal(state?.graphIntegrityVerifiedRevision, 1);

    const removeReference = new Session("repo", "incremental", true);
    await removeReference.begin("v2");
    await removeReference.applyPass2EdgeWrite({
      symbolIdsToRefresh: [importerSource.symbolId],
      edges: [],
    });
    await withWriteConn((conn) =>
      ladybugDb.deleteOutgoingEdgesByTypeForSymbols(
        conn,
        [importerSource.symbolId],
        "call",
      ),
    );
    assert.equal(
      await removeReference.prepareForPlaceholderPruning(
        await getLadybugConn(),
      ),
      true,
    );
    assert.equal(
      await ladybugDb.pruneIsolatedPlaceholderSymbols(
        await getLadybugConn(),
        "repo",
      ),
      1,
    );
    await removeReference.complete("v2");

    const prunedImporterManifest = await ladybugDb.getGraphIntegrityFileState(
      await getLadybugConn(),
      "repo",
      importerSource.fileId,
    );
    assert.deepEqual(
      parseGraphIntegrityFilelessReferences(
        prunedImporterManifest?.filelessReferencesJson ?? "[]",
      ),
      [],
    );
    fileless = await ladybugDb.listGraphIntegrityFilelessStates(
      await getLadybugConn(),
      "repo",
    );
    assert.deepEqual(fileless, []);
    state = await derivedState.getDerivedState("repo");
    assert.equal(state?.graphIntegrityState, "verified");
    assert.equal(state?.graphIntegrityRevision, 2);
    assert.equal(state?.graphIntegrityVerifiedRevision, 2);
  });

  for (const transition of ["provider", "legacy"] as const) {
    it(`removes inherited fileless membership when ${transition} rows promote a symbol`, async () => {
      root = mkdtempSync(join(tmpdir(), `sdl-graph-integrity-${transition}-promotion-`));
      await initLadybugDb(join(root, `${transition}-promotion.lbug`));
      const capture = capturePersistedGraphIntegrity;
      const createFileDigest = createGraphIntegrityFileDigest;
      const Session = PersistedGraphIntegritySession as unknown as new (
        repoId: string,
        mode: "full" | "incremental",
        enabled: boolean,
      ) => {
        begin: (versionId: string, affectedFileIds: string[]) => Promise<void>;
        applyProviderRows: (rows: Record<string, unknown>) => void;
        applyPass1Accumulator: (accumulator: Record<string, unknown>) => void;
        complete: (versionId: string) => Promise<void>;
      };
      const promotedId = "scip-typescript npm fixture 1.0.0 src/promoted.ts/promoted().";
      const fileId = "repo:src/promoted.ts";
      const promoted = symbolRow({
        symbolId: promotedId,
        fileId,
        name: "promoted",
        astFingerprint: "promoted-definition",
        signatureJson: '{"name":"promoted"}',
        scipSymbol: promotedId,
      });
      const file = {
        fileId,
        repoId: "repo",
        relPath: "src/promoted.ts",
        contentHash: "b".repeat(64),
        language: "typescript",
        byteSize: 10,
        lastIndexedAt: "2026-07-16T00:00:01.000Z",
      };
      await withWriteConn(async (conn) => {
        await ladybugDb.upsertRepo(conn, {
          repoId: "repo",
          rootPath: root,
          configJson: "{}",
          createdAt: "2026-07-16T00:00:00.000Z",
        });
        await ladybugDb.batchMergeExternalSymbols(conn, "repo", [
          externalSymbolRow(promotedId, "promoted"),
        ]);
        await ladybugDb.createVersion(conn, {
          versionId: "v1",
          repoId: "repo",
          createdAt: "2026-07-16T00:00:00.000Z",
          reason: "verified external baseline",
          prevVersionHash: null,
          versionHash: null,
        });
      });
      const baseline = (await capture(await getLadybugConn(), "repo")) as {
        digest: string;
      };
      const promotedCanonical = JSON.stringify([
        promotedId, "", "", "promoted", "", "function", "typescript",
        0, 0, 0, 0, "scip", promotedId, promotedId,
        "external", true, "scip", promotedId,
      ]);
      await withWriteConn((conn) =>
        ladybugDb.replaceGraphIntegrityManifestInTransaction(conn, "repo", {
          files: [],
          fileless: [{
            stateId: JSON.stringify(["repo", promotedId]),
            repoId: "repo",
            symbolId: promotedId,
            canonicalSymbolJson: promotedCanonical,
            referenceCount: 0,
          }],
        }),
      );
      await derivedState.markGraphIntegrityVerified("repo", "v1", baseline.digest);

      const session = new Session("repo", "incremental", true);
      await session.begin("v2", [fileId]);
      if (transition === "provider") {
        session.applyProviderRows({
          files: [file],
          symbols: [promoted],
          externalSymbols: [],
          edges: [],
          changedFileIds: new Set([fileId]),
        });
      } else {
        session.applyPass1Accumulator({
          symbolMapFileUpdates: new Map([
            [fileId, { fileId, symbols: [{ symbolId: promotedId }] }],
          ]),
          graphIntegrityFiles: new Map([
            [
              file.relPath,
              createFileDigest({
                fileId,
                relPath: file.relPath,
                symbols: [promoted],
              }),
            ],
          ]),
          graphIntegrityFilelessSymbols: new Map(),
          graphIntegrityFilelessReferences: new Map(),
        });
      }
      await withWriteConn(async (conn) => {
        await ladybugDb.deleteProviderReplacementSymbols(
          conn,
          "repo",
          [fileId],
          [promotedId],
        );
        await ladybugDb.upsertFile(conn, file);
        await ladybugDb.upsertKnownFileSymbols(conn, [promoted]);
        await ladybugDb.createVersion(conn, {
          versionId: "v2",
          repoId: "repo",
          createdAt: "2026-07-16T00:00:01.000Z",
          reason: `${transition} promotion`,
          prevVersionHash: null,
          versionHash: null,
        });
      });
      await session.complete("v2");
    });
  }

  it("finalizes fileless expectations from plans before persisted cleanup", () => {
    const importSource = readFileSync(
      join(process.cwd(), "src/indexer/edge-builder/unresolved-imports.ts"),
      "utf8",
    );
    const builtinSource = readFileSync(
      join(process.cwd(), "src/indexer/edge-builder/cleanup.ts"),
      "utf8",
    );
    const finalizeSource = readFileSync(
      join(process.cwd(), "src/indexer/metrics-updater.ts"),
      "utf8",
    );
    const pruneSource = readFileSync(
      join(process.cwd(), "src/db/ladybug-symbols.ts"),
      "utf8",
    );

    assert.ok(
      importSource.indexOf("onPlannedTargetReplacement?.") <
        importSource.indexOf("rewriteResolvedImportEdges("),
    );
    assert.ok(
      builtinSource.indexOf("onPlannedTargetCleanup?.") <
        builtinSource.indexOf("deleteCallEdgesToTargetsByRepo("),
    );
    const preparationIndex = finalizeSource.indexOf(
      "await prepareGraphIntegrityPlaceholderPruning?.(wConn)",
    );
    const pruningIndex = finalizeSource.indexOf(
      "pruneIsolatedPlaceholderSymbols(",
    );
    assert.ok(preparationIndex >= 0, "placeholder preparation call must exist");
    assert.ok(pruningIndex >= 0, "placeholder pruning call must exist");
    assert.ok(preparationIndex < pruningIndex);
    assert.doesNotMatch(pruneSource, /onPruned/);
  });

  it("mirrors the global placeholder-pruning safety boundary", () => {
    const pruningIsSafe = graphIntegrityPlaceholderPruningIsSafe;
    const limit = ladybugDb.LADYBUG_SAFE_SYMBOL_DELETE_ROW_LIMIT;

    assert.equal(pruningIsSafe(2, limit - 2), true);
    assert.equal(
      pruningIsSafe(2, limit - 1),
      false,
      "symbols in other repositories must participate in the safety gate",
    );
  });

  it("does not retain the verified baseline as a second edge graph", () => {
    const integritySource = readFileSync(
      join(
        process.cwd(),
        "src/indexer/provider-first/persisted-graph-integrity.ts",
      ),
      "utf8",
    );
    const querySource = readFileSync(
      join(process.cwd(), "src/db/ladybug-graph-integrity.ts"),
      "utf8",
    );
    const indexerSource = readFileSync(
      join(process.cwd(), "src/indexer/indexer.ts"),
      "utf8",
    );

    assert.doesNotMatch(integritySource, /baselineFileSymbolIds/);
    assert.doesNotMatch(
      integritySource,
      /getPersistedGraphIntegrityFilelessEdgeReferences/,
    );
    assert.doesNotMatch(integritySource, /seedPersistedReferenceCounts/);
    assert.match(integritySource, /listGraphIntegrityFileStates/);
    assert.match(querySource, /count\(\*\) AS referenceCount/);
    assert.match(indexerSource, /isScannedFileChanged\(/);
    assert.match(
      integritySource,
      /getPersistedGraphIntegritySourceReferenceCounts/,
    );
  });

  it("counts symbols in other repositories for the pruning boundary", async () => {
    root = mkdtempSync(join(tmpdir(), "sdl-graph-integrity-multi-repo-"));
    await seedVersionedGraph(root);
    await withWriteConn(async (conn) => {
      await ladybugDb.upsertRepo(conn, {
        repoId: "other",
        rootPath: join(root, "other"),
        configJson: "{}",
        createdAt: "2026-07-16T00:00:00.000Z",
      });
      await ladybugDb.upsertFile(conn, {
        fileId: "other:src/beta.ts",
        repoId: "other",
        relPath: "src/beta.ts",
        contentHash: "b".repeat(64),
        language: "typescript",
        byteSize: 10,
        lastIndexedAt: "2026-07-16T00:00:00.000Z",
      });
      await ladybugDb.upsertKnownFileSymbols(conn, [
        symbolRow({
          symbolId: "sym:beta",
          repoId: "other",
          fileId: "other:src/beta.ts",
          name: "beta",
        }),
      ]);
    });

    const conn = await getLadybugConn();
    assert.equal(
      await ladybugDb.getPersistedGraphIntegrityOtherRepoSymbolCount(
        conn,
        "repo",
      ),
      1,
    );
    assert.equal(
      await ladybugDb.getPersistedGraphIntegrityOtherRepoSymbolCount(
        conn,
        "other",
      ),
      1,
    );
  });

  it("inherits large fileless membership only from a verified incremental baseline", async () => {
    root = mkdtempSync(join(tmpdir(), "sdl-graph-integrity-large-baseline-"));
    await initLadybugDb(join(root, "large-baseline.lbug"));
    const capture = capturePersistedGraphIntegrity;
    const Session = PersistedGraphIntegritySession as unknown as new (
      repoId: string,
      mode: "full" | "incremental",
      enabled: boolean,
    ) => {
      begin: (versionId: string) => Promise<void>;
      prepareForPlaceholderPruning: (conn: unknown) => Promise<boolean>;
      complete: (versionId: string) => Promise<void>;
    };
    const symbolIds = Array.from(
      { length: ladybugDb.LADYBUG_SAFE_SYMBOL_DELETE_ROW_LIMIT + 1 },
      (_, index) => `unresolved:call:stale-${index}`,
    );
    await withWriteConn(async (conn) => {
      await ladybugDb.upsertRepo(conn, {
        repoId: "repo",
        rootPath: root,
        configJson: "{}",
        createdAt: "2026-07-16T00:00:00.000Z",
      });
      await ladybugDb.exec(
        conn,
        `MATCH (r:Repo {repoId: $repoId})
         UNWIND $symbolIds AS symbolId
         CREATE (s:Symbol {
           symbolId: symbolId,
           repoId: $repoId,
           kind: 'unknown',
           name: symbolId,
           language: 'unknown',
           rangeStartLine: 0,
           rangeStartCol: 0,
           rangeEndLine: 0,
           rangeEndCol: 0,
           astFingerprint: symbolId,
           signatureJson: NULL,
           source: 'treesitter',
           scipSymbol: NULL,
           symbolStatus: 'unresolved',
           external: false,
           placeholderKind: 'call',
           placeholderTarget: symbolId
         })-[:SYMBOL_IN_REPO]->(r)`,
        { repoId: "repo", symbolIds },
      );
      await ladybugDb.createVersion(conn, {
        versionId: "v1",
        repoId: "repo",
        createdAt: "2026-07-16T00:00:00.000Z",
        reason: "verified baseline",
        prevVersionHash: null,
        versionHash: null,
      });
    });
    const baseline = (await capture(await getLadybugConn(), "repo")) as {
      digest: string;
    };
    await withWriteConn((conn) =>
      ladybugDb.replaceGraphIntegrityManifestInTransaction(conn, "repo", {
        files: [],
        fileless: symbolIds.map((symbolId) => ({
          stateId: JSON.stringify(["repo", symbolId]),
          repoId: "repo",
          symbolId,
          canonicalSymbolJson: canonicalFilelessJson(symbolId, {
            16: "call",
            17: symbolId,
          }),
          referenceCount: 0,
        })),
      }),
    );
    await derivedState.markGraphIntegrityVerified("repo", "v1", baseline.digest);

    const incremental = new Session("repo", "incremental", true);
    await incremental.begin("v1");
    assert.equal(
      await incremental.prepareForPlaceholderPruning(await getLadybugConn()),
      false,
      "large verified baselines retain inherited placeholders without loading edges",
    );
    await incremental.complete("v1");

    const full = new Session("repo", "full", true);
    await full.begin("v2");
    assert.equal(
      await full.prepareForPlaceholderPruning(await getLadybugConn()),
      true,
      "full expectations remain authoritative instead of inheriting stale rows",
    );
    assert.equal(
      await ladybugDb.pruneIsolatedPlaceholderSymbols(
        await getLadybugConn(),
        "repo",
      ),
      0,
      "Ladybug safety retains the large physical placeholder tail",
    );
    await assert.rejects(
      () => full.complete("v2"),
      /^Error: Persisted graph integrity verification failed$/,
    );
    assert.match(
      graphIntegrityNextBestAction("failed") as string,
      /do not retry refresh automatically/i,
    );
    assert.match(
      graphIntegrityNextBestAction("failed") as string,
      /--safe-rebuild <absolute-new-path>/,
    );
    assert.match(
      graphIntegrityNextBestAction("verifying") as string,
      /Continue using graph reads/,
    );
    assert.doesNotMatch(
      graphIntegrityNextBestAction("verifying") as string,
      /sdl\.index\.refresh|mode:"full"/i,
    );
  });

  it("captures fileless externals and placeholders in the persisted universe", async () => {
    root = mkdtempSync(join(tmpdir(), "sdl-graph-integrity-fileless-"));
    await initLadybugDb(join(root, "fileless.lbug"));
    const capture = capturePersistedGraphIntegrity;
    const expectedRow = symbolRow();
    const unresolvedId = "unresolved:call:__sdl_v1__bWlzc2luZw";

    await withWriteConn(async (conn) => {
      await ladybugDb.upsertRepo(conn, {
        repoId: "repo",
        rootPath: root,
        configJson: "{}",
        createdAt: "2026-07-16T00:00:00.000Z",
      });
      await ladybugDb.upsertFile(conn, {
        fileId: expectedRow.fileId,
        repoId: "repo",
        relPath: "src/alpha.ts",
        contentHash: "a".repeat(64),
        language: "typescript",
        byteSize: 10,
        lastIndexedAt: "2026-07-16T00:00:00.000Z",
      });
      await ladybugDb.upsertKnownFileSymbols(conn, [expectedRow]);
      await ladybugDb.batchMergeExternalSymbols(conn, "repo", [
        {
          symbolId: "external:fixture",
          kind: "class",
          name: "Fixture",
          exported: true,
          language: "external",
          rangeStartLine: 0,
          rangeStartCol: 0,
          rangeEndLine: 0,
          rangeEndCol: 0,
          external: true,
          scipSymbol: "scip-typescript npm fixture 1.0.0 Fixture#",
          source: "scip",
          updatedAt: "2026-07-16T00:00:00.000Z",
        },
      ]);
      await ladybugDb.insertEdges(conn, [
        {
          repoId: "repo",
          fromSymbolId: "sym:alpha",
          toSymbolId: unresolvedId,
          edgeType: "call",
          weight: 0.5,
          confidence: 0.5,
          resolution: "unresolved",
          targetMeta: {
            symbolStatus: "unresolved",
            placeholderKind: "call",
            placeholderTarget: "missing",
          },
          createdAt: "2026-07-16T00:00:00.000Z",
        },
      ]);
    });

    const baseline = (await capture(await getLadybugConn(), "repo")) as {
      symbolCount: number;
      digest: string;
    };
    assert.equal(baseline.symbolCount, 3);
    assert.deepEqual(
      await ladybugDb.getPersistedGraphIntegrityReferenceCountPage(
        await getLadybugConn(),
        { repoId: "repo", limit: 10 },
      ),
      [
        {
          symbolId: unresolvedId,
          edgeType: "call",
          referenceCount: 1,
        },
      ],
    );
    assert.deepEqual(
      await ladybugDb.getPersistedGraphIntegrityFileReferenceCounts(
        await getLadybugConn(),
        "repo",
        [expectedRow.fileId],
      ),
      [
        {
          fileId: expectedRow.fileId,
          symbolId: unresolvedId,
          edgeType: "call",
          referenceCount: 1,
        },
      ],
    );

    await withWriteConn((conn) =>
      ladybugDb.exec(
        conn,
        `MATCH (s:Symbol {symbolId: $symbolId})
         SET s.astFingerprint = 'legacy-provider-hash',
             s.signatureJson = '{"legacy":true}'`,
        { symbolId: "external:fixture" },
      ),
    );
    const compatibleProvider = (await capture(
      await getLadybugConn(),
      "repo",
    )) as { digest: string };
    assert.equal(
      compatibleProvider.digest,
      baseline.digest,
      "definition-derived provider fields normalize without mutating reused rows",
    );

    await withWriteConn((conn) =>
      ladybugDb.exec(
        conn,
        `MATCH (s:Symbol {symbolId: $symbolId})
         SET s.external = false, s.symbolStatus = 'real'`,
        { symbolId: "external:fixture" },
      ),
    );
    const externalCorruption = (await capture(
      await getLadybugConn(),
      "repo",
    )) as { digest: string };
    assert.notEqual(externalCorruption.digest, baseline.digest);

    await withWriteConn((conn) =>
      ladybugDb.exec(
        conn,
        `MATCH (s:Symbol {symbolId: $symbolId})
         SET s.placeholderKind = 'import', s.placeholderTarget = 'changed'`,
        { symbolId: unresolvedId },
      ),
    );
    const placeholderCorruption = (await capture(
      await getLadybugConn(),
      "repo",
    )) as { digest: string };
    assert.notEqual(placeholderCorruption.digest, externalCorruption.digest);
  });

  it("does not auto-fallback after persisted integrity verification fails", () => {
    const source = readFileSync(
      join(process.cwd(), "src/indexer/indexer.ts"),
      "utf8",
    );

    assert.match(
      source,
      /err instanceof ProviderFirstGraphValidationError\s*\|\|\s*err instanceof GraphIntegrityVerificationError/,
    );
  });

  it("keeps large provider-row reuse free of Symbol mutations", () => {
    const source = readFileSync(
      join(process.cwd(), "src/indexer/indexer.ts"),
      "utf8",
    );
    const materializeStart = source.indexOf(
      '"providerFirstMaterialize"',
    );
    const reuseStart = source.indexOf(
      "if (activeMaterializationPlan.reuseExistingProviderRows)",
      materializeStart,
    );
    const materializeEnd = source.indexOf(
      "return withWriteConn(async (conn)",
      reuseStart,
    );
    const reuseBranch = source.slice(reuseStart, materializeEnd);

    assert.match(reuseBranch, /return Promise\.resolve\(\)/);
    assert.doesNotMatch(reuseBranch, /withWriteConn|SET|repair/);
  });

  it("validates no-op integrity before versioning or recovery work", () => {
    const source = readFileSync(
      join(process.cwd(), "src/indexer/indexer.ts"),
      "utf8",
    );
    const branchStart = source.indexOf(
      'if (mode === "incremental" && scanAllFilesUnchanged)',
    );
    const branchEnd = source.indexOf("await graphIntegrity.begin()", branchStart);
    const branch = source.slice(branchStart, branchEnd);
    const validationIndex = branch.indexOf(
      "verifyNoOpIncrementalGraphIntegrity",
    );
    const versioningIndex = branch.indexOf("createOrReuseVersion");

    assert.ok(validationIndex >= 0, "no-op branch must validate persisted integrity");
    assert.ok(
      versioningIndex < 0 || validationIndex < versioningIndex,
      "no-op integrity validation must run before any version creation",
    );
  });

  it("rejects an unknown no-op integrity baseline", async () => {
    root = mkdtempSync(join(tmpdir(), "sdl-graph-integrity-noop-unknown-"));
    await seedVersionedGraph(root);
    const verifyNoOp = verifyNoOpIncrementalGraphIntegrity;

    await assert.rejects(
      verifyNoOp("repo"),
      /Incremental indexing requires a verified graph integrity baseline.*--safe-rebuild/i,
    );
    assert.equal((await ladybugDb.getLatestVersion(await getLadybugConn(), "repo"))?.versionId, "v1");
  });

  it("rejects a failed no-op integrity baseline", async () => {
    root = mkdtempSync(join(tmpdir(), "sdl-graph-integrity-noop-failed-"));
    await seedVersionedGraph(root);
    const verifyNoOp = verifyNoOpIncrementalGraphIntegrity;
    await derivedState.markGraphIntegrityVerified(
      "repo",
      "v1",
      "a".repeat(64),
    );
    assert.equal(
      await derivedState.markCurrentGraphIntegrityRevisionFailed("repo", "v1", 0, "failed"),
      true,
    );

    await assert.rejects(
      verifyNoOp("repo"),
      /Incremental indexing requires a verified graph integrity baseline.*--safe-rebuild/i,
    );
  });

  it("rejects a corrupt no-op graph and records failed state", async () => {
    root = mkdtempSync(join(tmpdir(), "sdl-graph-integrity-noop-corrupt-"));
    await seedVersionedGraph(root);
    const verifyNoOp = verifyNoOpIncrementalGraphIntegrity;
    const capture = capturePersistedGraphIntegrity;
    const baseline = (await capture(await getLadybugConn(), "repo")) as {
      digest: string;
    };
    await derivedState.markGraphIntegrityVerified("repo", "v1", baseline.digest);
    await withWriteConn((conn) =>
      ladybugDb.exec(
        conn,
        `MATCH (s:Symbol {symbolId: 'sym:alpha'})
         SET s.signatureJson = '{"name":"corrupted"}'`,
      ),
    );

    await assert.rejects(
      verifyNoOp("repo"),
      /^Error: Persisted graph integrity verification failed$/,
    );
    const state = await derivedState.getDerivedState("repo");
    assert.equal(state?.graphIntegrityState, "failed");
    assert.equal(state?.graphIntegrityVersionId, "v1");
    assert.equal(state?.graphIntegrityRevision, 0);
    assert.equal(state?.graphIntegrityVerifiedRevision, 0);
    assert.equal(state?.graphIntegrityDigest, baseline.digest);
  });

  it("fails a corrupt unrevisioned verification without erasing its baseline", async () => {
    root = mkdtempSync(join(tmpdir(), "sdl-graph-integrity-unrevisioned-failure-"));
    await seedVersionedGraph(root);
    const complete = completeGraphIntegrityVerification;
    const capture = capturePersistedGraphIntegrity;
    const expected = await capture(await getLadybugConn(), "repo");
    const digest = "9".repeat(64);
    await withWriteConn(async (conn) => {
      await derivedState.beginGraphIntegrityVersion(
        conn,
        "repo",
        "v1",
        digest,
        false,
      );
      await ladybugDb.exec(
        conn,
        `MATCH (d:DerivedState {repoId: 'repo'})
         SET d.graphIntegrityState = 'verifying',
             d.graphIntegrityRevision = NULL,
             d.graphIntegrityVerifiedRevision = 7`,
      );
      await ladybugDb.exec(
        conn,
        `MATCH (s:Symbol {symbolId: 'sym:alpha'})
         SET s.signatureJson = '{"name":"corrupted"}'`,
      );
    });

    await assert.rejects(
      complete("repo", "v1", expected),
      /^Error: Persisted graph integrity verification failed$/,
    );
    const state = await derivedState.getDerivedState("repo");
    assert.equal(state?.graphIntegrityState, "failed");
    assert.equal(state?.graphIntegrityVersionId, "v1");
    assert.equal(state?.graphIntegrityRevision, null);
    assert.equal(state?.graphIntegrityVerifiedRevision, 7);
    assert.equal(state?.graphIntegrityDigest, digest);
    assert.equal(state?.graphIntegrityFilelessPruningSupported, false);
    assert.ok(String(state?.graphIntegrityError).length <= 1024);
  });

  it("does not let a stale no-op mismatch poison a newer Version revision", async () => {
    root = mkdtempSync(join(tmpdir(), "sdl-graph-integrity-noop-race-"));
    await seedVersionedGraph(root);
    const verifyNoOp = verifyNoOpIncrementalGraphIntegrity;
    const capture = capturePersistedGraphIntegrity;
    const baseline = (await capture(await getLadybugConn(), "repo")) as {
      digest: string;
    };
    await derivedState.markGraphIntegrityVerified("repo", "v1", baseline.digest);
    await withWriteConn((conn) =>
      ladybugDb.exec(
        conn,
        `MATCH (s:Symbol {symbolId: 'sym:alpha'})
         SET s.signatureJson = '{"name":"corrupted"}'`,
      ),
    );

    await assert.rejects(
      verifyNoOp("repo", {
        afterCapture: async () => {
          await withWriteConn(async (conn) => {
            await ladybugDb.createVersion(conn, {
              versionId: "v2",
              repoId: "repo",
              createdAt: "2026-07-17T00:00:00.000Z",
              reason: "test-race",
              prevVersionHash: null,
              versionHash: null,
            });
            await derivedState.beginGraphIntegrityVersion(
              conn,
              "repo",
              "v2",
              "b".repeat(64),
              true,
            );
            assert.equal(
              await derivedState.advanceGraphIntegrityRevisionInTransaction(
                conn,
                "repo",
                "v2",
                0,
              ),
              1,
            );
          });
          assert.equal(
            await derivedState.markGraphIntegrityVerifiedIfVerifying(
              "repo",
              "v2",
              1,
              "b".repeat(64),
            ),
            true,
          );
        },
      }),
      /^Error: Persisted graph integrity verification failed$/,
    );

    const state = await derivedState.getDerivedState("repo");
    assert.equal(state?.graphIntegrityState, "verified");
    assert.equal(state?.graphIntegrityVersionId, "v2");
    assert.equal(state?.graphIntegrityRevision, 1);
    assert.equal(state?.graphIntegrityVerifiedRevision, 1);
    assert.equal(state?.graphIntegrityDigest, "b".repeat(64));
    assert.equal(
      (await ladybugDb.getLatestVersion(await getLadybugConn(), "repo"))
        ?.versionId,
      "v2",
    );
  });

  it("accepts a verified clean no-op without creating a version", async () => {
    root = mkdtempSync(join(tmpdir(), "sdl-graph-integrity-noop-clean-"));
    await seedVersionedGraph(root);
    const verifyNoOp = verifyNoOpIncrementalGraphIntegrity;
    const capture = capturePersistedGraphIntegrity;
    const baseline = (await capture(await getLadybugConn(), "repo")) as {
      digest: string;
    };
    await derivedState.markGraphIntegrityVerified("repo", "v1", baseline.digest);

    assert.equal(await verifyNoOp("repo"), "v1");
    const versionCount = await ladybugDb.querySingle<{ count: unknown }>(
      await getLadybugConn(),
      `MATCH (v:Version)-[:VERSION_OF_REPO]->(:Repo {repoId: $repoId})
       RETURN count(v) AS count`,
      { repoId: "repo" },
    );
    assert.equal(ladybugDb.toNumber(versionCount?.count ?? 0), 1);
  });

  it("keeps mismatch diagnostics deterministic and bounded", () => {
    const createFileDigest = createGraphIntegrityFileDigest;
    const createExpectation = createGraphIntegrityExpectation;
    const compare = compareGraphIntegrityExpectations;
    const longValue = "x".repeat(4_096);
    const expected = createExpectation([
      createFileDigest({
        fileId: `repo:${longValue}`,
        relPath: `src/${longValue}.ts`,
        symbols: [symbolRow({ fileId: `repo:${longValue}` })],
      }),
    ]);
    const actual = createExpectation([
      createFileDigest({
        fileId: `repo:${longValue}`,
        relPath: `src/${longValue}.ts`,
        symbols: [symbolRow({
          fileId: `repo:${longValue}`,
          signatureJson: '{"name":"changed"}',
        })],
      }),
    ]);

    const first = compare(expected, actual);
    const second = compare(expected, actual);
    const serialized = JSON.stringify(first);

    assert.deepEqual(first, second);
    assert.ok(first, "a changed canonical tuple must mismatch");
    assert.ok(serialized.length <= 2_048, serialized);
    assert.doesNotMatch(serialized, new RegExp(longValue));
  });

  it("persists verifying, verified, and failed transitions", async () => {
    root = mkdtempSync(join(tmpdir(), "sdl-graph-integrity-state-"));
    await initLadybugDb(join(root, "state.lbug"));
    const markVerifying = markGraphIntegrityVerifying;
    const markVerified = markGraphIntegrityVerified;
    const markFailed = markUnrevisionedGraphIntegrityFailedIfVerifying;

    await markVerifying("repo", "v1");
    let row = await derivedState.getDerivedState("repo");
    assert.equal(row?.graphIntegrityState, "verifying");
    assert.equal(row?.graphIntegrityVersionId, "v1");
    assert.equal(row?.graphIntegrityDigest, null);
    assert.equal(row?.graphIntegrityError, null);

    await markVerified("repo", "v1", "a".repeat(64));
    row = await derivedState.getDerivedState("repo");
    assert.equal(row?.graphIntegrityState, "verified");
    assert.equal(row?.graphIntegrityVersionId, "v1");
    assert.equal(row?.graphIntegrityDigest, "a".repeat(64));
    assert.equal(row?.graphIntegrityError, null);

    await markVerifying("repo", "v2");
    assert.equal(
      await markFailed("repo", "v2", "sensitive ".repeat(300)),
      true,
    );
    row = await derivedState.getDerivedState("repo");
    assert.equal(row?.graphIntegrityState, "failed");
    assert.equal(row?.graphIntegrityVersionId, "v2");
    assert.equal(row?.graphIntegrityDigest, "a".repeat(64));
    assert.equal(row?.graphIntegrityRevision, null);
    assert.equal(row?.graphIntegrityVerifiedRevision, 0);
    assert.ok((row?.graphIntegrityError?.length ?? 0) <= 1_024);
  });

  it("publishes failure only while the same verification owns state", async () => {
    root = mkdtempSync(join(tmpdir(), "sdl-graph-integrity-failure-cas-"));
    await initLadybugDb(join(root, "failure-cas.lbug"));
    const markVerifying = markGraphIntegrityVerifying;
    const markFailedIfVerifying = markGraphIntegrityFailedIfVerifying;

    await derivedState.markGraphIntegrityVerified(
      "repo",
      "v0",
      "a".repeat(64),
    );
    await markVerifying("repo", "v0");
    assert.equal(
      await markFailedIfVerifying("repo", "v2", 0, "stale failure"),
      false,
    );
    let row = await derivedState.getDerivedState("repo");
    assert.equal(row?.graphIntegrityState, "verifying");
    assert.equal(row?.graphIntegrityVersionId, "v0");
    assert.equal(row?.graphIntegrityError, null);

    assert.equal(
      await markFailedIfVerifying("repo", "v0", 0, "owned failure"),
      true,
    );
    row = await derivedState.getDerivedState("repo");
    assert.equal(row?.graphIntegrityState, "failed");
    assert.equal(row?.graphIntegrityVersionId, "v0");
    assert.equal(row?.graphIntegrityDigest, "a".repeat(64));
    assert.equal(row?.graphIntegrityVerifiedRevision, 0);
    assert.equal(row?.graphIntegrityError, "owned failure");
  });

  it("registers cleanup without a read after marking verification active", async () => {
    root = mkdtempSync(join(tmpdir(), "sdl-graph-integrity-begin-read-fault-"));
    await initLadybugDb(join(root, "begin-read-fault.lbug"));
    const Session = PersistedGraphIntegritySession as unknown as new (
      repoId: string,
      mode: "full" | "incremental",
      enabled: boolean,
    ) => {
      begin: (versionId: string) => Promise<void>;
    };
    const hasActive = hasActiveGraphIntegrityVerification;
    const failActive = failActiveGraphIntegrityVerification;
    const readConnections = await Promise.all([
      getLadybugConn(),
      getLadybugConn(),
      getLadybugConn(),
      getLadybugConn(),
    ]);
    const originalPrepare = readConnections.map((conn) => conn.prepare);
    for (const conn of readConnections) {
      conn.prepare = async () => {
        throw new Error("injected read failure");
      };
    }

    const session = new Session("repo", "full", true);
    try {
      await assert.doesNotReject(() => session.begin("v1"));
    } finally {
      readConnections.forEach((conn, index) => {
        conn.prepare = originalPrepare[index];
      });
    }
    assert.equal(hasActive("repo"), true);
    await failActive("repo");

    const row = await derivedState.getDerivedState("repo");
    assert.equal(row?.graphIntegrityState, "failed");
    assert.equal(row?.graphIntegrityVersionId, "v1");
    assert.equal(row?.graphIntegrityRevision, null);
  });

  it("marks an aborted unrevisioned verification failed without clearing its baseline", async () => {
    root = mkdtempSync(join(tmpdir(), "sdl-graph-integrity-abort-null-revision-"));
    await initLadybugDb(join(root, "abort-null-revision.lbug"));
    const Session = PersistedGraphIntegritySession as unknown as new (
      repoId: string,
      mode: "full" | "incremental",
      enabled: boolean,
    ) => {
      begin: (versionId: string) => Promise<void>;
    };
    const failActive = failActiveGraphIntegrityVerification;
    const conn = await getLadybugConn();
    const digest = "8".repeat(64);
    await derivedState.beginGraphIntegrityVersion(
      conn,
      "repo",
      "v1",
      digest,
      false,
    );
    await ladybugDb.exec(
      conn,
      `MATCH (d:DerivedState {repoId: 'repo'})
       SET d.graphIntegrityRevision = NULL,
           d.graphIntegrityVerifiedRevision = 7`,
    );

    const session = new Session("repo", "full", true);
    await session.begin("v1");
    await failActive("repo");

    const row = await derivedState.getDerivedState("repo");
    assert.equal(row?.graphIntegrityState, "failed");
    assert.equal(row?.graphIntegrityVersionId, "v1");
    assert.equal(row?.graphIntegrityRevision, null);
    assert.equal(row?.graphIntegrityVerifiedRevision, 7);
    assert.equal(row?.graphIntegrityDigest, digest);
    assert.equal(row?.graphIntegrityFilelessPruningSupported, false);
    assert.equal(
      row?.graphIntegrityError,
      "Persisted graph integrity verification did not complete",
    );
    assert.ok(String(row?.graphIntegrityError).length <= 1024);
  });

  it("active verification cleanup preserves invalidated state", async () => {
    root = mkdtempSync(join(tmpdir(), "sdl-graph-integrity-cleanup-cas-"));
    await initLadybugDb(join(root, "cleanup-cas.lbug"));
    const Session = PersistedGraphIntegritySession as unknown as new (
      repoId: string,
      mode: "full" | "incremental",
      enabled: boolean,
    ) => {
      begin: (versionId: string) => Promise<void>;
    };
    const failActive = failActiveGraphIntegrityVerification;
    const invalidate = invalidateGraphIntegrity;

    const session = new Session("repo", "full", true);
    await session.begin("v1");
    await withWriteConn((conn) =>
      ladybugDb.withTransaction(conn, (txConn) =>
        invalidate(txConn, "repo"),
      ),
    );
    await failActive("repo");

    const row = await derivedState.getDerivedState("repo");
    assert.equal(row?.graphIntegrityState, "unknown");
    assert.equal(row?.graphIntegrityVersionId, null);
    assert.equal(row?.graphIntegrityDigest, null);
    assert.equal(row?.graphIntegrityError, null);
  });

  it("normalizes legacy persistence defaults identically on both sides", async () => {
    root = mkdtempSync(join(tmpdir(), "sdl-graph-integrity-defaults-"));
    await initLadybugDb(join(root, "defaults.lbug"));
    const createFileDigest = createGraphIntegrityFileDigest;
    const createExpectation = createGraphIntegrityExpectation;
    const capture = capturePersistedGraphIntegrity;
    const compare = compareGraphIntegrityExpectations;
    const expectedRow = symbolRow({
      source: undefined,
      summarySource: undefined,
      symbolStatus: undefined,
      external: undefined,
      placeholderKind: undefined,
      placeholderTarget: undefined,
    });
    const expected = createExpectation([
      createFileDigest({
        fileId: expectedRow.fileId,
        relPath: "src/alpha.ts",
        symbols: [expectedRow],
      }),
    ]);

    await withWriteConn(async (conn) => {
      await ladybugDb.upsertRepo(conn, {
        repoId: "repo",
        rootPath: root,
        configJson: "{}",
        createdAt: "2026-07-16T00:00:00.000Z",
      });
      await ladybugDb.upsertFile(conn, {
        fileId: expectedRow.fileId,
        repoId: "repo",
        relPath: "src/alpha.ts",
        contentHash: "a".repeat(64),
        language: "typescript",
        byteSize: 10,
        lastIndexedAt: "2026-07-16T00:00:00.000Z",
      });
      await ladybugDb.upsertKnownFileSymbols(conn, [expectedRow]);
    });

    const actual = await capture(await getLadybugConn(), "repo");
    assert.equal(compare(expected, actual), null);
  });

  it("fails verification and records failed state on a persisted tuple mismatch", async () => {
    root = mkdtempSync(join(tmpdir(), "sdl-graph-integrity-mismatch-"));
    await initLadybugDb(join(root, "mismatch.lbug"));
    const createFileDigest = createGraphIntegrityFileDigest;
    const createExpectation = createGraphIntegrityExpectation;
    const complete = completeGraphIntegrityVerification;
    const markVerifying = markGraphIntegrityVerifying;
    const expectedRow = symbolRow();
    const expected = createExpectation([
      createFileDigest({
        fileId: expectedRow.fileId,
        relPath: "src/alpha.ts",
        symbols: [expectedRow],
      }),
    ]);

    await withWriteConn(async (conn) => {
      await ladybugDb.upsertRepo(conn, {
        repoId: "repo",
        rootPath: root,
        configJson: "{}",
        createdAt: "2026-07-16T00:00:00.000Z",
      });
      await ladybugDb.upsertFile(conn, {
        fileId: expectedRow.fileId,
        repoId: "repo",
        relPath: "src/alpha.ts",
        contentHash: "a".repeat(64),
        language: "typescript",
        byteSize: 10,
        lastIndexedAt: "2026-07-16T00:00:00.000Z",
      });
      await ladybugDb.upsertKnownFileSymbols(conn, [
        symbolRow({ signatureJson: '{"name":"corrupted"}' }),
      ]);
    });
    await withWriteConn(async (conn) => {
      await ladybugDb.createVersion(conn, {
        versionId: "v1",
        repoId: "repo",
        createdAt: "2026-07-16T00:00:00.000Z",
        reason: "test-verification",
        prevVersionHash: null,
        versionHash: null,
      });
      await derivedState.beginGraphIntegrityVersion(
        conn,
        "repo",
        "v1",
        "a".repeat(64),
        true,
      );
    });
    await markVerifying("repo", "v1");

    await assert.rejects(
      complete("repo", "v1", expected),
      /^Error: Persisted graph integrity verification failed$/,
    );
    const row = await derivedState.getDerivedState("repo");
    assert.equal(row?.graphIntegrityState, "failed");
    assert.equal(row?.graphIntegrityVersionId, "v1");
    assert.equal(
      row?.graphIntegrityError,
      "Persisted graph integrity verification failed",
    );
  });

  it("keeps the public error generic when recording failed state also rejects", async () => {
    root = mkdtempSync(join(tmpdir(), "sdl-graph-integrity-state-error-"));
    await initLadybugDb(join(root, "state-error.lbug"));
    const createFileDigest = createGraphIntegrityFileDigest;
    const createExpectation = createGraphIntegrityExpectation;
    const complete = completeGraphIntegrityVerification;
    const expectedRow = symbolRow();
    const expected = createExpectation([
      createFileDigest({
        fileId: expectedRow.fileId,
        relPath: "src/alpha.ts",
        symbols: [expectedRow],
      }),
    ]);

    await withWriteConn(async (conn) => {
      await ladybugDb.upsertRepo(conn, {
        repoId: "repo",
        rootPath: root,
        configJson: "{}",
        createdAt: "2026-07-16T00:00:00.000Z",
      });
      await ladybugDb.upsertFile(conn, {
        fileId: expectedRow.fileId,
        repoId: "repo",
        relPath: "src/alpha.ts",
        contentHash: "a".repeat(64),
        language: "typescript",
        byteSize: 10,
        lastIndexedAt: "2026-07-16T00:00:00.000Z",
      });
      await ladybugDb.upsertKnownFileSymbols(conn, [
        symbolRow({ signatureJson: '{"name":"corrupted"}' }),
      ]);
    });

    await withWriteConn(async (conn) => {
      await ladybugDb.createVersion(conn, {
        versionId: "v1",
        repoId: "repo",
        createdAt: "2026-07-16T00:00:00.000Z",
        reason: "test-verification",
        prevVersionHash: null,
        versionHash: null,
      });
      await derivedState.beginGraphIntegrityVersion(
        conn,
        "repo",
        "v1",
        "a".repeat(64),
        true,
      );
    });
    await derivedState.markGraphIntegrityVerifying("repo", "v1");

    let stateWriteAttempted = false;
    await assert.rejects(
      () =>
        complete("repo", "v1", expected, {
          persistFailureState: async () => {
            stateWriteAttempted = true;
            throw new Error("sensitive failure-state write error");
          },
        }),
      (error: unknown) =>
        error instanceof Error &&
        error.message === "Persisted graph integrity verification failed",
    );
    assert.equal(stateWriteAttempted, true);
  });

  it("preserves unknown state when invalidation wins the verification race", async () => {
    root = mkdtempSync(join(tmpdir(), "sdl-graph-integrity-publish-race-"));
    await initLadybugDb(join(root, "publish-race.lbug"));
    const createFileDigest = createGraphIntegrityFileDigest;
    const createExpectation = createGraphIntegrityExpectation;
    const complete = completeGraphIntegrityVerification;
    const markVerifying = markGraphIntegrityVerifying;
    const invalidate = invalidateGraphIntegrity;
    const expectedRow = symbolRow({ source: undefined });
    const expected = createExpectation([
      createFileDigest({
        fileId: expectedRow.fileId,
        relPath: "src/alpha.ts",
        symbols: [expectedRow],
      }),
    ]);

    await withWriteConn(async (conn) => {
      await ladybugDb.upsertRepo(conn, {
        repoId: "repo",
        rootPath: root,
        configJson: "{}",
        createdAt: "2026-07-16T00:00:00.000Z",
      });
      await ladybugDb.upsertFile(conn, {
        fileId: expectedRow.fileId,
        repoId: "repo",
        relPath: "src/alpha.ts",
        contentHash: "a".repeat(64),
        language: "typescript",
        byteSize: 10,
        lastIndexedAt: "2026-07-16T00:00:00.000Z",
      });
      await ladybugDb.upsertKnownFileSymbols(conn, [expectedRow]);
    });
    await markVerifying("repo", "v1");

    let captureReachedResolve!: () => void;
    const captureReached = new Promise<void>((resolve) => {
      captureReachedResolve = resolve;
    });
    let releasePublishResolve!: () => void;
    const releasePublish = new Promise<void>((resolve) => {
      releasePublishResolve = resolve;
    });
    const verification = complete("repo", "v1", expected, {
      afterCapture: async () => {
        captureReachedResolve();
        await releasePublish;
      },
    });
    const firstPhase = await Promise.race([
      captureReached.then(() => "captured" as const),
      verification.then(() => "published" as const),
    ]);
    assert.equal(firstPhase, "captured");

    await withWriteConn((conn) =>
      ladybugDb.withTransaction(conn, (txConn) =>
        invalidate(txConn, "repo"),
      ),
    );
    releasePublishResolve();
    await assert.rejects(
      verification,
      /^Error: Persisted graph integrity verification failed$/,
    );

    const row = await derivedState.getDerivedState("repo");
    assert.equal(row?.graphIntegrityState, "unknown");
    assert.equal(row?.graphIntegrityVersionId, null);
    assert.equal(row?.graphIntegrityDigest, null);
    assert.equal(row?.graphIntegrityError, null);
  });

  it("preserves a newer verified version when stale verification resumes", async () => {
    root = mkdtempSync(join(tmpdir(), "sdl-graph-integrity-newer-race-"));
    await initLadybugDb(join(root, "newer-race.lbug"));
    const createFileDigest = createGraphIntegrityFileDigest;
    const createExpectation = createGraphIntegrityExpectation;
    const complete = completeGraphIntegrityVerification;
    const markVerifying = markGraphIntegrityVerifying;
    const markVerified = markGraphIntegrityVerified;
    const expectedRow = symbolRow({ source: undefined });
    const expected = createExpectation([
      createFileDigest({
        fileId: expectedRow.fileId,
        relPath: "src/alpha.ts",
        symbols: [expectedRow],
      }),
    ]);

    await withWriteConn(async (conn) => {
      await ladybugDb.upsertRepo(conn, {
        repoId: "repo",
        rootPath: root,
        configJson: "{}",
        createdAt: "2026-07-16T00:00:00.000Z",
      });
      await ladybugDb.upsertFile(conn, {
        fileId: expectedRow.fileId,
        repoId: "repo",
        relPath: "src/alpha.ts",
        contentHash: "a".repeat(64),
        language: "typescript",
        byteSize: 10,
        lastIndexedAt: "2026-07-16T00:00:00.000Z",
      });
      await ladybugDb.upsertKnownFileSymbols(conn, [expectedRow]);
    });
    await markVerifying("repo", "v1");

    let captureReachedResolve!: () => void;
    const captureReached = new Promise<void>((resolve) => {
      captureReachedResolve = resolve;
    });
    let releasePublishResolve!: () => void;
    const releasePublish = new Promise<void>((resolve) => {
      releasePublishResolve = resolve;
    });
    const verification = complete("repo", "v1", expected, {
      afterCapture: async () => {
        captureReachedResolve();
        await releasePublish;
      },
    });
    const firstPhase = await Promise.race([
      captureReached.then(() => "captured" as const),
      verification.then(() => "published" as const),
    ]);
    assert.equal(firstPhase, "captured");

    await markVerifying("repo", "v2");
    await markVerified("repo", "v2", "b".repeat(64));
    releasePublishResolve();
    await assert.rejects(
      verification,
      /^Error: Persisted graph integrity verification failed$/,
    );

    const row = await derivedState.getDerivedState("repo");
    assert.equal(row?.graphIntegrityState, "verified");
    assert.equal(row?.graphIntegrityVersionId, "v2");
    assert.equal(row?.graphIntegrityDigest, "b".repeat(64));
    assert.equal(row?.graphIntegrityError, null);
  });

  it("requires verified integrity for the latest graph version", () => {
    const isVerified = graphIntegrityIsVerifiedForVersion;
    const base = {
      repoId: "repo",
      clustersDirty: false,
      processesDirty: false,
      algorithmsDirty: false,
      summariesDirty: false,
      embeddingsDirty: false,
      targetVersionId: "v2",
      computedVersionId: "v2",
      updatedAt: null,
      lastError: null,
      graphIntegrityVersionId: "v2",
      graphIntegrityDigest: "a".repeat(64),
      graphIntegrityError: null,
      graphIntegrityRevision: 0,
      graphIntegrityVerifiedRevision: 0,
      graphIntegrityFilelessPruningSupported: true,
      graphIntegrityManifestEstablished: true,
    };

    assert.equal(
      isVerified({ ...base, graphIntegrityState: "unknown" }, "v2"),
      false,
    );
    assert.equal(
      isVerified({ ...base, graphIntegrityState: "verifying" }, "v2"),
      false,
    );
    assert.equal(
      isVerified({ ...base, graphIntegrityState: "failed" }, "v2"),
      false,
    );
    assert.equal(
      isVerified({ ...base, graphIntegrityState: "verified" }, "v3"),
      false,
    );
    assert.equal(
      isVerified({ ...base, graphIntegrityState: "verified" }, "v2"),
      true,
    );
    assert.equal(
      isVerified(
        {
          ...base,
          graphIntegrityState: "verified",
          graphIntegrityManifestEstablished: false,
        },
        "v2",
      ),
      false,
    );
  });

  it("rejects incremental indexing without established manifest ownership", async () => {
    root = mkdtempSync(join(tmpdir(), "sdl-integrity-missing-manifest-"));
    await initLadybugDb(join(root, "missing-manifest.lbug"));
    const emptyDigest = createGraphIntegrityExpectationFromManifest([], []).digest;
    await withWriteConn(async (conn) => {
      await ladybugDb.upsertRepo(conn, {
        repoId: "repo",
        rootPath: root,
        configJson: "{}",
        createdAt: "2026-07-21T00:00:00.000Z",
      });
      await ladybugDb.createVersion(conn, {
        versionId: "v1",
        repoId: "repo",
        createdAt: "2026-07-21T00:00:00.000Z",
        reason: "legacy verified state",
        prevVersionHash: null,
        versionHash: null,
      });
      await derivedState.beginGraphIntegrityVersion(
        conn,
        "repo",
        "v1",
        emptyDigest,
        true,
      );
    });
    await derivedState.markGraphIntegrityVerified("repo", "v1", emptyDigest);
    assert.equal(
      (await derivedState.getDerivedState("repo"))
        ?.graphIntegrityManifestEstablished,
      false,
    );

    const Session = PersistedGraphIntegritySession as unknown as new (
      repoId: string,
      mode: "full" | "incremental",
      enabled: boolean,
    ) => {
      begin: (versionId: string) => Promise<void>;
    };
    await assert.rejects(
      new Session("repo", "incremental", true).begin("v2"),
      /Incremental indexing requires a verified graph integrity baseline/,
    );
  });

  it("does not let stale synchronous completion adopt a newer revision", async () => {
    root = mkdtempSync(join(tmpdir(), "sdl-integrity-stale-sync-complete-"));
    await initLadybugDb(join(root, "stale-sync-complete.lbug"));
    await withWriteConn((conn) =>
      ladybugDb.upsertRepo(conn, {
        repoId: "repo",
        rootPath: root,
        configJson: "{}",
        createdAt: "2026-07-21T00:00:00.000Z",
      }),
    );

    const Session = PersistedGraphIntegritySession as unknown as new (
      repoId: string,
      mode: "full" | "incremental",
      enabled: boolean,
    ) => {
      begin: (versionId: string) => Promise<void>;
      stageManifest: (versionId: string) => Promise<number | undefined>;
      complete: (versionId: string) => Promise<void>;
    };
    const session = new Session("repo", "full", true);
    await session.begin("v1");
    assert.equal(await session.stageManifest("v1"), 0);
    assert.equal(
      await withWriteConn((conn) =>
        derivedState.advanceGraphIntegrityRevisionInTransaction(
          conn,
          "repo",
          "v1",
          0,
        ),
      ),
      1,
    );

    await assert.rejects(
      session.complete("v1"),
      /^Error: Persisted graph integrity verification failed$/,
    );
    const state = await derivedState.getDerivedState("repo");
    assert.equal(state?.graphIntegrityState, "verifying");
    assert.equal(state?.graphIntegrityVersionId, "v1");
    assert.equal(state?.graphIntegrityRevision, 1);
    assert.equal(state?.graphIntegrityVerifiedRevision, null);
    assert.equal(state?.graphIntegrityError, null);
  });

  it("preserves the winning manifest when a full session loses version ownership", async () => {
    root = mkdtempSync(join(tmpdir(), "sdl-integrity-full-lost-cas-"));
    await initLadybugDb(join(root, "full-lost-cas.lbug"));
    await withWriteConn((conn) =>
      ladybugDb.upsertRepo(conn, {
        repoId: "repo",
        rootPath: root,
        configJson: "{}",
        createdAt: "2026-07-21T00:00:00.000Z",
      }),
    );

    const Session = PersistedGraphIntegritySession as unknown as new (
      repoId: string,
      mode: "full" | "incremental",
      enabled: boolean,
    ) => {
      begin: (versionId: string) => Promise<void>;
      applyFile: (file: Record<string, unknown>) => void;
      stageManifest: (versionId: string) => Promise<number | undefined>;
    };
    const stale = new Session("repo", "full", true);
    await stale.begin("stale-v1");
    stale.applyFile(
      createGraphIntegrityFileDigest({
        fileId: "repo:src/stale.ts",
        relPath: "src/stale.ts",
        symbols: [],
      }) as Record<string, unknown>,
    );

    const winnerManifest = {
      files: [
        createGraphIntegrityFileState(
          "repo",
          "repo:src/winner.ts",
          "src/winner.ts",
          [],
          [],
        ),
      ],
      fileless: [{
        stateId: JSON.stringify(["repo", "winner:fileless"]),
        repoId: "repo",
        symbolId: "winner:fileless",
        canonicalSymbolJson: canonicalFilelessJson("winner:fileless"),
        referenceCount: 1,
      }],
    };
    await withWriteConn((conn) =>
      ladybugDb.withTransaction(conn, async (txConn) => {
        await ladybugDb.createVersion(txConn, {
          versionId: "winner-v1",
          repoId: "repo",
          createdAt: "2026-07-21T00:00:01.000Z",
          reason: "winning full index",
          prevVersionHash: null,
          versionHash: null,
        });
        await ladybugDb.replaceGraphIntegrityManifestInTransaction(
          txConn,
          "repo",
          winnerManifest,
        );
        await derivedState.beginGraphIntegrityVersion(
          txConn,
          "repo",
          "winner-v1",
          "a".repeat(64),
          true,
        );
      }),
    );

    const winnerSnapshot = await Promise.all([
      derivedState.getDerivedState("repo"),
      ladybugDb.listGraphIntegrityFileStates(await getLadybugConn(), "repo"),
      ladybugDb.listGraphIntegrityFilelessStates(await getLadybugConn(), "repo"),
    ]);
    try {
      await assert.rejects(
        stale.stageManifest("stale-v1"),
        GraphIntegrityVerificationError,
      );
      const afterStaleStage = await Promise.all([
        derivedState.getDerivedState("repo"),
        ladybugDb.listGraphIntegrityFileStates(await getLadybugConn(), "repo"),
        ladybugDb.listGraphIntegrityFilelessStates(await getLadybugConn(), "repo"),
      ]);
      assert.deepEqual(afterStaleStage, winnerSnapshot);
    } finally {
      await failActiveGraphIntegrityVerification("repo");
    }
    assert.equal(hasActiveGraphIntegrityVerification("repo"), false);
  });

  it("preserves the winning manifest when an incremental session loses revision ownership", async () => {
    root = mkdtempSync(join(tmpdir(), "sdl-integrity-incremental-lost-cas-"));
    await initLadybugDb(join(root, "incremental-lost-cas.lbug"));
    const emptyDigest = createGraphIntegrityExpectationFromManifest([], []).digest;
    await withWriteConn(async (conn) => {
      await ladybugDb.upsertRepo(conn, {
        repoId: "repo",
        rootPath: root,
        configJson: "{}",
        createdAt: "2026-07-21T00:00:00.000Z",
      });
      await ladybugDb.createVersion(conn, {
        versionId: "v1",
        repoId: "repo",
        createdAt: "2026-07-21T00:00:00.000Z",
        reason: "baseline",
        prevVersionHash: null,
        versionHash: null,
      });
      await ladybugDb.replaceGraphIntegrityManifestInTransaction(conn, "repo", {
        files: [],
        fileless: [],
      });
      await derivedState.beginGraphIntegrityVersion(
        conn,
        "repo",
        "v1",
        emptyDigest,
        true,
      );
    });

    const Session = PersistedGraphIntegritySession as unknown as new (
      repoId: string,
      mode: "full" | "incremental",
      enabled: boolean,
    ) => {
      begin: (versionId: string) => Promise<void>;
      applyFile: (file: Record<string, unknown>) => void;
      stageManifest: (versionId: string) => Promise<number | undefined>;
    };
    const stale = new Session("repo", "incremental", true);
    await stale.begin("v1");
    stale.applyFile(
      createGraphIntegrityFileDigest({
        fileId: "repo:src/stale.ts",
        relPath: "src/stale.ts",
        symbols: [],
      }) as Record<string, unknown>,
    );

    const winnerManifest = {
      files: [
        createGraphIntegrityFileState(
          "repo",
          "repo:src/winner.ts",
          "src/winner.ts",
          [],
          [],
        ),
      ],
      fileless: [{
        stateId: JSON.stringify(["repo", "winner:fileless"]),
        repoId: "repo",
        symbolId: "winner:fileless",
        canonicalSymbolJson: canonicalFilelessJson("winner:fileless"),
        referenceCount: 1,
      }],
    };
    await withWriteConn((conn) =>
      ladybugDb.withTransaction(conn, async (txConn) => {
        await ladybugDb.replaceGraphIntegrityManifestInTransaction(
          txConn,
          "repo",
          winnerManifest,
        );
        assert.equal(
          await derivedState.advanceGraphIntegrityRevisionInTransaction(
            txConn,
            "repo",
            "v1",
            0,
          ),
          1,
        );
      }),
    );

    const winnerSnapshot = await Promise.all([
      derivedState.getDerivedState("repo"),
      ladybugDb.listGraphIntegrityFileStates(await getLadybugConn(), "repo"),
      ladybugDb.listGraphIntegrityFilelessStates(await getLadybugConn(), "repo"),
    ]);
    try {
      await assert.rejects(
        stale.stageManifest("v1"),
        GraphIntegrityVerificationError,
      );
      const afterStaleStage = await Promise.all([
        derivedState.getDerivedState("repo"),
        ladybugDb.listGraphIntegrityFileStates(await getLadybugConn(), "repo"),
        ladybugDb.listGraphIntegrityFilelessStates(await getLadybugConn(), "repo"),
      ]);
      assert.deepEqual(afterStaleStage, winnerSnapshot);
    } finally {
      await failActiveGraphIntegrityVerification("repo");
    }
    assert.equal(hasActiveGraphIntegrityVerification("repo"), false);
  });

  it("restarts synchronous verification at revision zero for a new Version", async () => {
    root = mkdtempSync(join(tmpdir(), "sdl-integrity-new-version-revision-"));
    await initLadybugDb(join(root, "new-version-revision.lbug"));
    await withWriteConn(async (conn) => {
      await ladybugDb.upsertRepo(conn, {
        repoId: "repo",
        rootPath: root,
        configJson: "{}",
        createdAt: "2026-07-21T00:00:00.000Z",
      });
      await derivedState.beginGraphIntegrityVersion(
        conn,
        "repo",
        "v1",
        "a".repeat(64),
        false,
      );
    });
    assert.equal(
      await derivedState.advanceGraphIntegrityRevisionInTransaction(
        await getLadybugConn(),
        "repo",
        "v1",
        0,
      ),
      1,
    );
    assert.equal(
      await derivedState.markGraphIntegrityVerifiedIfVerifying(
        "repo",
        "v1",
        1,
        "b".repeat(64),
      ),
      true,
    );

    const Session = PersistedGraphIntegritySession as unknown as new (
      repoId: string,
      mode: "full" | "incremental",
      enabled: boolean,
    ) => {
      begin: (versionId: string) => Promise<void>;
      complete: (versionId: string) => Promise<void>;
    };
    const session = new Session("repo", "full", true);
    await session.begin("v2");
    await session.complete("v2");

    const row = await derivedState.getDerivedState("repo");
    assert.equal(row?.graphIntegrityState, "verified");
    assert.equal(row?.graphIntegrityVersionId, "v2");
    assert.equal(row?.graphIntegrityRevision, 0);
    assert.equal(row?.graphIntegrityVerifiedRevision, 0);
    assert.equal(row?.graphIntegrityFilelessPruningSupported, true);
  });

  it("bridges migrated null revisions through full and incremental synchronous verification", async () => {
    root = mkdtempSync(join(tmpdir(), "sdl-integrity-sync-revisions-"));
    await initLadybugDb(join(root, "sync-revisions.lbug"));
    await withWriteConn(async (conn) => {
      await ladybugDb.upsertRepo(conn, {
        repoId: "repo",
        rootPath: root,
        configJson: "{}",
        createdAt: "2026-07-21T00:00:00.000Z",
      });
      await ladybugDb.createVersion(conn, {
        versionId: "v1",
        repoId: "repo",
        createdAt: "2026-07-21T00:00:00.000Z",
        reason: "test",
        prevVersionHash: null,
        versionHash: null,
      });
      await ladybugDb.exec(
        conn,
        `MERGE (d:DerivedState {repoId: $repoId})
         SET d.graphIntegrityState = 'unknown',
             d.graphIntegrityVersionId = 'legacy',
             d.graphIntegrityDigest = $digest,
             d.graphIntegrityError = 'history',
             d.graphIntegrityRevision = NULL,
             d.graphIntegrityVerifiedRevision = NULL,
             d.graphIntegrityFilelessPruningSupported = NULL`,
        { repoId: "repo", digest: "f".repeat(64) },
      );
    });

    const Session = PersistedGraphIntegritySession as unknown as new (
      repoId: string,
      mode: "full" | "incremental",
      enabled: boolean,
    ) => {
      begin: (versionId: string, affectedFileIds?: string[]) => Promise<void>;
      complete: (versionId: string) => Promise<void>;
    };
    const isVerified = graphIntegrityIsVerifiedForVersion;

    const full = new Session("repo", "full", true);
    await full.begin("v1");
    await full.complete("v1");

    let row = await derivedState.getDerivedState("repo");
    assert.equal(row?.graphIntegrityRevision, 0);
    assert.equal(row?.graphIntegrityVerifiedRevision, 0);
    assert.equal(row?.graphIntegrityFilelessPruningSupported, true);
    assert.equal(isVerified(row, "v1"), true);
    assert.notEqual(row?.graphIntegrityDigest, "f".repeat(64));

    const incremental = new Session("repo", "incremental", true);
    await incremental.begin("v1");
    await incremental.complete("v1");

    row = await derivedState.getDerivedState("repo");
    assert.equal(row?.graphIntegrityState, "verified");
    assert.equal(row?.graphIntegrityRevision, 1);
    assert.equal(row?.graphIntegrityVerifiedRevision, 1);
    assert.equal(isVerified(row, "v1"), true);
  });

});
