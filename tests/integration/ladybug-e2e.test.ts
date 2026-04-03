import { describe, before, after, it } from "node:test";
import assert from "node:assert";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  closeLadybugDb,
  getLadybugConn,
  initLadybugDb,
} from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import type { SymbolRow } from "../../dist/db/ladybug-queries.js";
import { indexRepo } from "../../dist/indexer/indexer.js";
import { buildSlice } from "../../dist/graph/slice.js";
import { buildRepoOverview } from "../../dist/graph/overview.js";
import { computeDelta } from "../../dist/delta/diff.js";
import { runGovernorLoop } from "../../dist/delta/blastRadius.js";
import { handleSymbolGetCard } from "../../dist/mcp/tools/symbol.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const REPO_ID = "test-ladybug-e2e-repo";

/** Reliable recursive directory copy (cpSync is experimental before Node 22). */
function copyDirSync(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    if (statSync(srcPath).isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

function findSymbol(
  symbols: SymbolRow[],
  name: string,
  kind: string = "function",
): SymbolRow {
  const match = symbols.find((s) => s.name === name && s.kind === kind);
  if (!match) {
    const byName = symbols.filter((s) => s.name === name);
    const hint =
      byName.length > 0
        ? ` (found with kinds: ${byName.map((s) => s.kind).join(", ")})`
        : ` (not found at all among ${symbols.length} symbols)`;
    assert.fail(`Expected symbol ${kind}:${name} to exist${hint}`);
  }
  return match;
}

describe("Ladybug E2E (clusters + processes + slices + delta)", () => {
  const fixtureRoot = join(__dirname, "..", "fixtures", "clustered-repo");
  let graphDbPath = "";
  let configPath = "";
  let repoDir: string | null = null;
  const prevSDL_CONFIG = process.env.SDL_CONFIG;
  const prevSDL_CONFIG_PATH = process.env.SDL_CONFIG_PATH;

  before(async () => {
    if (!existsSync(fixtureRoot)) {
      throw new Error(`Fixture not found: ${fixtureRoot}`);
    }

    graphDbPath = mkdtempSync(join(tmpdir(), "sdl-mcp-e2e-test-db-"));
    configPath = join(graphDbPath, "test-config.json");

    repoDir = mkdtempSync(join(tmpdir(), "sdl-mcp-ladybug-e2e-repo-"));
    copyDirSync(fixtureRoot, repoDir);

    writeFileSync(
      configPath,
      JSON.stringify(
        {
          repos: [],
          policy: {},
          indexing: { engine: "typescript", enableFileWatching: false },
        },
        null,
        2,
      ),
      "utf8",
    );

    process.env.SDL_CONFIG = configPath;
    delete process.env.SDL_CONFIG_PATH;

    await closeLadybugDb();
    await initLadybugDb(graphDbPath);
    const conn = await getLadybugConn();

    const now = new Date().toISOString();
    await ladybugDb.upsertRepo(conn, {
      repoId: REPO_ID,
      rootPath: repoDir,
      configJson: JSON.stringify({
        repoId: REPO_ID,
        rootPath: repoDir,
        ignore: [],
        languages: ["ts"],
        maxFileBytes: 2_000_000,
        includeNodeModulesTypes: true,
        packageJsonPath: "package.json",
        tsconfigPath: "tsconfig.json",
        workspaceGlobs: null,
      }),
      createdAt: now,
    });
  });

  after(async () => {
    await closeLadybugDb();

    if (prevSDL_CONFIG === undefined) {
      delete process.env.SDL_CONFIG;
    } else {
      process.env.SDL_CONFIG = prevSDL_CONFIG;
    }
    if (prevSDL_CONFIG_PATH === undefined) {
      delete process.env.SDL_CONFIG_PATH;
    } else {
      process.env.SDL_CONFIG_PATH = prevSDL_CONFIG_PATH;
    }

    try {
      rmSync(graphDbPath, { recursive: true, force: true });
    } catch {
      // ignore
    }
    if (repoDir) {
      try {
        rmSync(repoDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
      repoDir = null;
    }
  });

  it("indexes fixture, detects clusters/processes, builds slice, and computes process blast radius", async () => {
    assert.ok(repoDir, "repoDir should be initialized in before()");

    const full = await indexRepo(REPO_ID, "full");
    assert.ok(full.versionId.length > 0);

    const conn = await getLadybugConn();
    const clusters = await ladybugDb.getClustersForRepo(conn, REPO_ID);
    assert.ok(
      clusters.length >= 2,
      `Expected >=2 clusters, got ${clusters.length}`,
    );

    const procStats = await ladybugDb.getProcessOverviewStats(conn, REPO_ID);
    assert.strictEqual(procStats.totalProcesses, 2);
    assert.strictEqual(procStats.entryPoints, 2);

    const symbols = await ladybugDb.getSymbolsByRepo(conn, REPO_ID);

    const login = findSymbol(symbols, "login");
    const session = findSymbol(symbols, "session");
    const token = findSymbol(symbols, "token");
    const query = findSymbol(symbols, "query");
    const transform = findSymbol(symbols, "transform");
    const cache = findSymbol(symbols, "cache");
    const routesApi = findSymbol(symbols, "routesApi");
    const loginHandler = findSymbol(symbols, "loginhandler");
    const dataHandler = findSymbol(symbols, "datahandler");
    const middleware = findSymbol(symbols, "middleware");

    const authCluster = await ladybugDb.getClusterForSymbol(
      conn,
      login.symbolId,
    );
    const dataCluster = await ladybugDb.getClusterForSymbol(
      conn,
      query.symbolId,
    );
    const apiCluster = await ladybugDb.getClusterForSymbol(
      conn,
      routesApi.symbolId,
    );

    assert.ok(authCluster);
    assert.ok(dataCluster);
    assert.ok(apiCluster);

    const authMembers = [
      await ladybugDb.getClusterForSymbol(conn, session.symbolId),
      await ladybugDb.getClusterForSymbol(conn, token.symbolId),
    ];
    assert.ok(authMembers[0] && authMembers[1]);
    assert.strictEqual(authMembers[0].clusterId, authCluster.clusterId);
    assert.strictEqual(authMembers[1].clusterId, authCluster.clusterId);

    const dataMembers = [
      await ladybugDb.getClusterForSymbol(conn, transform.symbolId),
      await ladybugDb.getClusterForSymbol(conn, cache.symbolId),
    ];
    assert.ok(dataMembers[0] && dataMembers[1]);
    assert.strictEqual(dataMembers[0].clusterId, dataCluster.clusterId);
    assert.strictEqual(dataMembers[1].clusterId, dataCluster.clusterId);

    const apiMembers = [
      await ladybugDb.getClusterForSymbol(conn, loginHandler.symbolId),
      await ladybugDb.getClusterForSymbol(conn, dataHandler.symbolId),
      await ladybugDb.getClusterForSymbol(conn, middleware.symbolId),
    ];
    assert.ok(apiMembers[0] && apiMembers[1] && apiMembers[2]);
    assert.strictEqual(apiMembers[0].clusterId, apiCluster.clusterId);
    assert.strictEqual(apiMembers[1].clusterId, apiCluster.clusterId);
    assert.strictEqual(apiMembers[2].clusterId, apiCluster.clusterId);

    // Auth and data clusters should always be distinct (no direct edges between them).
    // API cluster may merge with either one depending on edge resolution, so we only
    // require at least 2 distinct clusters across all three groups.
    assert.notStrictEqual(authCluster.clusterId, dataCluster.clusterId);
    const distinctClusterIds = new Set([
      authCluster.clusterId,
      dataCluster.clusterId,
      apiCluster.clusterId,
    ]);
    assert.ok(
      distinctClusterIds.size >= 2,
      `Expected >=2 distinct clusters, got ${distinctClusterIds.size}`,
    );

    const loginProcesses = await ladybugDb.getProcessesForSymbol(
      conn,
      loginHandler.symbolId,
    );
    assert.ok(loginProcesses.length >= 1);
    assert.strictEqual(loginProcesses[0]!.stepOrder, 0);
    assert.strictEqual(loginProcesses[0]!.role, "entry");

    const loginFlow = await ladybugDb.getProcessFlow(
      conn,
      loginProcesses[0]!.processId,
    );
    const nameById = new Map(symbols.map((s) => [s.symbolId, s.name] as const));
    const loginNames = loginFlow.map((step) => nameById.get(step.symbolId));
    for (const expected of ["loginhandler", "login", "session", "token"]) {
      assert.ok(
        loginNames.includes(expected),
        `Expected login process to include ${expected}`,
      );
    }

    const dataProcesses = await ladybugDb.getProcessesForSymbol(
      conn,
      dataHandler.symbolId,
    );
    assert.ok(dataProcesses.length >= 1);
    assert.strictEqual(dataProcesses[0]!.stepOrder, 0);
    assert.strictEqual(dataProcesses[0]!.role, "entry");

    const dataFlow = await ladybugDb.getProcessFlow(
      conn,
      dataProcesses[0]!.processId,
    );
    const dataNames = dataFlow.map((step) => nameById.get(step.symbolId));
    for (const expected of ["datahandler", "query", "transform", "cache"]) {
      assert.ok(
        dataNames.includes(expected),
        `Expected data process to include ${expected}`,
      );
    }

    const chainEdges = await ladybugDb.getEdgesFromSymbolsLite(conn, [
      loginHandler.symbolId,
      login.symbolId,
      session.symbolId,
      dataHandler.symbolId,
      query.symbolId,
      transform.symbolId,
    ]);

    const hasCall = (fromId: string, toId: string): boolean =>
      (chainEdges.get(fromId) ?? []).some(
        (e) => e.edgeType === "call" && e.toSymbolId === toId,
      );

    assert.ok(hasCall(loginHandler.symbolId, login.symbolId));
    assert.ok(hasCall(login.symbolId, session.symbolId));
    assert.ok(hasCall(session.symbolId, token.symbolId));

    assert.ok(hasCall(dataHandler.symbolId, query.symbolId));
    assert.ok(hasCall(query.symbolId, transform.symbolId));
    assert.ok(hasCall(transform.symbolId, cache.symbolId));

    const { slice } = await buildSlice({
      repoId: REPO_ID,
      versionId: full.versionId,
      conn,
      entrySymbols: [routesApi.symbolId, loginHandler.symbolId],
      taskText: "inspect api routes and related logic",
      budget: { maxCards: 20, maxEstimatedTokens: 20_000 },
      cardDetail: "deps",
      minConfidence: 0,
    });
    assert.ok(slice.cards.some((c) => c.symbolId === routesApi.symbolId));
    assert.ok(slice.cards.some((c) => c.symbolId === middleware.symbolId));
    assert.ok(slice.cards.some((c) => c.symbolId === loginHandler.symbolId));
    assert.ok(slice.cards.some((c) => c.symbolId === dataHandler.symbolId));

    const entryClusterId = slice.cards.find(
      (c) => c.symbolId === routesApi.symbolId,
    )?.cluster?.clusterId;
    assert.strictEqual(entryClusterId, apiCluster.clusterId);

    const sameClusterCount = slice.cards.filter(
      (c) => c.cluster?.clusterId === entryClusterId,
    ).length;
    assert.ok(
      sameClusterCount >= 2,
      `Expected >=2 same-cluster symbols in slice, got ${sameClusterCount}`,
    );

    const beforeVersion = full.versionId;

    // Change login.ts structurally to force AST fingerprint change (literals are ignored in subtree hash).
    const loginPath = join(repoDir, "src", "auth", "login.ts");
    writeFileSync(
      loginPath,
      [
        'import { session } from "./session";',
        "",
        "export function login(user: string): string {",
        "  const normalizedUser = user;",
        "  return session(normalizedUser);",
        "}",
        "",
        "function loginAudit(user: string): string {",
        "  return login(user);",
        "}",
        "",
        "export function loginAuditEntry(): string {",
        '  return loginAudit("audit");',
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    // Ensure the file's mtime is strictly in the future so the incremental
    // scanner detects the change even if writeFileSync completed within the
    // same millisecond as the previous index's lastIndexedAt timestamp.
    const futureTime = new Date(Date.now() + 2000);
    utimesSync(loginPath, futureTime, futureTime);

    const inc = await indexRepo(REPO_ID, "incremental");
    const afterVersion = inc.versionId;
    assert.notStrictEqual(afterVersion, beforeVersion);

    const delta = await computeDelta(REPO_ID, beforeVersion, afterVersion);
    const changedSymbolIds = delta.changedSymbols.map((c) => c.symbolId);
    assert.ok(changedSymbolIds.length > 0);

    const governor = await runGovernorLoop(conn, changedSymbolIds, {
      repoId: REPO_ID,
      budget: { maxCards: 50, maxEstimatedTokens: 50_000 },
      runDiagnostics: false,
      fromVersionId: beforeVersion,
      toVersionId: afterVersion,
    });

    const blastItems = governor.blastRadius;
    assert.ok(blastItems.length > 0);

    const blastSymbolIds = Array.from(
      new Set(blastItems.map((i) => i.symbolId)),
    );
    const blastSymbols = await ladybugDb.getSymbolsByIds(conn, blastSymbolIds);
    const blastNameById = new Map(
      Array.from(blastSymbols.values()).map(
        (s) => [s.symbolId, s.name] as const,
      ),
    );

    const byName = new Map<string, { symbolId: string; signal: string }>();
    for (const item of blastItems) {
      const name = blastNameById.get(item.symbolId);
      if (!name) continue;
      if (!byName.has(name)) {
        byName.set(name, { symbolId: item.symbolId, signal: item.signal });
      }
    }

    assert.strictEqual(byName.get("session")?.signal, "process");
    assert.strictEqual(byName.get("token")?.signal, "process");

    const cardResponse = await handleSymbolGetCard({
      repoId: REPO_ID,
      symbolId: loginHandler.symbolId,
    });
    if ("notModified" in cardResponse) {
      throw new Error("Expected full card response, got notModified");
    }
    assert.ok(cardResponse.card.cluster);
    assert.ok(Array.isArray(cardResponse.card.processes));
    assert.ok(cardResponse.card.processes.length >= 1);

    const clustersAfterIncremental = await ladybugDb.getClustersForRepo(
      conn,
      REPO_ID,
    );
    assert.ok(
      clustersAfterIncremental.length >= 1,
      "Expected at least one cluster after incremental reindex",
    );

    const overview = await buildRepoOverview({
      repoId: REPO_ID,
      level: "stats",
    });
    assert.ok(overview.clusters);
    assert.strictEqual(
      overview.clusters.totalClusters,
      clustersAfterIncremental.length,
      "Overview cluster stats should match persisted cluster rows after incremental reindex",
    );
    assert.ok(overview.processes);
    assert.strictEqual(overview.processes.totalProcesses, 2);
  });
});
