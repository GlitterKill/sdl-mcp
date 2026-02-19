import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import {
  EventLogReplayer,
  createEventLogReplayer,
  type ProjectedSymbol,
  type ProjectedEdge,
} from "../../dist/experiments/event-log-replay.js";
import {
  InMemorySymbolRepository,
  createInMemoryRepository,
  type SymbolReadModel,
  type EdgeReadModel,
} from "../../dist/domain/repositories/symbol-repository.js";
import type {
  RepoId,
  SymbolId,
  VersionId,
  EdgeType,
} from "../../dist/db/schema.js";

const TEST_REPO = "test-repo" as RepoId;
const VERSION_1 = "v1" as VersionId;
const VERSION_2 = "v2" as VersionId;

function makeSymbol(
  id: string,
  name: string,
  kind: "function" | "class" | "interface" = "function",
): {
  symbol: ProjectedSymbol;
  readModel: SymbolReadModel;
} {
  const symbolId = id as SymbolId;
  const common = {
    symbolId,
    repoId: TEST_REPO,
    fileId: 1,
    kind,
    name,
    exported: true,
    visibility: null as "public" | null,
    language: "typescript",
    range: { startLine: 1, startCol: 0, endLine: 5, endCol: 0 },
    astFingerprint: `fp-${id}`,
    signature: null,
    summary: null,
    invariants: null,
    sideEffects: null,
  };

  const readModel: SymbolReadModel = {
    symbolId,
    repoId: TEST_REPO,
    file: "src/test.ts",
    range: common.range,
    kind,
    name,
    exported: true,
    version: {
      ledgerVersion: VERSION_1,
      astFingerprint: `fp-${id}`,
    },
  };

  return { symbol: common as ProjectedSymbol, readModel };
}

function makeEdge(
  fromId: string,
  toId: string,
  type: EdgeType = "call",
): {
  edge: ProjectedEdge;
  readModel: EdgeReadModel;
} {
  const fromSymbolId = fromId as SymbolId;
  const toSymbolId = toId as SymbolId;
  const edge: ProjectedEdge = {
    fromSymbolId,
    toSymbolId,
    repoId: TEST_REPO,
    type,
    weight: 1.0,
    confidence: 1.0,
    resolutionStrategy: "exact",
    createdAt: new Date().toISOString(),
  };

  const readModel: EdgeReadModel = {
    ...edge,
  };

  return { edge, readModel };
}

describe("Event Log Replay", () => {
  let replayer: EventLogReplayer;

  beforeEach(() => {
    replayer = createEventLogReplayer();
  });

  describe("Symbol Events", () => {
    it("should append and replay SYMBOL_UPSERTED events", () => {
      const { symbol } = makeSymbol("sym-1", "testFunction");

      replayer.appendSymbolUpsert(TEST_REPO, VERSION_1, {
        symbolId: symbol.symbolId,
        fileId: symbol.fileId,
        kind: symbol.kind,
        name: symbol.name,
        exported: symbol.exported,
        visibility: symbol.visibility,
        language: symbol.language,
        range: symbol.range,
        astFingerprint: symbol.astFingerprint,
        signature: symbol.signature,
        summary: symbol.summary,
        invariants: symbol.invariants,
        sideEffects: symbol.sideEffects,
      });

      const state = replayer.replay(TEST_REPO);

      assert.strictEqual(state.symbols.size, 1);
      assert.strictEqual(state.versionId, VERSION_1);

      const replayed = state.symbols.get(symbol.symbolId);
      assert.ok(replayed);
      assert.strictEqual(replayed.name, "testFunction");
      assert.strictEqual(replayed.kind, "function");
    });

    it("should handle SYMBOL_REMOVED events", () => {
      const { symbol: s1 } = makeSymbol("sym-1", "func1");
      const { symbol: s2 } = makeSymbol("sym-2", "func2");

      replayer.appendSymbolUpsert(TEST_REPO, VERSION_1, {
        symbolId: s1.symbolId,
        fileId: s1.fileId,
        kind: s1.kind,
        name: s1.name,
        exported: s1.exported,
        visibility: s1.visibility,
        language: s1.language,
        range: s1.range,
        astFingerprint: s1.astFingerprint,
        signature: s1.signature,
        summary: s1.summary,
        invariants: s1.invariants,
        sideEffects: s1.sideEffects,
      });

      replayer.appendSymbolUpsert(TEST_REPO, VERSION_1, {
        symbolId: s2.symbolId,
        fileId: s2.fileId,
        kind: s2.kind,
        name: s2.name,
        exported: s2.exported,
        visibility: s2.visibility,
        language: s2.language,
        range: s2.range,
        astFingerprint: s2.astFingerprint,
        signature: s2.signature,
        summary: s2.summary,
        invariants: s2.invariants,
        sideEffects: s2.sideEffects,
      });

      replayer.appendSymbolRemove(TEST_REPO, VERSION_2, s1.symbolId);

      const state = replayer.replay(TEST_REPO);

      assert.strictEqual(state.symbols.size, 1);
      assert.ok(!state.symbols.has(s1.symbolId));
      assert.ok(state.symbols.has(s2.symbolId));
    });

    it("should cascade delete edges when symbol is removed", () => {
      const { symbol: caller } = makeSymbol("caller", "caller");
      const { symbol: callee } = makeSymbol("callee", "callee");
      const { edge } = makeEdge("caller", "callee");

      replayer.appendSymbolUpsert(TEST_REPO, VERSION_1, {
        symbolId: caller.symbolId,
        fileId: caller.fileId,
        kind: caller.kind,
        name: caller.name,
        exported: caller.exported,
        visibility: caller.visibility,
        language: caller.language,
        range: caller.range,
        astFingerprint: caller.astFingerprint,
        signature: caller.signature,
        summary: caller.summary,
        invariants: caller.invariants,
        sideEffects: caller.sideEffects,
      });

      replayer.appendSymbolUpsert(TEST_REPO, VERSION_1, {
        symbolId: callee.symbolId,
        fileId: callee.fileId,
        kind: callee.kind,
        name: callee.name,
        exported: callee.exported,
        visibility: callee.visibility,
        language: callee.language,
        range: callee.range,
        astFingerprint: callee.astFingerprint,
        signature: callee.signature,
        summary: callee.summary,
        invariants: callee.invariants,
        sideEffects: callee.sideEffects,
      });

      replayer.appendEdgeCreate(TEST_REPO, VERSION_1, {
        fromSymbolId: edge.fromSymbolId,
        toSymbolId: edge.toSymbolId,
        type: edge.type,
        weight: edge.weight,
        confidence: edge.confidence,
        resolutionStrategy: edge.resolutionStrategy,
      });

      replayer.appendSymbolRemove(TEST_REPO, VERSION_2, callee.symbolId);

      const state = replayer.replay(TEST_REPO);

      assert.strictEqual(state.symbols.size, 1);
      assert.strictEqual(state.edges.size, 0);
    });
  });

  describe("Edge Events", () => {
    it("should append and replay EDGE_CREATED events", () => {
      const { symbol: s1 } = makeSymbol("sym-1", "func1");
      const { symbol: s2 } = makeSymbol("sym-2", "func2");
      const { edge } = makeEdge("sym-1", "sym-2", "call");

      replayer.appendSymbolUpsert(TEST_REPO, VERSION_1, {
        symbolId: s1.symbolId,
        fileId: s1.fileId,
        kind: s1.kind,
        name: s1.name,
        exported: s1.exported,
        visibility: s1.visibility,
        language: s1.language,
        range: s1.range,
        astFingerprint: s1.astFingerprint,
        signature: s1.signature,
        summary: s1.summary,
        invariants: s1.invariants,
        sideEffects: s1.sideEffects,
      });

      replayer.appendSymbolUpsert(TEST_REPO, VERSION_1, {
        symbolId: s2.symbolId,
        fileId: s2.fileId,
        kind: s2.kind,
        name: s2.name,
        exported: s2.exported,
        visibility: s2.visibility,
        language: s2.language,
        range: s2.range,
        astFingerprint: s2.astFingerprint,
        signature: s2.signature,
        summary: s2.summary,
        invariants: s2.invariants,
        sideEffects: s2.sideEffects,
      });

      replayer.appendEdgeCreate(TEST_REPO, VERSION_1, {
        fromSymbolId: edge.fromSymbolId,
        toSymbolId: edge.toSymbolId,
        type: edge.type,
        weight: edge.weight,
        confidence: edge.confidence,
        resolutionStrategy: edge.resolutionStrategy,
      });

      const state = replayer.replay(TEST_REPO);

      assert.strictEqual(state.edges.size, 1);

      const key = `sym-1:sym-2:call`;
      const replayed = state.edges.get(key);
      assert.ok(replayed);
      assert.strictEqual(replayed.type, "call");
      assert.strictEqual(replayed.confidence, 1.0);
    });

    it("should handle EDGE_REMOVED events", () => {
      const { symbol: s1 } = makeSymbol("sym-1", "func1");
      const { symbol: s2 } = makeSymbol("sym-2", "func2");
      const { edge } = makeEdge("sym-1", "sym-2", "import");

      replayer.appendSymbolUpsert(TEST_REPO, VERSION_1, {
        symbolId: s1.symbolId,
        fileId: s1.fileId,
        kind: s1.kind,
        name: s1.name,
        exported: s1.exported,
        visibility: s1.visibility,
        language: s1.language,
        range: s1.range,
        astFingerprint: s1.astFingerprint,
        signature: s1.signature,
        summary: s1.summary,
        invariants: s1.invariants,
        sideEffects: s1.sideEffects,
      });

      replayer.appendSymbolUpsert(TEST_REPO, VERSION_1, {
        symbolId: s2.symbolId,
        fileId: s2.fileId,
        kind: s2.kind,
        name: s2.name,
        exported: s2.exported,
        visibility: s2.visibility,
        language: s2.language,
        range: s2.range,
        astFingerprint: s2.astFingerprint,
        signature: s2.signature,
        summary: s2.summary,
        invariants: s2.invariants,
        sideEffects: s2.sideEffects,
      });

      replayer.appendEdgeCreate(TEST_REPO, VERSION_1, {
        fromSymbolId: edge.fromSymbolId,
        toSymbolId: edge.toSymbolId,
        type: edge.type,
        weight: edge.weight,
        confidence: edge.confidence,
        resolutionStrategy: edge.resolutionStrategy,
      });

      replayer.appendEdgeRemove(
        TEST_REPO,
        VERSION_2,
        edge.fromSymbolId,
        edge.toSymbolId,
        edge.type,
      );

      const state = replayer.replay(TEST_REPO);

      assert.strictEqual(state.edges.size, 0);
    });
  });

  describe("Parity Validation", () => {
    it("should validate 100% parity for matching symbol/edge sets", () => {
      const symbols = [makeSymbol("s1", "func1"), makeSymbol("s2", "func2")];
      const edges = [makeEdge("s1", "s2", "call")];

      for (const { symbol } of symbols) {
        replayer.appendSymbolUpsert(TEST_REPO, VERSION_1, {
          symbolId: symbol.symbolId,
          fileId: symbol.fileId,
          kind: symbol.kind,
          name: symbol.name,
          exported: symbol.exported,
          visibility: symbol.visibility,
          language: symbol.language,
          range: symbol.range,
          astFingerprint: symbol.astFingerprint,
          signature: symbol.signature,
          summary: symbol.summary,
          invariants: symbol.invariants,
          sideEffects: symbol.sideEffects,
        });
      }

      for (const { edge } of edges) {
        replayer.appendEdgeCreate(TEST_REPO, VERSION_1, {
          fromSymbolId: edge.fromSymbolId,
          toSymbolId: edge.toSymbolId,
          type: edge.type,
          weight: edge.weight,
          confidence: edge.confidence,
          resolutionStrategy: edge.resolutionStrategy,
        });
      }

      const expectedSymbols = new Map<SymbolId, any>();
      for (const { readModel } of symbols) {
        expectedSymbols.set(readModel.symbolId, {
          name: readModel.name,
          kind: readModel.kind,
          exported: readModel.exported,
        });
      }

      const expectedEdges = new Map<string, any>();
      for (const { edge } of edges) {
        const key = `${edge.fromSymbolId}:${edge.toSymbolId}:${edge.type}`;
        expectedEdges.set(key, {
          from: edge.fromSymbolId,
          to: edge.toSymbolId,
          type: edge.type,
        });
      }

      const result = replayer.validateParity(
        TEST_REPO,
        expectedSymbols,
        expectedEdges,
      );

      assert.strictEqual(
        result.passed,
        true,
        `Mismatches: ${result.mismatches.join(", ")}`,
      );
      assert.strictEqual(result.symbolMatch, 2);
      assert.strictEqual(result.symbolTotal, 2);
      assert.strictEqual(result.edgeMatch, 1);
      assert.strictEqual(result.edgeTotal, 1);
    });

    it("should detect missing symbols in projection", () => {
      const expectedSymbols = new Map<SymbolId, any>();
      expectedSymbols.set("missing-sym" as SymbolId, {
        name: "missingFunc",
        kind: "function",
        exported: true,
      });

      const result = replayer.validateParity(
        TEST_REPO,
        expectedSymbols,
        new Map(),
      );

      assert.strictEqual(result.passed, false);
      assert.ok(result.mismatches.some((m) => m.includes("Missing symbol")));
    });

    it("should detect extra symbols in projection", () => {
      const { symbol } = makeSymbol("extra", "extraFunc");

      replayer.appendSymbolUpsert(TEST_REPO, VERSION_1, {
        symbolId: symbol.symbolId,
        fileId: symbol.fileId,
        kind: symbol.kind,
        name: symbol.name,
        exported: symbol.exported,
        visibility: symbol.visibility,
        language: symbol.language,
        range: symbol.range,
        astFingerprint: symbol.astFingerprint,
        signature: symbol.signature,
        summary: symbol.summary,
        invariants: symbol.invariants,
        sideEffects: symbol.sideEffects,
      });

      const result = replayer.validateParity(TEST_REPO, new Map(), new Map());

      assert.strictEqual(result.passed, false);
      assert.ok(result.mismatches.some((m) => m.includes("Extra symbols")));
    });
  });

  describe("Version Filtering", () => {
    it("should filter events by version", () => {
      const { symbol: s1 } = makeSymbol("s1", "v1Func");
      const { symbol: s2 } = makeSymbol("s2", "v2Func");

      replayer.appendSymbolUpsert(TEST_REPO, VERSION_1, {
        symbolId: s1.symbolId,
        fileId: s1.fileId,
        kind: s1.kind,
        name: s1.name,
        exported: s1.exported,
        visibility: s1.visibility,
        language: s1.language,
        range: s1.range,
        astFingerprint: s1.astFingerprint,
        signature: s1.signature,
        summary: s1.summary,
        invariants: s1.invariants,
        sideEffects: s1.sideEffects,
      });

      replayer.appendSymbolUpsert(TEST_REPO, VERSION_2, {
        symbolId: s2.symbolId,
        fileId: s2.fileId,
        kind: s2.kind,
        name: s2.name,
        exported: s2.exported,
        visibility: s2.visibility,
        language: s2.language,
        range: s2.range,
        astFingerprint: s2.astFingerprint,
        signature: s2.signature,
        summary: s2.summary,
        invariants: s2.invariants,
        sideEffects: s2.sideEffects,
      });

      const stateV1 = replayer.replay(TEST_REPO, VERSION_1);
      const stateV2 = replayer.replay(TEST_REPO, VERSION_2);

      assert.strictEqual(stateV1.symbols.size, 1);
      assert.strictEqual(stateV1.versionId, VERSION_1);
      assert.strictEqual(stateV2.symbols.size, 2);
      assert.strictEqual(stateV2.versionId, VERSION_2);
    });
  });
});

describe("InMemorySymbolRepository (Contract Tests)", () => {
  let repo: InMemorySymbolRepository;

  beforeEach(() => {
    repo = createInMemoryRepository();
  });

  describe("Symbol Operations", () => {
    it("should return null for non-existent symbol", async () => {
      const result = await repo.getSymbol(TEST_REPO, "nonexistent" as SymbolId);
      assert.strictEqual(result, null);
    });

    it("should store and retrieve symbols", async () => {
      const { symbol, readModel } = makeSymbol("sym-1", "testFunc");
      repo.addSymbol(TEST_REPO, readModel);

      const result = await repo.getSymbol(TEST_REPO, symbol.symbolId);

      assert.ok(result);
      assert.strictEqual(result.name, "testFunc");
      assert.strictEqual(result.kind, "function");
    });

    it("should retrieve symbols by IDs in batch", async () => {
      const s1 = makeSymbol("sym-1", "func1");
      const s2 = makeSymbol("sym-2", "func2");
      const s3 = makeSymbol("sym-3", "func3");

      repo.addSymbol(TEST_REPO, s1.readModel);
      repo.addSymbol(TEST_REPO, s2.readModel);
      repo.addSymbol(TEST_REPO, s3.readModel);

      const result = await repo.getSymbolsByIds(TEST_REPO, [
        s1.symbol.symbolId,
        s3.symbol.symbolId,
        "nonexistent" as SymbolId,
      ]);

      assert.strictEqual(result.size, 2);
      assert.ok(result.has(s1.symbol.symbolId));
      assert.ok(result.has(s3.symbol.symbolId));
      assert.ok(!result.has("nonexistent" as SymbolId));
    });

    it("should retrieve symbols by file", async () => {
      const { readModel } = makeSymbol("sym-1", "func1");
      repo.addSymbol(TEST_REPO, readModel);

      const result = await repo.getSymbolsByFile(TEST_REPO, "src/test.ts");

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].name, "func1");
    });

    it("should count symbols", async () => {
      repo.addSymbol(TEST_REPO, makeSymbol("s1", "f1").readModel);
      repo.addSymbol(TEST_REPO, makeSymbol("s2", "f2").readModel);

      const count = await repo.countSymbols(TEST_REPO);
      assert.strictEqual(count, 2);
    });

    it("should remove symbol and cascade edges", async () => {
      const { readModel: caller } = makeSymbol("caller", "caller");
      const { readModel: callee } = makeSymbol("callee", "callee");
      const { readModel: edge } = makeEdge("caller", "callee");

      repo.addSymbol(TEST_REPO, caller);
      repo.addSymbol(TEST_REPO, callee);
      repo.addEdge(TEST_REPO, edge);

      repo.removeSymbol(TEST_REPO, callee.symbolId);

      const sym = await repo.getSymbol(TEST_REPO, callee.symbolId);
      const edges = await repo.getEdgesByRepo(TEST_REPO);

      assert.strictEqual(sym, null);
      assert.strictEqual(edges.length, 0);
    });
  });

  describe("Edge Operations", () => {
    it("should return empty array for edges from non-existent symbol", async () => {
      const result = await repo.getEdgesFrom(
        TEST_REPO,
        "nonexistent" as SymbolId,
      );
      assert.deepStrictEqual(result, []);
    });

    it("should store and retrieve edges", async () => {
      const { readModel: edge } = makeEdge("from", "to", "call");
      repo.addEdge(TEST_REPO, edge);

      const fromEdges = await repo.getEdgesFrom(TEST_REPO, "from" as SymbolId);
      const toEdges = await repo.getEdgesTo(TEST_REPO, "to" as SymbolId);

      assert.strictEqual(fromEdges.length, 1);
      assert.strictEqual(toEdges.length, 1);
      assert.strictEqual(fromEdges[0].type, "call");
    });

    it("should retrieve all edges by repo", async () => {
      repo.addEdge(TEST_REPO, makeEdge("a", "b", "call").readModel);
      repo.addEdge(TEST_REPO, makeEdge("b", "c", "import").readModel);

      const edges = await repo.getEdgesByRepo(TEST_REPO);

      assert.strictEqual(edges.length, 2);
    });

    it("should count edges", async () => {
      repo.addEdge(TEST_REPO, makeEdge("a", "b").readModel);
      repo.addEdge(TEST_REPO, makeEdge("b", "c").readModel);

      const count = await repo.countEdges(TEST_REPO);
      assert.strictEqual(count, 2);
    });
  });

  describe("Symbol Search", () => {
    beforeEach(() => {
      repo.addSymbol(TEST_REPO, makeSymbol("get-user", "getUser").readModel);
      repo.addSymbol(TEST_REPO, makeSymbol("set-user", "setUser").readModel);
      repo.addSymbol(
        TEST_REPO,
        makeSymbol("delete-item", "deleteItem").readModel,
      );
    });

    it("should search symbols by name prefix", async () => {
      const results = await repo.searchSymbols(TEST_REPO, "user", 10);

      assert.strictEqual(results.length, 2);
      assert.ok(results.every((r) => r.name.toLowerCase().includes("user")));
    });

    it("should limit search results", async () => {
      const results = await repo.searchSymbols(TEST_REPO, "e", 1);
      assert.strictEqual(results.length, 1);
    });

    it("should score exact matches higher", async () => {
      repo.addSymbol(TEST_REPO, makeSymbol("exact", "exactMatch").readModel);
      repo.addSymbol(
        TEST_REPO,
        makeSymbol("partial", "exactMatchPartial").readModel,
      );

      const results = await repo.searchSymbols(TEST_REPO, "exactMatch", 10);

      assert.ok(results.length >= 2);
      assert.strictEqual(results[0].name, "exactMatch");
      assert.strictEqual(results[0].score, 1.0);
    });
  });

  describe("Symbol Dependencies", () => {
    it("should get symbol dependencies", async () => {
      repo.addEdge(TEST_REPO, makeEdge("main", "util", "import").readModel);
      repo.addEdge(TEST_REPO, makeEdge("main", "helper", "call").readModel);
      repo.addEdge(TEST_REPO, makeEdge("main", "logger", "call").readModel);

      const deps = await repo.getSymbolDeps(TEST_REPO, "main" as SymbolId);

      assert.strictEqual(deps.imports.length, 1);
      assert.strictEqual(deps.calls.length, 2);
      assert.ok(deps.imports.includes("util" as SymbolId));
    });
  });

  describe("Isolation", () => {
    it("should isolate data by repo", async () => {
      const repo1 = "repo-1" as RepoId;
      const repo2 = "repo-2" as RepoId;

      repo.addSymbol(repo1, makeSymbol("s1", "repo1Func").readModel);
      repo.addSymbol(repo2, makeSymbol("s2", "repo2Func").readModel);

      const count1 = await repo.countSymbols(repo1);
      const count2 = await repo.countSymbols(repo2);

      assert.strictEqual(count1, 1);
      assert.strictEqual(count2, 1);

      const r1Result = await repo.getSymbol(repo1, "s1" as SymbolId);
      const r2Result = await repo.getSymbol(repo2, "s2" as SymbolId);

      assert.strictEqual(r1Result?.name, "repo1Func");
      assert.strictEqual(r2Result?.name, "repo2Func");
    });

    it("should clear repo data", async () => {
      repo.addSymbol(TEST_REPO, makeSymbol("s1", "f1").readModel);
      repo.addEdge(TEST_REPO, makeEdge("a", "b").readModel);

      repo.clear(TEST_REPO);

      const symCount = await repo.countSymbols(TEST_REPO);
      const edgeCount = await repo.countEdges(TEST_REPO);

      assert.strictEqual(symCount, 0);
      assert.strictEqual(edgeCount, 0);
    });
  });
});
