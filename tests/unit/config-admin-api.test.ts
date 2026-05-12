import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  configAdminMetadataCoverageForTest,
  readConfigAdminSnapshotForTest,
  routeConfigAdminApiRequest,
  type ConfigAdminApiResponse,
} from "../../dist/config/admin-api.js";

interface TempConfigContext {
  dir: string;
  configPath: string;
  baseConfig: Record<string, unknown>;
}

async function withTempConfig<T>(fn: (ctx: TempConfigContext) => Promise<T>): Promise<T> {
  const previousConfig = process.env.SDL_CONFIG;
  const dir = await mkdtemp(join(tmpdir(), "sdl-config-admin-"));
  const configPath = join(dir, "sdlmcp.config.json");
  const baseConfig = {
    repos: [{ repoId: "demo", rootPath: dir, ignore: [], languages: ["ts"] }],
    graphDatabase: { path: join(dir, "graph.lbug") },
    policy: {},
    performanceTier: "auto",
    httpAuth: { enabled: true, token: "super-secret-token" },
    unknownFutureKey: { keep: true },
  } satisfies Record<string, unknown>;

  await writeFile(configPath, `${JSON.stringify(baseConfig, null, 2)}\n`, "utf8");
  process.env.SDL_CONFIG = configPath;
  try {
    return await fn({ dir, configPath, baseConfig });
  } finally {
    if (previousConfig === undefined) delete process.env.SDL_CONFIG;
    else process.env.SDL_CONFIG = previousConfig;
    await rm(dir, { recursive: true, force: true });
  }
}

function post(pathname: string, body: unknown, isLoopback = true): Promise<ConfigAdminApiResponse | null> {
  return routeConfigAdminApiRequest({ method: "POST", pathname, body, isLoopback, remoteAddress: isLoopback ? "127.0.0.1" : "203.0.113.10" });
}

describe("config admin API", () => {
  it("returns redacted raw and effective config without dropping unknown keys", async () => {
    await withTempConfig(async () => {
      const snapshot = await readConfigAdminSnapshotForTest();
      assert.equal(snapshot.source.path, process.env.SDL_CONFIG);
      assert.deepEqual(snapshot.raw.httpAuth, {
        enabled: true,
        token: { __sdlSecret: true, state: "set" },
      });
      assert.equal(snapshot.raw.unknownFutureKey.keep, true);
      assert.ok(snapshot.effective);
      assert.ok(snapshot.validation.messages.some((message) => message.code === "unknown_key"));
    });
  });

  it("returns an ETag header on API snapshots", async () => {
    await withTempConfig(async () => {
      const response = await routeConfigAdminApiRequest({ method: "GET", pathname: "/api/config", isLoopback: false });
      assert.equal(response?.status, 200);
      assert.equal(response?.headers?.ETag, (response?.payload as { source: { hash: string } }).source.hash);
    });
  });

  it("validates drafts containing redacted secret placeholders", async () => {
    await withTempConfig(async () => {
      const snapshot = await readConfigAdminSnapshotForTest();
      const response = await post("/api/config/validate", { draft: snapshot.raw });
      assert.equal(response?.status, 200);
      assert.equal((response?.payload as { validation: { ok: boolean } }).validation.ok, true);
    });
  });

  it("rejects non-loopback mutation attempts", async () => {
    await withTempConfig(async ({ configPath }) => {
      const snapshot = await readConfigAdminSnapshotForTest();
      const response = await post("/api/config/save", {
        draft: snapshot.raw,
        expectedHash: snapshot.source.hash,
      }, false);

      assert.equal(response?.status, 403);
      const persisted = JSON.parse(await readFile(configPath, "utf8"));
      assert.equal(persisted.httpAuth.token, "super-secret-token");
    });
  });

  it("reports etag conflicts with the latest config snapshot", async () => {
    await withTempConfig(async () => {
      const snapshot = await readConfigAdminSnapshotForTest();
      const response = await post("/api/config/save", {
        draft: snapshot.raw,
        expectedHash: "stale-hash",
      });

      assert.equal(response?.status, 409);
      assert.equal((response?.payload as { error: string }).error, "config_conflict");
      assert.ok((response?.payload as { current: { source: { hash: string } } }).current.source.hash);
    });
  });

  it("requires explicit confirmation for high-risk config paths", async () => {
    await withTempConfig(async ({ dir }) => {
      const snapshot = await readConfigAdminSnapshotForTest();
      const draft = structuredClone(snapshot.raw) as Record<string, unknown>;
      draft.graphDatabase = { path: join(dir, "changed.lbug") };

      const response = await post("/api/config/save", {
        draft,
        expectedHash: snapshot.source.hash,
      });

      assert.equal(response?.status, 409);
      assert.equal((response?.payload as { error: string }).error, "high_risk_confirmation_required");
      assert.ok((response?.payload as { diff: Array<{ path: string; highRisk: boolean }> }).diff.some((entry) => entry.path === "/graphDatabase/path" && entry.highRisk));
    });
  });

  it("saves atomically with backup, secret preservation, and unknown-key preservation", async () => {
    await withTempConfig(async ({ configPath, dir }) => {
      const snapshot = await readConfigAdminSnapshotForTest();
      const draft = structuredClone(snapshot.raw) as Record<string, unknown>;
      draft.graphDatabase = { path: join(dir, "changed.lbug") };
      draft.performanceTier = "high";

      const response = await post("/api/config/save", {
        draft,
        expectedHash: snapshot.source.hash,
        highRiskAccepted: true,
      });

      assert.equal(response?.status, 200);
      const payload = response?.payload as { backup: { path: string }; source: { hash: string }; impact: string[] };
      await stat(payload.backup.path);
      assert.ok(payload.source.hash);
      assert.ok(payload.impact.includes("restartRequired"));

      const persisted = JSON.parse(await readFile(configPath, "utf8"));
      assert.equal(persisted.httpAuth.token, "super-secret-token");
      assert.deepEqual(persisted.unknownFutureKey, { keep: true });
      assert.equal(persisted.performanceTier, "high");
      assert.equal(persisted.graphDatabase.path, join(dir, "changed.lbug"));
    });
  });

  it("rolls back through the same validated save path", async () => {
    await withTempConfig(async ({ configPath, dir }) => {
      const snapshot = await readConfigAdminSnapshotForTest();
      const draft = structuredClone(snapshot.raw) as Record<string, unknown>;
      draft.performanceTier = "mid";

      const save = await post("/api/config/save", {
        draft,
        expectedHash: snapshot.source.hash,
        highRiskAccepted: true,
      });
      assert.equal(save?.status, 200);
      const savePayload = save?.payload as { backup: { id: string } };

      const latest = await readConfigAdminSnapshotForTest();
      const rollback = await post("/api/config/rollback", {
        backupId: savePayload.backup.id,
        expectedHash: latest.source.hash,
        highRiskAccepted: true,
      });

      assert.equal(rollback?.status, 200);
      const persisted = JSON.parse(await readFile(configPath, "utf8"));
      assert.equal(persisted.performanceTier, "auto");
      assert.equal(persisted.graphDatabase.path, join(dir, "graph.lbug"));
    });
  });

  it("creates, previews, applies, and deletes reusable profiles", async () => {
    await withTempConfig(async ({ configPath }) => {
      const id = `test-config-admin-${Date.now()}`;
      const create = await post("/api/config/profiles", {
        id,
        name: "Test Config Admin Profile",
        patch: [{ op: "set", path: "/performanceTier", value: "extreme" }],
        includesSecrets: false,
      });
      assert.equal(create?.status, 201);

      try {
        const preview = await post(`/api/config/profiles/${id}/preview`, {});
        assert.equal(preview?.status, 200);
        assert.ok((preview?.payload as { diff: Array<{ path: string }> }).diff.some((entry) => entry.path === "/performanceTier"));

        const snapshot = await readConfigAdminSnapshotForTest();
        const apply = await post(`/api/config/profiles/${id}/apply`, {
          expectedHash: snapshot.source.hash,
          highRiskAccepted: true,
        });
        assert.equal(apply?.status, 200);
        const persisted = JSON.parse(await readFile(configPath, "utf8"));
        assert.equal(persisted.performanceTier, "extreme");
      } finally {
        await routeConfigAdminApiRequest({ method: "DELETE", pathname: `/api/config/profiles/${id}`, isLoopback: true });
      }
    });
  });

  it("strips secret-bearing operations from profiles before storage and reads", async () => {
    await withTempConfig(async () => {
      const id = `test-secret-profile-${Date.now()}`;
      const create = await post("/api/config/profiles", {
        id,
        name: "Secret Profile",
        includesSecrets: true,
        patch: [
          { op: "set", path: "/httpAuth/token", value: "leak" },
          { op: "set", path: "/httpAuth", value: { enabled: false, token: "leak" } },
          { op: "set", path: "/performanceTier", value: "high" },
        ],
      });
      assert.equal(create?.status, 201);

      try {
        const read = await routeConfigAdminApiRequest({ method: "GET", pathname: `/api/config/profiles/${id}`, isLoopback: true });
        assert.equal(read?.status, 200);
        const profile = (read?.payload as { profile: { includesSecrets: boolean; patch: Array<{ path: string }> } }).profile;
        assert.equal(profile.includesSecrets, false);
        assert.deepEqual(profile.patch.map((op) => op.path), ["/performanceTier"]);
      } finally {
        await routeConfigAdminApiRequest({ method: "DELETE", pathname: `/api/config/profiles/${id}`, isLoopback: true });
      }
    });
  });

  it("serializes concurrent saves so stale expected hashes conflict", async () => {
    await withTempConfig(async () => {
      const snapshot = await readConfigAdminSnapshotForTest();
      const firstDraft = structuredClone(snapshot.raw) as Record<string, unknown>;
      const secondDraft = structuredClone(snapshot.raw) as Record<string, unknown>;
      firstDraft.performanceTier = "mid";
      secondDraft.performanceTier = "high";

      const results = await Promise.all([
        post("/api/config/save", { draft: firstDraft, expectedHash: snapshot.source.hash, highRiskAccepted: true }),
        post("/api/config/save", { draft: secondDraft, expectedHash: snapshot.source.hash, highRiskAccepted: true }),
      ]);

      const statuses = results.map((result) => result?.status).sort();
      assert.deepEqual(statuses, [200, 409]);
    });
  });

  it("requires high-risk confirmation for rollback and profile apply", async () => {
    await withTempConfig(async ({ dir }) => {
      const snapshot = await readConfigAdminSnapshotForTest();
      const highRiskDraft = structuredClone(snapshot.raw) as Record<string, unknown>;
      highRiskDraft.graphDatabase = { path: join(dir, "changed-for-rollback.lbug") };
      const save = await post("/api/config/save", {
        draft: highRiskDraft,
        expectedHash: snapshot.source.hash,
        highRiskAccepted: true,
      });
      assert.equal(save?.status, 200);
      const backupId = (save?.payload as { backup: { id: string } }).backup.id;
      const afterSave = await readConfigAdminSnapshotForTest();

      const rollback = await post("/api/config/rollback", {
        backupId,
        expectedHash: afterSave.source.hash,
        highRiskAccepted: false,
      });
      assert.equal(rollback?.status, 409);
      assert.equal((rollback?.payload as { error: string }).error, "high_risk_confirmation_required");

      const id = `test-high-risk-profile-${Date.now()}`;
      const create = await post("/api/config/profiles", {
        id,
        name: "High Risk Profile",
        patch: [{ op: "set", path: "/graphDatabase/path", value: join(dir, "profile-high-risk.lbug") }],
        includesSecrets: false,
      });
      assert.equal(create?.status, 201);

      try {
        const current = await readConfigAdminSnapshotForTest();
        const apply = await post(`/api/config/profiles/${id}/apply`, {
          expectedHash: current.source.hash,
          highRiskAccepted: false,
        });
        assert.equal(apply?.status, 409);
        assert.equal((apply?.payload as { error: string }).error, "high_risk_confirmation_required");
      } finally {
        await routeConfigAdminApiRequest({ method: "DELETE", pathname: `/api/config/profiles/${id}`, isLoopback: true });
      }
    });
  });

  it("covers every planned top-level config area in UI metadata", () => {
    const coverage = configAdminMetadataCoverageForTest();
    for (const section of [
      "repos", "graphDatabase", "policy", "redaction", "indexing", "liveIndex", "slice", "diagnostics", "cache", "plugins", "semantic", "semanticEnrichment", "scip", "runtime", "mcpSurface", "memory", "observability", "wire", "prefetch", "tracing", "parallelScorer", "concurrency", "performance", "advanced",
    ]) {
      assert.ok(coverage.sections.includes(section), `missing section ${section}`);
    }
    assert.ok(coverage.secretPaths.includes("/httpAuth/token"));
    assert.ok(coverage.highRiskPaths.includes("/graphDatabase/path"));
  });
});
