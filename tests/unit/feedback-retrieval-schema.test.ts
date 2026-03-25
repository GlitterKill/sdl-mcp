/**
 * feedback-retrieval-schema.test.ts
 *
 * Tests that the AgentFeedback node table includes the new searchText
 * and embedding columns added in Stage 4.
 *
 * Requires a live LadybugDB instance. Run via `npm test` (which handles
 * environment setup) or after building: `node --test dist/...`.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  closeLadybugDb,
  getLadybugConn,
  initLadybugDb,
} from "../../dist/db/ladybug.js";
import { exec, queryAll } from "../../dist/db/ladybug-core.js";

const TEST_DB_PATH = join(tmpdir(), `.lbug-feedback-schema-test-${process.pid}.lbug`);

describe("AgentFeedback retrieval schema", () => {
  before(async () => {
    await closeLadybugDb();
    if (existsSync(TEST_DB_PATH)) {
      rmSync(TEST_DB_PATH, { recursive: true, force: true });
    }
    mkdirSync(dirname(TEST_DB_PATH), { recursive: true });
    await initLadybugDb(TEST_DB_PATH);
  });

  after(async () => {
    await closeLadybugDb();
    if (existsSync(TEST_DB_PATH)) {
      rmSync(TEST_DB_PATH, { recursive: true, force: true });
    }
  });

  it("AgentFeedback node has searchText column", async () => {
    const conn = await getLadybugConn();
    await exec(
      conn,
      `MERGE (f:AgentFeedback {feedbackId: 'test-schema-1'})
        SET f.searchText = 'debug auth login failure'`,
    );
    const rows = await queryAll(
      conn,
      `MATCH (f:AgentFeedback {feedbackId: 'test-schema-1'}) RETURN f.searchText AS searchText`,
    );
    assert.equal(rows[0].searchText, "debug auth login failure");
  });

  it("AgentFeedback node has embeddingMiniLM column", async () => {
    const conn = await getLadybugConn();
    await exec(
      conn,
      `MERGE (f:AgentFeedback {feedbackId: 'test-schema-2'})
        SET f.embeddingMiniLMCardHash = 'abc123',
            f.embeddingMiniLMUpdatedAt = '2026-03-24T00:00:00Z'`,
    );
    const rows = await queryAll(
      conn,
      `MATCH (f:AgentFeedback {feedbackId: 'test-schema-2'})
       RETURN f.embeddingMiniLMCardHash AS hash`,
    );
    assert.equal(rows[0].hash, "abc123");
  });

  it("AgentFeedback node has embeddingNomic column", async () => {
    const conn = await getLadybugConn();
    await exec(
      conn,
      `MERGE (f:AgentFeedback {feedbackId: 'test-schema-3'})
        SET f.embeddingNomicCardHash = 'def456',
            f.embeddingNomicUpdatedAt = '2026-03-24T00:00:00Z'`,
    );
    const rows = await queryAll(
      conn,
      `MATCH (f:AgentFeedback {feedbackId: 'test-schema-3'})
       RETURN f.embeddingNomicCardHash AS hash`,
    );
    assert.equal(rows[0].hash, "def456");
  });
});
