import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { extractOpencodeSessionUsage, tokensFromOpencodeSessionCounts } from "../src/agents/opencode.mjs";

test("OpenCode usage attributes only the requested directory and normalizes reasoning once", (t) => {
  const storageDir = mkdtempSync(join(tmpdir(), "sdlbench-opencode-usage-"));
  t.after(() => rmSync(storageDir, { recursive: true, force: true }));
  mkdirSync(join(storageDir, "opencode"));
  const runRoot = join(storageDir, "worktree");
  const db = new DatabaseSync(join(storageDir, "opencode", "opencode.db"));
  db.exec(`CREATE TABLE session (
    id TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER,
    tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER,
    tokens_cache_read INTEGER, tokens_cache_write INTEGER, cost REAL
  )`);
  const insert = db.prepare("INSERT INTO session VALUES (?, ?, 1, ?, 100, 20, 10, 30, 5, 0)");
  insert.run("matching", runRoot, 1);
  insert.run("unrelated-newer", join(storageDir, "other"), 2);
  db.close();

  const counts = extractOpencodeSessionUsage({ storageDir, runRoot });
  assert.equal(counts.sessionId, "matching");
  assert.equal(counts.output, 30);
  assert.equal(counts.reasoningOutput, 10);
  assert.equal(counts.total, counts.input + counts.output);
  const tokens = tokensFromOpencodeSessionCounts(counts, { model: "fixture", encoding: "fixture" });
  assert.equal(tokens.output, 30);
  assert.equal(tokens.total, 130);
  assert.equal(tokens.uncachedInput, 65);
  assert.equal(tokens.tokenizerResolution, "provider_usage");
  assert.equal(tokens.encoding, null);
  assert.equal(tokens.tokenizerVersion, null);
  assert.equal(extractOpencodeSessionUsage({ storageDir, runRoot: join(storageDir, "missing") }).sessionId, null);
  assert.equal(extractOpencodeSessionUsage({ storageDir }).sessionId, null);
});
