/**
 * feedback-search-text.test.ts
 *
 * Tests for buildFeedbackSearchText and verifies that upsertAgentFeedback
 * persists computed searchText on AgentFeedback nodes.
 *
 * The pure-function tests import from dist/ and require a build step.
 * The integration test requires a live LadybugDB instance.
 *
 * Run via `npm test` (which handles environment setup) or individually
 * after building: `node --test dist/...` (not tsx, to avoid OTel issues).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { buildFeedbackSearchText } from "../../dist/db/ladybug-feedback.js";

describe("buildFeedbackSearchText", () => {
  it("combines taskType, taskText, tags, and symbol names", () => {
    const result = buildFeedbackSearchText({
      taskType: "debug",
      taskText: "authentication fails on login",
      taskTagsJson: '["auth", "security"]',
      usefulSymbolsJson: '["handleLogin", "validateToken"]',
      missingSymbolsJson: '["refreshSession"]',
    });
    assert.ok(result.includes("debug"));
    assert.ok(result.includes("authentication fails on login"));
    assert.ok(result.includes("auth"));
    assert.ok(result.includes("security"));
    assert.ok(result.includes("handleLogin"));
    assert.ok(result.includes("validateToken"));
    assert.ok(result.includes("refreshSession"));
  });

  it("handles missing optional fields", () => {
    const result = buildFeedbackSearchText({
      taskText: "fix the bug",
    });
    assert.equal(result, "fix the bug");
  });

  it("handles all fields null/undefined", () => {
    const result = buildFeedbackSearchText({});
    assert.equal(result, "");
  });

  it("handles malformed JSON gracefully", () => {
    const result = buildFeedbackSearchText({
      taskTagsJson: "not-valid-json",
      taskText: "some task",
    });
    assert.ok(result.includes("some task"));
    // Malformed JSON should not crash, just be skipped
    assert.ok(!result.includes("not-valid-json"));
  });
});

describe("upsertAgentFeedback stores searchText", () => {
  let cleanup: (() => Promise<void>) | null = null;
  const TEST_DB_PATH = join(tmpdir(), `.lbug-feedback-searchtext-test-${process.pid}.lbug`);

  before(async () => {
    const { closeLadybugDb, initLadybugDb } = await import("../../dist/db/ladybug.js");
    await closeLadybugDb();
    if (existsSync(TEST_DB_PATH)) {
      rmSync(TEST_DB_PATH, { recursive: true, force: true });
    }
    mkdirSync(dirname(TEST_DB_PATH), { recursive: true });
    await initLadybugDb(TEST_DB_PATH);
    cleanup = async () => {
      await closeLadybugDb();
      if (existsSync(TEST_DB_PATH)) {
        rmSync(TEST_DB_PATH, { recursive: true, force: true });
      }
    };

    // Insert required repo + version
    const { getLadybugConn } = await import("../../dist/db/ladybug.js");
    const { exec } = await import("../../dist/db/ladybug-core.js");
    const conn = await getLadybugConn();
    await exec(conn, `MERGE (r:Repo {repoId: 'test-repo'}) SET r.rootPath = '/tmp', r.createdAt = '2026-01-01'`);
    await exec(conn, `MERGE (v:Version {versionId: 'v1'}) SET v.createdAt = '2026-01-01'`);
    await exec(conn, `MATCH (r:Repo {repoId: 'test-repo'}), (v:Version {versionId: 'v1'}) MERGE (r)-[:VERSION_OF_REPO]->(v)`);
  });

  after(async () => {
    await cleanup?.();
  });

  it("persists searchText derived from feedback fields", async () => {
    const { upsertAgentFeedback } = await import("../../dist/db/ladybug-feedback.js");
    const { getLadybugConn } = await import("../../dist/db/ladybug.js");
    const { queryAll } = await import("../../dist/db/ladybug-core.js");
    const conn = await getLadybugConn();
    await upsertAgentFeedback(conn, {
      feedbackId: "fb_test_st_1",
      repoId: "test-repo",
      versionId: "v1",
      sliceHandle: "sh1",
      usefulSymbolsJson: '["handleLogin"]',
      missingSymbolsJson: '["validateToken"]',
      taskTagsJson: '["auth"]',
      taskType: "debug",
      taskText: "login fails",
      createdAt: "2026-03-24T00:00:00Z",
    });
    const rows = await queryAll(
      conn,
      `MATCH (f:AgentFeedback {feedbackId: 'fb_test_st_1'}) RETURN f.searchText AS searchText`,
    );
    assert.ok(rows[0].searchText.includes("debug"));
    assert.ok(rows[0].searchText.includes("login fails"));
    assert.ok(rows[0].searchText.includes("handleLogin"));
  });
});
