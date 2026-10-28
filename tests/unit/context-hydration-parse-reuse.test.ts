import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";

import * as skeleton from "../../dist/code/skeleton.js";
import type { PreparedHotPath } from "../../dist/code/hotpath.js";
import type { PreparedContextHydrationPlan } from "../../dist/context/hydrate.js";
import type { SelectedContextBundle } from "../../dist/context/types.js";

it("reuses parsed source only within a hydration request, preserving rendering and source checks", async (t) => {
  let parses = 0;
  t.mock.module("../../dist/code/skeleton.js", {
    namedExports: {
      ...skeleton,
      parseFile: (...args: Parameters<typeof skeleton.parseFile>) => {
        parses++;
        return skeleton.parseFile(...args);
      },
    },
  });
  const { hydrateContextBundles } = await import("../../dist/context/hydrate.js");
  const { renderPreparedHotPath } = await import("../../dist/code/hotpath.js");
  const source = "function alpha() { return 1; }\nfunction beta() { return 2; }\n";
  const overlaySnapshot = {
    repoId: "repo", touchedFileIds: new Set<string>(), symbolsById: new Map(),
    filesById: new Map(), outgoingEdgesBySymbolId: new Map(),
  };
  const capture = (name: string, line: number, content = source): PreparedHotPath => ({
    symbol: {
      symbolId: name, repoId: "repo", fileId: "file", kind: "function", name,
      exported: true, visibility: "public", language: "ts",
      rangeStartLine: line, rangeStartCol: 0, rangeEndLine: line,
      rangeEndCol: content.split("\n")[line - 1].length,
      astFingerprint: name, signatureJson: null, summary: null, invariantsJson: null,
      sideEffectsJson: null, updatedAt: "2026-10-28T00:00:00.000Z",
    },
    filePath: "/unused/overlay.ts", relativePath: "src/shared.ts", extension: "ts",
    sourceKind: "overlay", capturedContent: content,
    capturedContentHash: createHash("sha256").update(content).digest("hex"),
  });
  const alpha = capture("alpha", 1);
  const beta = capture("beta", 2);
  const hydrate = (captures: PreparedHotPath[], includeSkeleton = false) => {
    const selected: SelectedContextBundle[] = captures.map((prepared, rank) => ({
      candidate: {
        symbolId: prepared.symbol.symbolId, path: prepared.relativePath, rank,
        tier: 1, lanes: ["overlay"], estimates: {},
      },
      rungs: includeSkeleton ? ["skeleton", "hotPath"] : ["hotPath"],
    }));
    const prepared: PreparedContextHydrationPlan = {
      selected, cards: [], durableEdges: new Map(),
      skeletons: new Map(captures.map((item) => [item.symbol.symbolId, item])),
      hotPaths: new Map(captures.map((item) => [item.symbol.symbolId, item])),
      overlaySnapshot,
    };
    return hydrateContextBundles({
      conn: {} as never, repoId: "repo", versionId: "v1", selected,
      identifiers: ["return"], overlaySnapshot, prepared,
    });
  };

  const first = await hydrate([alpha, beta]);
  assert.equal(first.evidence.length, 2);
  assert.equal(parses, 1, "two symbols in identical source must share a parse");
  for (const [index, prepared] of [alpha, beta].entries()) {
    assert.deepEqual(first.evidence[index].content,
      await renderPreparedHotPath(prepared, ["return"], { maxLines: 80, maxTokens: 300 }));
  }
  parses = 0;
  assert.deepEqual(await hydrate([alpha, beta]), first);
  assert.equal(parses, 1, "a later request must create its own parsed source");

  parses = 0;
  const bothRungs = await hydrate([alpha, beta], true);
  assert.equal(bothRungs.evidence.length, 4);
  assert.equal(parses, 1, "skeletons and hot paths must share the same immutable parse");
  for (const [index, prepared] of [alpha, beta].entries()) {
    assert.deepEqual(bothRungs.evidence[index * 2].content,
      await skeleton.renderPreparedSymbolSkeleton(prepared, { maxLines: 100, maxTokens: 128 }));
  }

  parses = 0;
  const changed = capture("beta", 2, source.replace("return 2", "return 9"));
  const changedResult = await hydrate([alpha, changed]);
  assert.equal(parses, 2, "different captured bytes must not reuse the old tree");
  assert.match(JSON.stringify(changedResult.evidence[1].content), /return 9/);

  parses = 0;
  await hydrate([alpha, { ...beta, extension: "tsx" }]);
  assert.equal(parses, 2, "grammar is part of the parse identity");

  const directory = await mkdtemp(join(tmpdir(), "sdl-context-parse-"));
  try {
    const filePath = join(directory, "shared.ts");
    await writeFile(filePath, source.replace("return 2", "return 9"));
    parses = 0;
    const stale = await hydrate([alpha, { ...beta, sourceKind: "durable", filePath }]);
    assert.deepEqual(stale.evidence.map(({ symbolId }) => symbolId), ["alpha"]);
    assert.equal(stale.unavailable.length, 1);
    assert.equal(parses, 1, "stale durable bytes must fail validation before cache access");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
