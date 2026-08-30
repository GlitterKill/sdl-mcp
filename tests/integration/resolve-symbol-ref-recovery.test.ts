import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const REPO_ID = "resolve-symbol-ref-recovery";
const DB_PATH = join(
  tmpdir(),
  `.lbug-resolve-symbol-ref-recovery-${process.pid}.lbug`,
);
const CONFIG_PATH = join(
  tmpdir(),
  `sdl-resolve-symbol-ref-recovery-${process.pid}.json`,
);
const previousConfig = process.env.SDL_CONFIG;
const previousDbPath = process.env.SDL_GRAPH_DB_PATH;

let conn: import("kuzu").Connection;
let closeLadybugDb: () => Promise<void>;
let resolveSymbolRef: typeof import(
  "../../dist/util/resolve-symbol-ref.js"
).resolveSymbolRef;
let searchSymbolsWithOverlay: typeof import(
  "../../dist/live-index/overlay-reader.js"
).searchSymbolsWithOverlay;

function removeTestFile(path: string): void {
  if (existsSync(path)) rmSync(path, { force: true });
}

function suggestionNames(
  result: Extract<Awaited<ReturnType<typeof resolveSymbolRef>>, {
    status: "not_found";
  }>,
): string[] {
  return result.candidates.map(({ name }) => name);
}

function assertHintMatchesCandidates(
  result: Extract<Awaited<ReturnType<typeof resolveSymbolRef>>, {
    status: "not_found";
  }>,
): void {
  const expectedHint =
    result.candidates.length === 0
      ? ""
      : ` Did you mean: ${result.candidates
          .map(({ name, file }) => `"${name}" (${file})`)
          .join(", ")}?`;
  assert.equal(result.message.includes("Did you mean:"), expectedHint.length > 0);
  if (expectedHint) assert.ok(result.message.endsWith(expectedHint));
}

describe("resolveSymbolRef missing-symbol recovery", () => {
  before(async () => {
    removeTestFile(DB_PATH);
    removeTestFile(`${DB_PATH}.wal`);
    removeTestFile(`${DB_PATH}.sdl-lineage.json`);
    removeTestFile(CONFIG_PATH);
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({
        repos: [],
        policy: {},
        semantic: { enabled: false },
        liveIndex: { enabled: false },
      }),
      "utf8",
    );
    process.env.SDL_CONFIG = CONFIG_PATH;
    process.env.SDL_GRAPH_DB_PATH = DB_PATH;

    const [ladybug, queries, resolver, overlay] = await Promise.all([
      import("../../dist/db/ladybug.js"),
      import("../../dist/db/ladybug-queries.js"),
      import("../../dist/util/resolve-symbol-ref.js"),
      import("../../dist/live-index/overlay-reader.js"),
    ]);
    closeLadybugDb = ladybug.closeLadybugDb;
    resolveSymbolRef = resolver.resolveSymbolRef;
    searchSymbolsWithOverlay = overlay.searchSymbolsWithOverlay;

    await closeLadybugDb();
    await ladybug.initLadybugDb(DB_PATH);
    conn = await ladybug.getLadybugConn();
    const now = "2026-07-26T00:00:00.000Z";

    await queries.upsertRepo(conn, {
      repoId: REPO_ID,
      rootPath: "C:/tmp/resolve-symbol-ref-recovery",
      configJson: "{}",
      createdAt: now,
    });
    await queries.upsertFile(conn, {
      fileId: "file-handler",
      repoId: REPO_ID,
      relPath: "src/handler.ts",
      contentHash: "handler-hash",
      language: "typescript",
      byteSize: 1,
      lastIndexedAt: now,
    });
    await queries.upsertSymbol(conn, {
      symbolId: "symbol-handle-request",
      repoId: REPO_ID,
      fileId: "file-handler",
      kind: "function",
      name: "handleRequest",
      exported: true,
      visibility: "public",
      language: "typescript",
      rangeStartLine: 1,
      rangeStartCol: 0,
      rangeEndLine: 1,
      rangeEndCol: 1,
      astFingerprint: "handle-request-fingerprint",
      signatureJson: null,
      summary: "Handle a request.",
      searchText: "handleRequest handle request",
      invariantsJson: null,
      sideEffectsJson: null,
      updatedAt: now,
    });
  });

  after(async () => {
    await closeLadybugDb?.();
    removeTestFile(DB_PATH);
    removeTestFile(`${DB_PATH}.wal`);
    removeTestFile(`${DB_PATH}.sdl-lineage.json`);
    removeTestFile(CONFIG_PATH);

    if (previousConfig === undefined) delete process.env.SDL_CONFIG;
    else process.env.SDL_CONFIG = previousConfig;
    if (previousDbPath === undefined) delete process.env.SDL_GRAPH_DB_PATH;
    else process.env.SDL_GRAPH_DB_PATH = previousDbPath;
  });

  it("keeps a strong close-typo candidate after ranking removes every row", async () => {
    const name = "handleReqeust";
    const initialRows = await searchSymbolsWithOverlay(conn, REPO_ID, name, 50);
    assert.ok(initialRows.length > 0);

    const result = await resolveSymbolRef(conn, REPO_ID, { name });
    assert.equal(result.status, "not_found");
    if (result.status !== "not_found") return;

    assert.ok(result.candidates.length <= 3);
    assert.ok(result.candidates.every(({ score }) => score >= 0.35));
    assert.ok(suggestionNames(result).includes("handleRequest"));
    assertHintMatchesCandidates(result);
  });

  it("omits irrelevant recovery candidates and hint text", async () => {
    const result = await resolveSymbolRef(conn, REPO_ID, {
      name: "zzzzNoMatchxxxx",
    });
    assert.equal(result.status, "not_found");
    if (result.status !== "not_found") return;
    assert.deepEqual(result.candidates, []);
    assertHintMatchesCandidates(result);
  });

  it("preserves high-confidence fuzzy auto-resolution", async () => {
    const result = await resolveSymbolRef(conn, REPO_ID, {
      name: "handleReq",
      file: "src/handler.ts",
      kind: "function",
      exportedOnly: true,
    });
    assert.equal(result.status, "resolved");
    if (result.status === "resolved") {
      assert.equal(result.symbolId, "symbol-handle-request");
    }
  });
});
