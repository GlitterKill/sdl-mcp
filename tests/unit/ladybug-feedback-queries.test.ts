import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

import { createSchema } from "../../src/db/ladybug-schema.js";
import {
  insertAuditEvent,
  getAuditEvents,
  upsertAgentFeedback,
  getAgentFeedback,
  getAgentFeedbackByRepo,
  getAgentFeedbackByVersion,
  getAggregatedFeedback,
  type AuditRow,
  type AgentFeedbackRow,
} from "../../src/db/ladybug-feedback.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEST_DB_PATH = join(
  __dirname,
  "..",
  "..",
  ".lbug-feedback-queries-test-db.lbug",
);

interface LadybugConnection {
  close: () => Promise<void>;
}

interface LadybugDatabase {
  close: () => Promise<void>;
}

async function createTestDb(): Promise<{
  db: LadybugDatabase;
  conn: LadybugConnection;
}> {
  if (existsSync(TEST_DB_PATH)) {
    rmSync(TEST_DB_PATH, { recursive: true, force: true });
  }
  mkdirSync(dirname(TEST_DB_PATH), { recursive: true });

  const kuzu = await import("kuzu");
  const db = new kuzu.Database(TEST_DB_PATH);
  const conn = new kuzu.Connection(db);

  return { db, conn: conn as unknown as LadybugConnection };
}

async function cleanupTestDb(
  db: LadybugDatabase,
  conn: LadybugConnection,
): Promise<void> {
  try {
    await conn.close();
  } catch {}
  try {
    await db.close();
  } catch {}
  try {
    if (existsSync(TEST_DB_PATH)) {
      rmSync(TEST_DB_PATH, { recursive: true, force: true });
    }
  } catch {}
}

describe("ladybug-feedback queries", () => {
  let db: LadybugDatabase;
  let conn: import("kuzu").Connection;

  const repoId = "repo-feedback";

  beforeEach(async () => {
    process.env.SDL_MCP_DISABLE_NATIVE_ADDON = "1";
    process.env.SDL_GRAPH_DB_PATH = TEST_DB_PATH;

    const created = await createTestDb();
    db = created.db;
    conn = created.conn as unknown as import("kuzu").Connection;

    await createSchema(conn);
  });

  afterEach(async () => {
    await cleanupTestDb(db, conn as unknown as LadybugConnection);
  });

  // --- Audit Events ---

  it("insertAuditEvent and getAuditEvents round-trips", async () => {
    const row: AuditRow = {
      eventId: "audit-1",
      timestamp: "2026-03-18T12:00:00.000Z",
      tool: "sdl.symbol.search",
      decision: "success",
      repoId,
      symbolId: null,
      detailsJson: JSON.stringify({ query: "foo" }),
    };

    await insertAuditEvent(conn, row);

    const events = await getAuditEvents(conn, { repoId });
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0]?.eventId, "audit-1");
    assert.strictEqual(events[0]?.tool, "sdl.symbol.search");
    assert.strictEqual(events[0]?.decision, "success");
  });

  it("getAuditEvents returns empty for unknown repoId", async () => {
    const events = await getAuditEvents(conn, { repoId: "nonexistent" });
    assert.strictEqual(events.length, 0);
  });

  it("getAuditEvents respects limit", async () => {
    for (let i = 0; i < 5; i++) {
      await insertAuditEvent(conn, {
        eventId: `audit-limit-${i}`,
        timestamp: `2026-03-18T12:0${i}:00.000Z`,
        tool: "sdl.symbol.search",
        decision: "success",
        repoId,
        symbolId: null,
        detailsJson: "{}",
      });
    }

    const events = await getAuditEvents(conn, { repoId, limit: 2 });
    assert.strictEqual(events.length, 2);
  });

  it("getAuditEvents filters by sinceTimestamp", async () => {
    await insertAuditEvent(conn, {
      eventId: "audit-old",
      timestamp: "2026-03-17T10:00:00.000Z",
      tool: "test",
      decision: "success",
      repoId,
      symbolId: null,
      detailsJson: "{}",
    });
    await insertAuditEvent(conn, {
      eventId: "audit-new",
      timestamp: "2026-03-19T10:00:00.000Z",
      tool: "test",
      decision: "success",
      repoId,
      symbolId: null,
      detailsJson: "{}",
    });

    const events = await getAuditEvents(conn, {
      repoId,
      sinceTimestamp: "2026-03-18T00:00:00.000Z",
    });
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0]?.eventId, "audit-new");
  });

  // --- Agent Feedback ---

  function makeFeedbackRow(
    feedbackId: string,
    overrides: Partial<AgentFeedbackRow> = {},
  ): AgentFeedbackRow {
    return {
      feedbackId,
      repoId,
      versionId: "v1",
      sliceHandle: "slice-1",
      usefulSymbolsJson: JSON.stringify(["sym-a"]),
      missingSymbolsJson: JSON.stringify([]),
      taskTagsJson: null,
      taskType: null,
      taskText: null,
      createdAt: "2026-03-18T12:00:00.000Z",
      ...overrides,
    };
  }

  it("upsertAgentFeedback and getAgentFeedback round-trips", async () => {
    await upsertAgentFeedback(conn, makeFeedbackRow("fb-1"));

    const found = await getAgentFeedback(conn, "fb-1");
    assert.ok(found);
    assert.strictEqual(found.feedbackId, "fb-1");
    assert.strictEqual(found.sliceHandle, "slice-1");
  });

  it("getAgentFeedback returns null for unknown id", async () => {
    const found = await getAgentFeedback(conn, "missing-fb");
    assert.strictEqual(found, null);
  });

  it("upsertAgentFeedback updates existing row", async () => {
    await upsertAgentFeedback(conn, makeFeedbackRow("fb-update"));
    await upsertAgentFeedback(
      conn,
      makeFeedbackRow("fb-update", { taskType: "debug", taskText: "fix bug" }),
    );

    const found = await getAgentFeedback(conn, "fb-update");
    assert.ok(found);
    assert.strictEqual(found.taskType, "debug");
    assert.strictEqual(found.taskText, "fix bug");
  });

  it("getAgentFeedbackByRepo returns feedback for given repo", async () => {
    await upsertAgentFeedback(conn, makeFeedbackRow("fb-repo-1"));
    await upsertAgentFeedback(
      conn,
      makeFeedbackRow("fb-repo-2", { repoId: "other-repo" }),
    );

    const results = await getAgentFeedbackByRepo(conn, repoId, 10);
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0]?.feedbackId, "fb-repo-1");
  });

  it("getAgentFeedbackByRepo respects limit", async () => {
    for (let i = 0; i < 5; i++) {
      await upsertAgentFeedback(
        conn,
        makeFeedbackRow(`fb-limit-${i}`, {
          createdAt: `2026-03-18T12:0${i}:00.000Z`,
        }),
      );
    }

    const results = await getAgentFeedbackByRepo(conn, repoId, 2);
    assert.strictEqual(results.length, 2);
  });

  it("getAgentFeedbackByVersion filters by version", async () => {
    await upsertAgentFeedback(
      conn,
      makeFeedbackRow("fb-v1", { versionId: "v1" }),
    );
    await upsertAgentFeedback(
      conn,
      makeFeedbackRow("fb-v2", { versionId: "v2" }),
    );

    const results = await getAgentFeedbackByVersion(conn, repoId, "v1", 10);
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0]?.feedbackId, "fb-v1");
  });

  it("getAggregatedFeedback aggregates symbol counts and task types", async () => {
    await upsertAgentFeedback(
      conn,
      makeFeedbackRow("fb-agg-1", {
        usefulSymbolsJson: JSON.stringify(["sym-a", "sym-b"]),
        missingSymbolsJson: JSON.stringify(["sym-c"]),
        taskType: "debug",
        taskTagsJson: JSON.stringify(["performance"]),
      }),
    );
    await upsertAgentFeedback(
      conn,
      makeFeedbackRow("fb-agg-2", {
        usefulSymbolsJson: JSON.stringify(["sym-a"]),
        missingSymbolsJson: JSON.stringify([]),
        taskType: "implement",
        taskTagsJson: null,
      }),
    );

    const agg = await getAggregatedFeedback(conn, repoId);
    assert.strictEqual(agg.totalFeedback, 2);
    assert.strictEqual(agg.symbolPositiveCounts.get("sym-a"), 2);
    assert.strictEqual(agg.symbolPositiveCounts.get("sym-b"), 1);
    assert.strictEqual(agg.symbolNegativeCounts.get("sym-c"), 1);
    assert.strictEqual(agg.taskTypeCounts.get("debug"), 1);
    assert.strictEqual(agg.taskTypeCounts.get("implement"), 1);
    assert.strictEqual(agg.taskTypeCounts.get("performance"), 1);
  });

  it("getAggregatedFeedback returns empty maps for no feedback", async () => {
    const agg = await getAggregatedFeedback(conn, "empty-repo");
    assert.strictEqual(agg.totalFeedback, 0);
    assert.strictEqual(agg.symbolPositiveCounts.size, 0);
    assert.strictEqual(agg.symbolNegativeCounts.size, 0);
    assert.strictEqual(agg.taskTypeCounts.size, 0);
  });
});
