import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type {
  EdgeForSlice,
  EdgeRow,
  FileRow,
  SymbolRow,
} from "../../dist/db/ladybug-queries.js";
import {
  getDefaultOverlayStore,
  resetDefaultLiveIndexCoordinator,
} from "../../dist/live-index/coordinator.js";
import {
  getOverlaySnapshot,
  clearSnapshotCache,
  getOverlaySymbol,
  mergeEdgeMapWithOverlay,
  mergeSymbolRowsWithOverlay,
  type OverlaySnapshot,
} from "../../dist/live-index/overlay-reader.js";

const repoId = "overlay-repo";
const filePath = "src/overlay.ts";
const fileId = `${repoId}:${filePath}`;
const symbolId = `${repoId}:${filePath}:function:overlayFn:fp-overlay`;

function makeFileRow(overrides: Partial<FileRow> = {}): FileRow {
  return {
    fileId,
    repoId,
    relPath: filePath,
    contentHash: "file-hash",
    language: "typescript",
    byteSize: 128,
    lastIndexedAt: null,
    directory: "src",
    ...overrides,
  };
}

function makeSymbolRow(overrides: Partial<SymbolRow> = {}): SymbolRow {
  return {
    symbolId,
    repoId,
    fileId,
    kind: "function",
    name: "overlayFn",
    exported: true,
    visibility: "public",
    language: "typescript",
    rangeStartLine: 1,
    rangeStartCol: 0,
    rangeEndLine: 5,
    rangeEndCol: 0,
    astFingerprint: "fp-overlay",
    signatureJson: null,
    summary: "overlay summary",
    invariantsJson: null,
    sideEffectsJson: null,
    roleTagsJson: null,
    searchText: "overlayFn overlay summary",
    updatedAt: "2026-03-18T12:00:00.000Z",
    ...overrides,
  };
}

function makeEdgeRow(overrides: Partial<EdgeRow> = {}): EdgeRow {
  return {
    repoId,
    fromSymbolId: symbolId,
    toSymbolId: "target-symbol",
    edgeType: "call",
    weight: 1,
    confidence: 0.95,
    resolution: "exact",
    resolverId: "pass1-generic",
    resolutionPhase: "pass1",
    provenance: "call:target",
    createdAt: "2026-03-18T12:00:00.000Z",
    ...overrides,
  };
}

function seedOverlayEntry(): void {
  const store = getDefaultOverlayStore();
  store.upsertDraft({
    repoId,
    eventType: "change",
    filePath,
    content: "export function overlayFn() { return 1; }",
    language: "typescript",
    version: 1,
    dirty: true,
    timestamp: "2026-03-18T12:00:00.000Z",
  });
  store.setParseResult(
    repoId,
    filePath,
    1,
    {
      version: 1,
      file: makeFileRow(),
      symbols: [makeSymbolRow()],
      edges: [makeEdgeRow()],
      references: [],
    },
    "2026-03-18T12:00:01.000Z",
  );
}

describe("overlay-reader", () => {
  beforeEach(() => {
    resetDefaultLiveIndexCoordinator();
    clearSnapshotCache();
  });

  it("getOverlaySnapshot returns empty shape when overlay has no drafts", () => {
    const snapshot = getOverlaySnapshot(repoId);

    assert.strictEqual(snapshot.repoId, repoId);
    assert.deepStrictEqual(Array.from(snapshot.touchedFileIds), []);
    assert.strictEqual(snapshot.symbolsById.size, 0);
    assert.strictEqual(snapshot.filesById.size, 0);
    assert.strictEqual(snapshot.outgoingEdgesBySymbolId.size, 0);
  });

  it("getOverlaySnapshot returns cached object for unchanged version", () => {
    const first = getOverlaySnapshot(repoId);
    const second = getOverlaySnapshot(repoId);

    assert.strictEqual(first, second);
  });

  it("clearSnapshotCache forces snapshot recompute", () => {
    const first = getOverlaySnapshot(repoId);
    clearSnapshotCache();
    const second = getOverlaySnapshot(repoId);

    assert.notStrictEqual(first, second);
  });

  it("getOverlaySnapshot includes parsed overlay symbols/files/edges", () => {
    seedOverlayEntry();

    const snapshot = getOverlaySnapshot(repoId);
    assert.deepStrictEqual(Array.from(snapshot.touchedFileIds), [fileId]);
    assert.strictEqual(snapshot.symbolsById.get(symbolId)?.name, "overlayFn");
    assert.strictEqual(snapshot.filesById.get(fileId)?.relPath, filePath);
    assert.strictEqual(
      snapshot.outgoingEdgesBySymbolId.get(symbolId)?.length,
      1,
    );
  });

  it("getOverlaySymbol returns symbol, file, and outgoing edges when found", () => {
    seedOverlayEntry();
    const snapshot = getOverlaySnapshot(repoId);

    const result = getOverlaySymbol(snapshot, symbolId);
    assert.ok(result);
    assert.strictEqual(result.symbol.symbolId, symbolId);
    assert.strictEqual(result.file.fileId, fileId);
    assert.strictEqual(result.outgoingEdges.length, 1);
  });

  it("getOverlaySymbol returns null for unknown symbol", () => {
    const snapshot = getOverlaySnapshot(repoId);
    const result = getOverlaySymbol(snapshot, "missing-symbol");
    assert.strictEqual(result, null);
  });

  it("mergeEdgeMapWithOverlay lets overlay edges override durable edges", () => {
    const overlayEdge: EdgeForSlice = {
      fromSymbolId: symbolId,
      toSymbolId: "overlay-target",
      edgeType: "import",
      weight: 0.6,
      confidence: 0.9,
    };
    const durableEdge: EdgeForSlice = {
      fromSymbolId: symbolId,
      toSymbolId: "durable-target",
      edgeType: "call",
      weight: 1,
      confidence: 0.99,
    };

    const snapshot: OverlaySnapshot = {
      repoId,
      touchedFileIds: new Set([fileId]),
      symbolsById: new Map([[symbolId, makeSymbolRow()]]),
      filesById: new Map([[fileId, makeFileRow()]]),
      outgoingEdgesBySymbolId: new Map([[symbolId, [overlayEdge]]]),
    };

    const merged = mergeEdgeMapWithOverlay(
      snapshot,
      [symbolId],
      new Map([[symbolId, [durableEdge]]]),
    );

    assert.deepStrictEqual(merged.get(symbolId), [overlayEdge]);
  });

  it("mergeEdgeMapWithOverlay applies minCallConfidence only to call edges", () => {
    const overlayCallLow: EdgeForSlice = {
      fromSymbolId: symbolId,
      toSymbolId: "call-low",
      edgeType: "call",
      weight: 1,
      confidence: 0.4,
    };
    const overlayImport: EdgeForSlice = {
      fromSymbolId: symbolId,
      toSymbolId: "import-keep",
      edgeType: "import",
      weight: 0.6,
      confidence: 0.1,
    };

    const snapshot: OverlaySnapshot = {
      repoId,
      touchedFileIds: new Set([fileId]),
      symbolsById: new Map([[symbolId, makeSymbolRow()]]),
      filesById: new Map([[fileId, makeFileRow()]]),
      outgoingEdgesBySymbolId: new Map([
        [symbolId, [overlayCallLow, overlayImport]],
      ]),
    };

    const merged = mergeEdgeMapWithOverlay(
      snapshot,
      [symbolId],
      new Map(),
      0.8,
    );
    assert.deepStrictEqual(merged.get(symbolId), [overlayImport]);
  });

  it("mergeSymbolRowsWithOverlay prefers overlay symbol rows", () => {
    const overlaySymbol = makeSymbolRow({ summary: "overlay summary" });
    const durableSymbol = makeSymbolRow({ summary: "durable summary" });

    const snapshot: OverlaySnapshot = {
      repoId,
      touchedFileIds: new Set([fileId]),
      symbolsById: new Map([[symbolId, overlaySymbol]]),
      filesById: new Map([[fileId, makeFileRow()]]),
      outgoingEdgesBySymbolId: new Map(),
    };

    const merged = mergeSymbolRowsWithOverlay(
      snapshot,
      [symbolId],
      new Map([[symbolId, durableSymbol]]),
    );

    assert.strictEqual(merged.get(symbolId)?.summary, "overlay summary");
  });
});
