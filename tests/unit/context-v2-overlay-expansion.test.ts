import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Connection } from "kuzu";

import * as contextEngine from "../../dist/context/engine.js";
import { resolveFocusPaths } from "../../dist/context/engine.js";
import { getTaskProfile } from "../../dist/context/profiles.js";

function overlaySnapshot() {
  const file = {
    fileId: "overlay-file",
    repoId: "repo",
    relPath: "src/overlay-focus.ts",
    contentHash: "overlay-hash",
    language: "typescript",
    byteSize: 80,
    lastIndexedAt: null,
    directory: "src",
  };
  const symbol = {
    symbolId: "overlay-focus",
    repoId: "repo",
    fileId: file.fileId,
    kind: "function",
    name: "OverlayFocus",
    exported: true,
    visibility: "public",
    language: "typescript",
    rangeStartLine: 1,
    rangeStartCol: 0,
    rangeEndLine: 3,
    rangeEndCol: 1,
    astFingerprint: "overlay-fingerprint",
    signatureJson: null,
    summary: "overlay focus",
    invariantsJson: null,
    sideEffectsJson: null,
    roleTagsJson: null,
    searchText: "OverlayFocus overlay focus",
    updatedAt: "2026-07-27T00:00:00.000Z",
  };
  return {
    repoId: "repo",
    touchedFileIds: new Set([file.fileId]),
    symbolsById: new Map([[symbol.symbolId, symbol]]),
    filesById: new Map([[file.fileId, file]]),
    outgoingEdgesBySymbolId: new Map([
      [
        "durable-root",
        [
          {
            fromSymbolId: "durable-root",
            toSymbolId: symbol.symbolId,
            edgeType: "call",
            weight: 1,
            confidence: 1,
          },
        ],
      ],
    ]),
    contentByFileId: new Map([
      [
        file.fileId,
        "export function OverlayFocus() {\n  return 1;\n}",
      ],
    ]),
  };
}

function durableFixture(relPath: string) {
  const snapshot = overlaySnapshot();
  const overlayFile = snapshot.filesById.get("overlay-file");
  const overlaySymbol = snapshot.symbolsById.get("overlay-focus");
  assert.ok(overlayFile);
  assert.ok(overlaySymbol);
  snapshot.touchedFileIds.clear();
  snapshot.filesById.clear();
  snapshot.symbolsById.clear();

  const file = {
    ...overlayFile,
    fileId: "durable-file",
    relPath,
    directory: relPath.slice(0, Math.max(0, relPath.lastIndexOf("/"))),
  };
  const symbol = {
    ...overlaySymbol,
    symbolId: "durable-symbol",
    fileId: file.fileId,
  };
  return { snapshot, file, symbol };
}

describe("resolveFocusPaths", () => {
  it("classifies a durable exact file as symbol hits", async () => {
    const { snapshot, file, symbol } = durableFixture("src/durable.ts");
    let prefixCalls = 0;

    const result = await resolveFocusPaths(
      {} as Connection,
      "repo",
      ["src/durable.ts", "./src/durable.ts/"],
      snapshot,
      {
        getFileByRepoPath: async () => file,
        getFilesByPrefix: async () => {
          prefixCalls += 1;
          return [];
        },
        getSymbolsByFile: async () => [symbol],
      },
    );

    assert.deepEqual(result, {
      exactFileSymbolHits: [
        { path: "src/durable.ts", symbolId: "durable-symbol" },
      ],
      unavailableExactFiles: [],
      directoryPrefixes: [],
    });
    assert.equal(prefixCalls, 0);
  });

  it("rejects a durable exact file without symbols", async () => {
    const { snapshot, file } = durableFixture("scripts/run-isolated-mutating-qa.mjs");

    const result = await resolveFocusPaths(
      {} as Connection,
      "repo",
      ["scripts/run-isolated-mutating-qa.mjs"],
      snapshot,
      {
        getFileByRepoPath: async () => file,
        getFilesByPrefix: async () => [],
        getSymbolsByFile: async () => [],
      },
    );

    assert.deepEqual(result, {
      exactFileSymbolHits: [],
      unavailableExactFiles: ["scripts/run-isolated-mutating-qa.mjs"],
      directoryPrefixes: [],
    });
  });

  it("classifies a durable directory without loading its symbols", async () => {
    const { snapshot, file } = durableFixture("tests/unit/example.test.ts");
    let symbolCalls = 0;

    const result = await resolveFocusPaths(
      {} as Connection,
      "repo",
      ["tests"],
      snapshot,
      {
        getFileByRepoPath: async () => null,
        getFilesByPrefix: async () => [file],
        getSymbolsByFile: async () => {
          symbolCalls += 1;
          return [];
        },
      },
    );

    assert.deepEqual(result, {
      exactFileSymbolHits: [],
      unavailableExactFiles: [],
      directoryPrefixes: ["tests"],
    });
    assert.equal(symbolCalls, 0);
  });

  it("requires a path-segment boundary for durable directories", async () => {
    const { snapshot, file } = durableFixture("src/foobar.ts");
    let symbolCalls = 0;

    const result = await resolveFocusPaths(
      {} as Connection,
      "repo",
      ["src/foo"],
      snapshot,
      {
        getFileByRepoPath: async () => null,
        getFilesByPrefix: async (_conn, _repoId, prefix, limit) => {
          assert.equal(prefix, "src/foo/");
          assert.equal(limit, 1);
          return [file];
        },
        getSymbolsByFile: async () => {
          symbolCalls += 1;
          return [];
        },
      },
    );

    assert.deepEqual(result, {
      exactFileSymbolHits: [],
      unavailableExactFiles: [],
      directoryPrefixes: [],
    });
    assert.equal(symbolCalls, 0);
  });

  it("recognizes an actual durable descendant", async () => {
    const { snapshot, file } = durableFixture("src/foo/bar.ts");

    const result = await resolveFocusPaths(
      {} as Connection,
      "repo",
      ["src/foo"],
      snapshot,
      {
        getFileByRepoPath: async () => null,
        getFilesByPrefix: async (_conn, _repoId, prefix) => {
          assert.equal(prefix, "src/foo/");
          return [file];
        },
        getSymbolsByFile: async () => [],
      },
    );

    assert.deepEqual(result, {
      exactFileSymbolHits: [],
      unavailableExactFiles: [],
      directoryPrefixes: ["src/foo"],
    });
  });

  it("passes 200 tombstones into a one-row durable prefix query", async () => {
    const { snapshot, file } = durableFixture("src/foo/deleted-000.ts");
    const files = Array.from({ length: 201 }, (_, index) => ({
      ...file,
      fileId: `durable-${String(index).padStart(3, "0")}`,
      relPath:
        index < 200
          ? `src/foo/deleted-${String(index).padStart(3, "0")}.ts`
          : "src/foo/visible.ts",
    }));
    const tombstonedFileIds = files
      .slice(0, 200)
      .map(({ fileId }) => fileId);
    for (const fileId of tombstonedFileIds) {
      snapshot.touchedFileIds.add(fileId);
    }
    const testConn = {} as Connection;
    let symbolCalls = 0;

    const result = await resolveFocusPaths(
      testConn,
      "repo",
      ["src/foo"],
      snapshot,
      {
        getFileByRepoPath: async () => null,
        getFilesByPrefix: async (
          actualConn,
          actualRepoId,
          prefix,
          limit,
          excludedFileIds = [],
        ) => {
          assert.strictEqual(actualConn, testConn);
          assert.equal(actualRepoId, "repo");
          assert.equal(prefix, "src/foo/");
          assert.equal(limit, 1);
          assert.deepEqual(excludedFileIds, tombstonedFileIds);
          const excluded = new Set(excludedFileIds);
          return files
            .filter(({ fileId }) => !excluded.has(fileId))
            .slice(0, limit);
        },
        getSymbolsByFile: async () => {
          symbolCalls += 1;
          return [];
        },
      },
    );

    assert.deepEqual(result, {
      exactFileSymbolHits: [],
      unavailableExactFiles: [],
      directoryPrefixes: ["src/foo"],
    });
    assert.equal(symbolCalls, 0);
  });

  it("ignores a missing focus path", async () => {
    const { snapshot } = durableFixture("src/missing.ts");

    const result = await resolveFocusPaths(
      {} as Connection,
      "repo",
      ["src/missing.ts"],
      snapshot,
      {
        getFileByRepoPath: async () => null,
        getFilesByPrefix: async () => [],
        getSymbolsByFile: async () => [],
      },
    );

    assert.deepEqual(result, {
      exactFileSymbolHits: [],
      unavailableExactFiles: [],
      directoryPrefixes: [],
    });
  });

  it("treats an overlay-only exact file as authoritative", async () => {
    const snapshot = overlaySnapshot();

    const result = await resolveFocusPaths(
      {} as Connection,
      "repo",
      ["src/overlay-focus.ts"],
      snapshot,
      {
        getFileByRepoPath: async () => {
          throw new Error("durable exact lookup must not run");
        },
        getFilesByPrefix: async () => {
          throw new Error("directory lookup must not run");
        },
        getSymbolsByFile: async () => {
          throw new Error("durable symbol lookup must not run");
        },
      },
    );

    assert.deepEqual(result, {
      exactFileSymbolHits: [
        { path: "src/overlay-focus.ts", symbolId: "overlay-focus" },
      ],
      unavailableExactFiles: [],
      directoryPrefixes: [],
    });
  });

  it("classifies an overlay-only directory without loading symbols", async () => {
    const snapshot = overlaySnapshot();
    let symbolCalls = 0;

    const result = await resolveFocusPaths(
      {} as Connection,
      "repo",
      ["src"],
      snapshot,
      {
        getFileByRepoPath: async () => null,
        getFilesByPrefix: async () => [],
        getSymbolsByFile: async () => {
          symbolCalls += 1;
          return [];
        },
      },
    );

    assert.deepEqual(result, {
      exactFileSymbolHits: [],
      unavailableExactFiles: [],
      directoryPrefixes: ["src"],
    });
    assert.equal(symbolCalls, 0);
  });

  it("hides a durable exact file tombstoned by the overlay", async () => {
    const { snapshot, file } = durableFixture("src/deleted.ts");
    snapshot.touchedFileIds.add(file.fileId);
    let symbolCalls = 0;

    const result = await resolveFocusPaths(
      {} as Connection,
      "repo",
      ["src/deleted.ts"],
      snapshot,
      {
        getFileByRepoPath: async () => file,
        getFilesByPrefix: async () => [file],
        getSymbolsByFile: async () => {
          symbolCalls += 1;
          return [];
        },
      },
    );

    assert.deepEqual(result, {
      exactFileSymbolHits: [],
      unavailableExactFiles: [],
      directoryPrefixes: [],
    });
    assert.equal(symbolCalls, 0);
  });
});

describe("Context V2 captured overlay expansion", () => {
  it("resolves overlay-only explicit and focus-path symbols from one snapshot", async () => {
    const snapshot = overlaySnapshot();
    const resolveMentions = Reflect.get(
      contextEngine,
      "resolveOverlayMentionSymbolIds",
    );
    const resolvePaths = Reflect.get(
      contextEngine,
      "resolveFocusPaths",
    );
    assert.equal(typeof resolveMentions, "function");
    assert.equal(typeof resolvePaths, "function");
    if (
      typeof resolveMentions !== "function" ||
      typeof resolvePaths !== "function"
    ) {
      return;
    }

    assert.deepEqual(
      resolveMentions(snapshot, ["overlay-focus", "OverlayFocus"]),
      ["overlay-focus"],
    );
    const resolution = await resolvePaths(
      {} as Connection,
      "repo",
      ["src/overlay-focus.ts"],
      snapshot,
      {
        getFileByRepoPath: async () => null,
        getFilesByPrefix: async () => [],
        getSymbolsByFile: async () => [],
      },
    );
    assert.deepEqual(resolution.exactFileSymbolHits, [
      {
        path: "src/overlay-focus.ts",
        symbolId: "overlay-focus",
      },
    ]);
  });

  it("passes profile beam behavior and the captured overlay to expansion", async () => {
    const expand = Reflect.get(contextEngine, "defaultExpand");
    assert.equal(typeof expand, "function");
    if (typeof expand !== "function") return;

    const snapshot = overlaySnapshot();
    Object.assign(snapshot.symbolsById.get("overlay-focus")!, {
      testCaseJson: JSON.stringify({ framework: "node:test", title: "checks api.other" }),
    });
    let capturedRequest: unknown;
    let capturedSnapshot: unknown;
    const result = await expand(
      {
        request: {
          repoId: "repo",
          taskType: "review",
          taskText: "find tests for api.target",
          budget: { maxTokens: 2_000 },
        },
        profile: getTaskProfile("review"),
        candidates: [
          {
            symbolId: "durable-root",
            path: "src/root.ts",
            rank: 1,
            tier: 0,
            lanes: ["exactIdentifier"],
            estimates: { card: 10, skeleton: 20, hotPath: 30 },
          },
        ],
        runtime: {
          conn: {} as Connection,
          overlaySnapshot: snapshot,
        },
      },
      async (
        _conn: unknown,
        _repoId: unknown,
        _startNodes: unknown,
        _budget: unknown,
        request: unknown,
        _edgeWeights: unknown,
        _minConfidence: unknown,
        _signal: unknown,
        _trace: unknown,
        overlay: unknown,
      ) => {
        capturedRequest = request;
        capturedSnapshot = overlay;
        return {
          sliceCards: new Set(["durable-root", "overlay-focus"]),
          frontier: [],
          wasTruncated: false,
          droppedCandidates: 0,
          maxFrontierSize: 1,
        };
      },
    );

    assert.deepEqual(capturedRequest, {
      entrySymbols: ["durable-root"],
      taskText: "find tests for api.target",
      direction: "out",
      maxDepth: null,
    });
    assert.strictEqual(capturedSnapshot, snapshot);
    assert.equal(result[1]?.symbolId, "overlay-focus");
    assert.equal(result[1]?.path, "src/overlay-focus.ts");
    assert.equal(result[1]?.testCaseQualifiedMatch, false,
      "graph expansion must retain the qualified-title relevance signal");
    assert.ok(result[1].estimates.card < 160, "small captured cards must not pay the generic card ceiling");
    assert.equal(result[1].estimates.hotPath, 300);
    assert.equal(result[1].estimates.skeleton, 128);
  });
});
