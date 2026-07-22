import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { invalidateConfigCache } from "../../dist/config/loadConfig.js";
import { beginGraphIntegrityVersion } from "../../dist/db/ladybug-derived-state.js";
import {
  closeLadybugDb,
  getLadybugConn,
  initLadybugDb,
} from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import { handleRepoStatus } from "../../dist/mcp/tools/repo.js";
import { assertGraphRetrievalAvailable } from "../../dist/services/graph-retrieval-availability.js";

describe("equal-timestamp Version ordering", { concurrency: 1 }, () => {
  const root = mkdtempSync(join(tmpdir(), "sdl-version-ordering-"));
  const dbPath = join(root, "graph.lbug");
  const configPath = join(root, "sdlmcp.config.json");
  const previousConfig = process.env.SDL_CONFIG;
  const previousDbPath = process.env.SDL_GRAPH_DB_PATH;
  const createdAt = "2026-07-21T12:34:56.789Z";

  async function seedRepo(repoId: string, versionIds: string[]): Promise<void> {
    const conn = await getLadybugConn();
    await ladybugDb.upsertRepo(conn, {
      repoId,
      rootPath: root,
      configJson: JSON.stringify({
        repoId,
        rootPath: root,
        ignore: [],
        languages: ["ts"],
        maxFileBytes: 2_000_000,
      }),
      createdAt,
    });
    for (const versionId of versionIds) {
      await ladybugDb.createVersion(conn, {
        versionId,
        repoId,
        createdAt,
        reason: "equal-timestamp fixture",
        prevVersionHash: null,
        versionHash: null,
      });
    }
    await ladybugDb.replaceGraphIntegrityManifestInTransaction(conn, repoId, {
      files: [],
      fileless: [],
    });
    await beginGraphIntegrityVersion(
      conn,
      repoId,
      "v-new",
      "0".repeat(64),
      true,
    );
  }

  before(async () => {
    writeFileSync(
      configPath,
      JSON.stringify({ repos: [], policy: {}, semantic: { enabled: false } }),
      "utf8",
    );
    process.env.SDL_CONFIG = configPath;
    process.env.SDL_GRAPH_DB_PATH = dbPath;
    invalidateConfigCache();
    await closeLadybugDb();
    await initLadybugDb(dbPath);
    await seedRepo("forward", ["v-legacy", "v-new"]);
    await seedRepo("reverse", ["v-new", "v-legacy"]);
    const conn = await getLadybugConn();
    await ladybugDb.upsertRepo(conn, {
      repoId: "created-at-primary",
      rootPath: root,
      configJson: "{}",
      createdAt,
    });
    await ladybugDb.createVersion(conn, {
      versionId: "z-older",
      repoId: "created-at-primary",
      createdAt: "2026-07-21T12:34:56.788Z",
      reason: "older but lexically higher",
      prevVersionHash: null,
      versionHash: null,
    });
    await ladybugDb.createVersion(conn, {
      versionId: "a-newer",
      repoId: "created-at-primary",
      createdAt,
      reason: "newer but lexically lower",
      prevVersionHash: null,
      versionHash: null,
    });
  });

  after(async () => {
    await closeLadybugDb();
    if (previousConfig === undefined) delete process.env.SDL_CONFIG;
    else process.env.SDL_CONFIG = previousConfig;
    if (previousDbPath === undefined) delete process.env.SDL_GRAPH_DB_PATH;
    else process.env.SDL_GRAPH_DB_PATH = previousDbPath;
    invalidateConfigCache();
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  it("keeps createdAt primary and versionId descending as the deterministic tie-breaker", async () => {
    const conn = await getLadybugConn();

    for (const repoId of ["forward", "reverse"]) {
      assert.equal(
        (await ladybugDb.getLatestVersion(conn, repoId))?.versionId,
        "v-new",
      );
      assert.deepEqual(
        (await ladybugDb.getVersionsByRepo(conn, repoId)).map(
          (version) => version.versionId,
        ),
        ["v-new", "v-legacy"],
      );
      await assert.doesNotReject(() =>
        assertGraphRetrievalAvailable(conn, repoId),
      );

      const status = await handleRepoStatus({ repoId, detail: "full" });
      assert.equal(status.latestVersionId, "v-new");
      assert.deepEqual(
        status.recentVersions?.map((version) => version.versionId),
        ["v-new", "v-legacy"],
      );
    }

    assert.equal(
      (await ladybugDb.getLatestVersion(conn, "created-at-primary"))
        ?.versionId,
      "a-newer",
    );
    assert.deepEqual(
      (
        await ladybugDb.getVersionsByRepo(conn, "created-at-primary")
      ).map((version) => version.versionId),
      ["a-newer", "z-older"],
    );
  });
});
