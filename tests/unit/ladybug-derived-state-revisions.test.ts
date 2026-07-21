import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

interface RevisionApi {
  beginGraphIntegrityVersion(
    conn: import("kuzu").Connection,
    repoId: string,
    versionId: string,
    digest: string,
    pruningSupported: boolean,
  ): Promise<void>;
  advanceGraphIntegrityRevisionInTransaction(
    conn: import("kuzu").Connection,
    repoId: string,
    versionId: string,
    expectedRevision: number,
  ): Promise<number | null>;
  markGraphIntegrityVerifiedIfVerifying(
    repoId: string,
    versionId: string,
    revision: number,
    digest: string,
  ): Promise<boolean>;
  markGraphIntegrityFailedIfVerifying(
    repoId: string,
    versionId: string,
    revision: number,
    error: string,
  ): Promise<boolean>;
  markUnrevisionedGraphIntegrityFailedIfVerifying(
    repoId: string,
    versionId: string,
    error: string,
  ): Promise<boolean>;
  markCurrentGraphIntegrityRevisionFailed(
    repoId: string,
    versionId: string,
    revision: number,
    error: string,
  ): Promise<boolean>;
  listPendingGraphIntegrityRevisions(): Promise<
    Array<{
      repoId: string;
      versionId: string;
      revision: number;
      verifiedRevision: number | null;
    }>
  >;
  getDerivedState(
    repoId: string,
  ): Promise<Record<string, unknown> | null>;
  graphIntegrityIsAvailableForVersion(
    row: Record<string, unknown> | null,
    versionId: string | null,
  ): boolean;
  graphIntegrityIsVerifiedForVersion(
    row: Record<string, unknown> | null,
    versionId: string | null,
  ): boolean;
}

let initLadybugDb: (dbPath: string) => Promise<void>;
let closeLadybugDb: () => Promise<void>;
let getLadybugConn: () => Promise<import("kuzu").Connection>;
let exec: typeof import("../../dist/db/ladybug-core.js").exec;
let api: RevisionApi;
let ladybugAvailable = false;

try {
  const ladybug = await import("../../dist/db/ladybug.js");
  const core = await import("../../dist/db/ladybug-core.js");
  const derived = await import("../../dist/db/ladybug-derived-state.js");
  initLadybugDb = ladybug.initLadybugDb;
  closeLadybugDb = ladybug.closeLadybugDb;
  getLadybugConn = ladybug.getLadybugConn;
  exec = core.exec;
  api = derived as unknown as RevisionApi;
  ladybugAvailable = true;
} catch {
  // Module not built or LadybugDB unavailable.
}

describe(
  "graph integrity revisions",
  { skip: !ladybugAvailable },
  () => {
    const testRoot = join(
      tmpdir(),
      `sdl-mcp-integrity-revisions-${Date.now()}-${Math.random()
        .toString(16)
        .slice(2)}`,
    );

    beforeEach(async () => {
      assert.equal(typeof api.beginGraphIntegrityVersion, "function");
      mkdirSync(testRoot, { recursive: true });
      await initLadybugDb(join(testRoot, "revisions.lbug"));
    });

    afterEach(async () => {
      await closeLadybugDb();
      if (existsSync(testRoot)) {
        rmSync(testRoot, { recursive: true, force: true });
      }
    });

    it("starts at revision zero and advances with an exact CAS", async () => {
      const conn = await getLadybugConn();
      const digest = "a".repeat(64);
      await api.beginGraphIntegrityVersion(conn, "repo", "v1", digest, true);

      const initial = await api.getDerivedState("repo");
      assert.equal(initial?.graphIntegrityRevision, 0);
      assert.equal(initial?.graphIntegrityVerifiedRevision, 0);
      assert.equal(initial?.graphIntegrityDigest, digest);
      assert.equal(initial?.graphIntegrityFilelessPruningSupported, true);

      assert.equal(
        await api.advanceGraphIntegrityRevisionInTransaction(
          conn,
          "repo",
          "v1",
          0,
        ),
        1,
      );
      assert.equal(
        await api.advanceGraphIntegrityRevisionInTransaction(
          conn,
          "repo",
          "v1",
          0,
        ),
        null,
      );

      const advanced = await api.getDerivedState("repo");
      assert.equal(advanced?.graphIntegrityRevision, 1);
      assert.equal(advanced?.graphIntegrityVerifiedRevision, 0);
      assert.equal(advanced?.graphIntegrityDigest, digest);
    });

    it("orders pending revisions by repo and isolates repositories", async () => {
      const conn = await getLadybugConn();
      const digest = "b".repeat(64);
      await api.beginGraphIntegrityVersion(conn, "repo-b", "v2", digest, true);
      await api.beginGraphIntegrityVersion(conn, "repo-a", "v1", digest, false);
      await api.advanceGraphIntegrityRevisionInTransaction(
        conn,
        "repo-b",
        "v2",
        0,
      );
      await api.advanceGraphIntegrityRevisionInTransaction(
        conn,
        "repo-a",
        "v1",
        0,
      );

      await exec(
        conn,
        `CREATE (d:DerivedState {
          repoId: 'repo-c',
          graphIntegrityVersionId: 'v0',
          graphIntegrityRevision: 0
        })`,
      );

      assert.deepEqual(await api.listPendingGraphIntegrityRevisions(), [
        {
          repoId: "repo-a",
          versionId: "v1",
          revision: 1,
          verifiedRevision: 0,
        },
        {
          repoId: "repo-b",
          versionId: "v2",
          revision: 1,
          verifiedRevision: 0,
        },
        {
          repoId: "repo-c",
          versionId: "v0",
          revision: 0,
          verifiedRevision: null,
        },
      ]);
    });

    it("publishes success only for the verifying version and revision", async () => {
      const conn = await getLadybugConn();
      const oldDigest = "c".repeat(64);
      const nextDigest = "d".repeat(64);
      await api.beginGraphIntegrityVersion(conn, "repo", "v1", oldDigest, true);
      await api.advanceGraphIntegrityRevisionInTransaction(
        conn,
        "repo",
        "v1",
        0,
      );

      assert.equal(
        await api.markGraphIntegrityVerifiedIfVerifying(
          "repo",
          "wrong",
          1,
          nextDigest,
        ),
        false,
      );
      assert.equal(
        await api.markGraphIntegrityVerifiedIfVerifying(
          "repo",
          "v1",
          0,
          nextDigest,
        ),
        false,
      );
      assert.equal(
        await api.markGraphIntegrityVerifiedIfVerifying(
          "repo",
          "v1",
          1,
          nextDigest,
        ),
        true,
      );
      assert.equal(
        await api.markGraphIntegrityVerifiedIfVerifying(
          "repo",
          "v1",
          1,
          nextDigest,
        ),
        false,
      );

      const row = await api.getDerivedState("repo");
      assert.equal(row?.graphIntegrityRevision, 1);
      assert.equal(row?.graphIntegrityVerifiedRevision, 1);
      assert.equal(row?.graphIntegrityDigest, nextDigest);
    });

    it("preserves the last verified revision and digest on worker failure", async () => {
      const conn = await getLadybugConn();
      const digest = "e".repeat(64);
      await api.beginGraphIntegrityVersion(conn, "repo", "v1", digest, true);
      await api.advanceGraphIntegrityRevisionInTransaction(
        conn,
        "repo",
        "v1",
        0,
      );

      assert.equal(
        await api.markGraphIntegrityFailedIfVerifying(
          "repo",
          "v1",
          0,
          "wrong revision",
        ),
        false,
      );
      assert.equal(
        await api.markGraphIntegrityFailedIfVerifying(
          "repo",
          "v1",
          1,
          "failed",
        ),
        true,
      );

      const row = await api.getDerivedState("repo");
      assert.equal(row?.graphIntegrityVerifiedRevision, 0);
      assert.equal(row?.graphIntegrityDigest, digest);
      assert.equal(row?.graphIntegrityState, "failed");
    });

    it("fails only the matching unrevisioned verification attempt", async () => {
      const conn = await getLadybugConn();
      const digest = "0".repeat(64);
      await api.beginGraphIntegrityVersion(conn, "repo", "v1", digest, false);
      await exec(
        conn,
        `MATCH (d:DerivedState {repoId: 'repo'})
         SET d.graphIntegrityState = 'verifying',
             d.graphIntegrityRevision = NULL,
             d.graphIntegrityVerifiedRevision = 7`,
      );

      assert.equal(
        await api.markUnrevisionedGraphIntegrityFailedIfVerifying(
          "repo",
          "wrong-version",
          "stale",
        ),
        false,
      );
      let row = await api.getDerivedState("repo");
      assert.equal(row?.graphIntegrityState, "verifying");
      assert.equal(row?.graphIntegrityVersionId, "v1");
      assert.equal(row?.graphIntegrityRevision, null);
      assert.equal(row?.graphIntegrityVerifiedRevision, 7);
      assert.equal(row?.graphIntegrityDigest, digest);
      assert.equal(row?.graphIntegrityFilelessPruningSupported, false);

      await exec(
        conn,
        `MATCH (d:DerivedState {repoId: 'repo'})
         SET d.graphIntegrityState = 'verified',
             d.graphIntegrityVersionId = 'v2'`,
      );
      assert.equal(
        await api.markUnrevisionedGraphIntegrityFailedIfVerifying(
          "repo",
          "v2",
          "stale state",
        ),
        false,
      );
      row = await api.getDerivedState("repo");
      assert.equal(row?.graphIntegrityState, "verified");
      assert.equal(row?.graphIntegrityVersionId, "v2");
      assert.equal(row?.graphIntegrityRevision, null);
      assert.equal(row?.graphIntegrityVerifiedRevision, 7);
      assert.equal(row?.graphIntegrityDigest, digest);
      assert.equal(row?.graphIntegrityFilelessPruningSupported, false);

      await exec(
        conn,
        `MATCH (d:DerivedState {repoId: 'repo'})
         SET d.graphIntegrityState = 'verifying',
             d.graphIntegrityVersionId = 'v1'`,
      );
      assert.equal(
        await api.markUnrevisionedGraphIntegrityFailedIfVerifying(
          "repo",
          "v1",
          "x".repeat(2048),
        ),
        true,
      );
      row = await api.getDerivedState("repo");
      assert.equal(row?.graphIntegrityState, "failed");
      assert.equal(row?.graphIntegrityVersionId, "v1");
      assert.equal(row?.graphIntegrityRevision, null);
      assert.equal(row?.graphIntegrityVerifiedRevision, 7);
      assert.equal(row?.graphIntegrityDigest, digest);
      assert.equal(row?.graphIntegrityFilelessPruningSupported, false);
      assert.equal(String(row?.graphIntegrityError).length, 1024);
    });

    it("direct failure uses the exact version and current revision", async () => {
      const conn = await getLadybugConn();
      const digest = "f".repeat(64);
      await api.beginGraphIntegrityVersion(conn, "repo", "v1", digest, true);

      assert.equal(
        await api.markCurrentGraphIntegrityRevisionFailed("repo", "wrong", 0, "failed"),
        false,
      );
      assert.equal(
        await api.markCurrentGraphIntegrityRevisionFailed("repo", "v1", 1, "failed"),
        false,
      );
      assert.equal(
        await api.markCurrentGraphIntegrityRevisionFailed("repo", "v1", 0, "failed"),
        true,
      );
      const row = await api.getDerivedState("repo");
      assert.equal(row?.graphIntegrityDigest, digest);
      assert.equal(row?.graphIntegrityVerifiedRevision, 0);
    });

    it("distinguishes null revision state from revision zero", async () => {
      const conn = await getLadybugConn();
      await exec(
        conn,
        "CREATE (d:DerivedState {repoId: $repoId, graphIntegrityState: 'verified', graphIntegrityVersionId: 'v1', graphIntegrityDigest: $digest})",
        { repoId: "unknown", digest: "a".repeat(64) },
      );
      const unknown = await api.getDerivedState("unknown");
      assert.equal(unknown?.graphIntegrityRevision, null);
      assert.equal(unknown?.graphIntegrityVerifiedRevision, null);
      assert.equal(unknown?.graphIntegrityFilelessPruningSupported, null);

      await api.beginGraphIntegrityVersion(
        conn,
        "known",
        "v1",
        "a".repeat(64),
        false,
      );
      const known = await api.getDerivedState("known");
      assert.equal(known?.graphIntegrityRevision, 0);
      assert.equal(known?.graphIntegrityVerifiedRevision, 0);
      assert.equal(known?.graphIntegrityFilelessPruningSupported, false);
    });

    it("rejects unsafe INT64 revisions", async () => {
      const conn = await getLadybugConn();
      await exec(
        conn,
        "CREATE (d:DerivedState {repoId: $repoId, graphIntegrityRevision: $revision})",
        { repoId: "unsafe", revision: 9_007_199_254_740_992n },
      );
      await assert.rejects(
        () => api.getDerivedState("unsafe"),
        /safe integer/i,
      );

      await exec(
        conn,
        `CREATE (d:DerivedState {
          repoId: 'unsafe-verified',
          graphIntegrityVersionId: 'v1',
          graphIntegrityRevision: 0,
          graphIntegrityVerifiedRevision: $verifiedRevision
        })`,
        { verifiedRevision: -9_007_199_254_740_992n },
      );
      await assert.rejects(
        () => api.listPendingGraphIntegrityRevisions(),
        /safe integer/i,
      );
    });

    it("applies availability and verified truth tables", () => {
      const digest = "a".repeat(64);
      const base = {
        graphIntegrityState: "verified",
        graphIntegrityVersionId: "v1",
        graphIntegrityDigest: digest,
        graphIntegrityRevision: 2,
        graphIntegrityVerifiedRevision: 2,
        graphIntegrityFilelessPruningSupported: true,
      };
      assert.equal(api.graphIntegrityIsAvailableForVersion(base, "v1"), true);
      assert.equal(api.graphIntegrityIsVerifiedForVersion(base, "v1"), true);

      for (const row of [
        null,
        { ...base, graphIntegrityVersionId: "v2" },
        { ...base, graphIntegrityState: "unknown" },
        { ...base, graphIntegrityRevision: null },
        { ...base, graphIntegrityFilelessPruningSupported: null },
      ]) {
        assert.equal(api.graphIntegrityIsAvailableForVersion(row, "v1"), false);
      }

      for (const row of [
        { ...base, graphIntegrityState: "verifying" },
        { ...base, graphIntegrityState: "failed" },
        { ...base, graphIntegrityVerifiedRevision: 1 },
        { ...base, graphIntegrityDigest: null },
      ]) {
        assert.equal(api.graphIntegrityIsVerifiedForVersion(row, "v1"), false);
      }
      assert.equal(
        api.graphIntegrityIsAvailableForVersion(
          { ...base, graphIntegrityState: "verifying" },
          "v1",
        ),
        true,
      );
      assert.equal(
        api.graphIntegrityIsAvailableForVersion(
          { ...base, graphIntegrityState: "failed" },
          "v1",
        ),
        true,
      );
    });
  },
);
