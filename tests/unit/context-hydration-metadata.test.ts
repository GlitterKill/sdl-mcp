import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";

import * as queries from "../../dist/db/ladybug-queries.js";
import type { OverlaySnapshot } from "../../dist/live-index/overlay-reader.js";
import type { SelectedContextBundle } from "../../dist/context/types.js";

it("batches preparation metadata inside one request while preserving source and overlay validation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "sdl-prepare-metadata-"));
  const source = "function alpha() { return 1; }\nfunction beta() { return 2; }\n";
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  const file: queries.FileRow = {
    fileId: "file", repoId: "repo", relPath: "shared.ts", contentHash: hash(source),
    language: "ts", byteSize: source.length, lastIndexedAt: null, directory: ".",
  };
  const symbols = new Map(["alpha", "beta"].map((name, index) => [name, {
    symbolId: name, repoId: "repo", fileId: "file", kind: "function", name,
    exported: true, visibility: "public", language: "ts", rangeStartLine: index + 1,
    rangeStartCol: 0, rangeEndLine: index + 1, rangeEndCol: 30,
    astFingerprint: name, signatureJson: null, summary: null, invariantsJson: null,
    sideEffectsJson: null, updatedAt: "2026-10-28T00:00:00.000Z",
  } satisfies queries.SymbolRow]));
  const repo: queries.RepoRow = {
    repoId: "repo", rootPath: directory, configJson: "{}", createdAt: "2026-10-28",
  };
  let calls: string[] = [];
  t.mock.module("../../dist/db/ladybug-queries.js", { namedExports: {
    ...queries,
    getSymbol: async (_conn: unknown, id: string) => {
      calls.push("symbol"); return symbols.get(id) ?? null;
    },
    getSymbolsByIds: async (_conn: unknown, ids: string[]) => {
      calls.push("symbols");
      return new Map(ids.flatMap((id) => symbols.has(id) ? [[id, symbols.get(id)!]] : []));
    },
    getFilesByIds: async () => { calls.push("files"); return new Map([["file", file]]); },
    getRepo: async () => { calls.push("repo"); return repo; },
  } });
  const { prepareContextHydrationPlan } = await import("../../dist/context/hydrate.js");
  const { renderPreparedHotPath } = await import("../../dist/code/hotpath.js");
  const selected: SelectedContextBundle[] = [...symbols.keys()].map((symbolId, rank) => ({
    candidate: { symbolId, path: "shared.ts", rank, tier: 1, lanes: ["symbolFts"], estimates: {} },
    rungs: ["skeleton", "hotPath"],
  }));
  const overlaySnapshot: OverlaySnapshot = {
    repoId: "repo", touchedFileIds: new Set(), symbolsById: new Map(),
    filesById: new Map(), outgoingEdgesBySymbolId: new Map(),
  };
  const prepare = () => prepareContextHydrationPlan({
    conn: {} as never, repoId: "repo", versionId: "v1", selected, overlaySnapshot,
  }, { loadCards: async () => ({ cards: [], missingIds: [] }), loadEdges: async () => new Map() });
  try {
    await writeFile(join(directory, "shared.ts"), source);
    const first = await prepare();
    assert.ok(first.hotPaths.get("alpha"));
    assert.ok(first.skeletons.get("beta"));
    assert.deepEqual(calls, ["symbols", "files", "repo"],
      "metadata should be batched once for both symbols and both source rungs");

    await writeFile(join(directory, "shared.ts"), source.replace("return 1", "return 9"));
    assert.equal(await renderPreparedHotPath(first.hotPaths.get("alpha")!, []), null,
      "render-time mutation detection must remain active");
    calls = [];
    const stale = await prepare();
    assert.equal(stale.hotPaths.get("alpha"), null);
    assert.equal(stale.skeletons.get("beta"), null);
    assert.deepEqual(calls, ["symbols", "files", "repo"], "later requests must reload metadata");

    const validSelection = [...selected];
    symbols.set("foreign", { ...symbols.get("alpha")!, symbolId: "foreign", repoId: "other" });
    for (const symbolId of ["missing", "foreign"]) {
      selected.splice(0, selected.length, {
        ...validSelection[0], candidate: { ...validSelection[0].candidate, symbolId },
      });
      calls = [];
      const unavailable = await prepare();
      assert.equal(unavailable.skeletons.get(symbolId), null);
      assert.equal(unavailable.hotPaths.get(symbolId), null);
      assert.deepEqual(calls, ["symbols"], "missing/foreign symbols must stop before file/repo lookup");
    }
    selected.splice(0, selected.length, ...validSelection);
    symbols.delete("foreign");
    const crlf = source.replaceAll("\n", "\r\n");
    await writeFile(join(directory, "shared.ts"), crlf);
    assert.equal((await prepare()).hotPaths.get("alpha"), null,
      "normalized content equality must not bypass the raw indexed hash");
    file.contentHash = hash(crlf);
    assert.ok((await prepare()).hotPaths.get("alpha"), "matching raw CRLF hash remains usable");

    const draft = source.replace("return 1", "return 7");
    overlaySnapshot.touchedFileIds.add("file");
    overlaySnapshot.symbolsById = new Map(symbols);
    overlaySnapshot.filesById.set("file", { ...file, contentHash: hash(draft) });
    overlaySnapshot.contentByFileId = new Map([["file", draft]]);
    calls = [];
    const overlay = await prepare();
    assert.deepEqual(calls, [], "captured draft source needs no durable metadata reads");
    assert.equal(overlay.hotPaths.get("alpha")?.capturedContent, draft);
    assert.equal(overlay.skeletons.get("beta")?.capturedContent, draft);
    assert.equal(first.hotPaths.get("alpha")?.sourceKind, "durable");
    overlaySnapshot.contentByFileId.set("file", source);
    assert.equal(overlay.hotPaths.get("alpha")?.capturedContent, draft,
      "a captured plan must not follow later overlay mutation");

    overlaySnapshot.contentByFileId.clear();
    for (const bundle of selected) bundle.rungs = ["hotPath"];
    calls = [];
    const missingDraft = await prepare();
    assert.equal(missingDraft.hotPaths.get("alpha"), null);
    assert.deepEqual(calls, [], "hot-path drafts without bytes must not consult durable metadata");
    for (const bundle of selected) bundle.rungs = ["skeleton"];
    calls = [];
    const skeletonFallback = await prepare();
    assert.equal(skeletonFallback.skeletons.get("alpha")?.sourceKind, "durable");
    assert.deepEqual(calls, ["symbols", "files", "repo"],
      "skeletons retain their validated durable fallback for a draft without bytes");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
