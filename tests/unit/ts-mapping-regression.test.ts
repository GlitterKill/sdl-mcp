import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { closeLadybugDb, getLadybugConn, initLadybugDb } from "../../src/db/ladybug.js";
import * as ladybugDb from "../../src/db/ladybug-queries.js";
import { mapDiagnosticsToSymbols } from "../../src/ts/mapping.js";
import type { Diagnostic } from "../../src/ts/diagnostics.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe("TS diagnostic mapping regression", () => {
  const dbPath = join(tmpdir(), ".lbug-ts-mapping-regression-db");
  const repoRoot = join(__dirname, ".tmp-ts-mapping-repo-root");
  const repoId = "ts-mapping-regression-repo";
  const fileId = "ts-mapping-file";

  beforeEach(async () => {
    if (existsSync(dbPath)) {
      rmSync(dbPath, { recursive: true, force: true });
    }
    if (existsSync(repoRoot)) {
      rmSync(repoRoot, { recursive: true, force: true });
    }

    await closeLadybugDb();
    await initLadybugDb(dbPath);

    const conn = await getLadybugConn();
    const now = new Date().toISOString();

    await ladybugDb.upsertRepo(conn, {
      repoId,
      rootPath: repoRoot,
      configJson: JSON.stringify({
        repoId,
        rootPath: repoRoot,
        ignore: [],
        languages: ["ts"],
        maxFileBytes: 2_000_000,
        includeNodeModulesTypes: true,
        packageJsonPath: null,
        tsconfigPath: null,
        workspaceGlobs: null,
      }),
      createdAt: now,
    });

    await ladybugDb.upsertFile(conn, {
      fileId,
      repoId,
      relPath: "src/index.ts",
      contentHash: "content-hash",
      language: "ts",
      byteSize: 123,
      lastIndexedAt: now,
    });
  });

  afterEach(async () => {
    await closeLadybugDb();
    if (existsSync(dbPath)) {
      rmSync(dbPath, { recursive: true, force: true });
    }
    if (existsSync(repoRoot)) {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("chooses the most specific overlapping symbol", async () => {
    const conn = await getLadybugConn();
    const now = new Date().toISOString();

    const outer = {
      symbolId: "symbol-outer",
      repoId,
      fileId,
      kind: "function",
      name: "outer",
      exported: true,
      visibility: "public",
      language: "ts",
      rangeStartLine: 5,
      rangeStartCol: 0,
      rangeEndLine: 30,
      rangeEndCol: 1,
      astFingerprint: "outer-fp",
      signatureJson: null,
      summary: "outer symbol",
      invariantsJson: null,
      sideEffectsJson: null,
      updatedAt: now,
    } as const;
    const inner = {
      ...outer,
      symbolId: "symbol-inner",
      name: "inner",
      rangeStartLine: 10,
      rangeStartCol: 0,
      rangeEndLine: 12,
      rangeEndCol: 1,
      astFingerprint: "inner-fp",
      summary: "inner symbol",
    } as const;

    await ladybugDb.upsertSymbol(conn, outer);
    await ladybugDb.upsertSymbol(conn, inner);

    const diagnostics: Diagnostic[] = [
      {
        filePath: join(repoRoot, "src/index.ts"),
        startLine: 11,
        startCol: 1,
        endLine: 11,
        endCol: 9,
        code: 1001,
        message: "overlapping diagnostic",
        severity: "error",
      },
    ];

    const suspects = await mapDiagnosticsToSymbols({ repoId, diagnostics });

    assert.equal(suspects.length, 1);
    assert.equal(suspects[0]?.symbolId, "symbol-inner");
    assert.equal(suspects[0]?.file, "src/index.ts");
    assert.equal(suspects[0]?.code, 1001);
  });
});
