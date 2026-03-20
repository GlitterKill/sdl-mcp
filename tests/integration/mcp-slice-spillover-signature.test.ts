import { after, before, describe, it } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { closeLadybugDb, getLadybugConn, initLadybugDb } from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import { handleSliceSpilloverGet } from "../../dist/mcp/tools/slice.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEST_DB_PATH = join(tmpdir(), ".lbug-mcp-slice-spillover-signature-test-db.lbug");

describe("MCP slice spillover signatures", () => {
  const repoId = "mcp-slice-spillover-signature-repo";
  const symbolId = "sym-rust-spillover";
  const spilloverHandle = "spillover-handle-1";

  before(async () => {
    if (existsSync(TEST_DB_PATH)) {
      rmSync(TEST_DB_PATH, { recursive: true, force: true });
    }
    mkdirSync(dirname(TEST_DB_PATH), { recursive: true });

    await closeLadybugDb();
    await initLadybugDb(TEST_DB_PATH);
    const conn = await getLadybugConn();
    const now = "2026-03-11T14:30:00.000Z";

    await ladybugDb.upsertRepo(conn, {
      repoId,
      rootPath: "C:/repo",
      configJson: JSON.stringify({ policy: {} }),
      createdAt: now,
    });

    await ladybugDb.createVersion(conn, {
      versionId: "v1",
      repoId,
      createdAt: now,
      reason: "integration",
      prevVersionHash: null,
      versionHash: "v1-hash",
    });

    await ladybugDb.upsertFile(conn, {
      fileId: "file-rs-1",
      repoId,
      relPath: "src/lib.rs",
      contentHash: "hash-rs-1",
      language: "rs",
      byteSize: 256,
      lastIndexedAt: now,
    });

    await ladybugDb.upsertSymbol(conn, {
      symbolId,
      repoId,
      fileId: "file-rs-1",
      kind: "function",
      name: "compute_total",
      exported: true,
      visibility: "public",
      language: "rust",
      rangeStartLine: 10,
      rangeStartCol: 0,
      rangeEndLine: 18,
      rangeEndCol: 1,
      astFingerprint: "sym-rust-spillover-fp",
      signatureJson: JSON.stringify({
        params: [{ name: "input", type: "&Item" }],
        returns: "Result<i64>",
        generics: ["T"],
      }),
      summary: "Computes totals for spillover regression coverage.",
      invariantsJson: null,
      sideEffectsJson: null,
      updatedAt: now,
    });

    await ladybugDb.upsertSliceHandle(conn, {
      handle: spilloverHandle,
      repoId,
      createdAt: now,
      expiresAt: "2026-03-12T14:30:00.000Z",
      minVersion: "v1",
      maxVersion: "v1",
      sliceHash: "slice-hash-1",
      spilloverRef: JSON.stringify([
        {
          symbolId,
          reason: "budget",
          priority: "should",
        },
      ]),
    });
  });

  after(async () => {
    await closeLadybugDb();
    if (existsSync(TEST_DB_PATH)) {
      rmSync(TEST_DB_PATH, { recursive: true, force: true });
    }
  });

  it("preserves stored signature details even when signatureJson omits name", async () => {
    const response = await handleSliceSpilloverGet({ spilloverHandle });

    assert.equal(response.hasMore, false);
    assert.equal(response.symbols.length, 1);
    assert.deepStrictEqual(response.symbols[0]?.signature, {
      name: "compute_total",
      params: [{ name: "input", type: "&Item" }],
      returns: "Result<i64>",
      generics: ["T"],
    });
  });
});
