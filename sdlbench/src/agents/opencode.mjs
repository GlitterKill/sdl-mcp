import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Extract OpenCode session usage from the per-run isolated SQLite database.
 *
 * opencode v1.17.11+ stores sessions, messages, and parts in opencode.db
 * (validated via direct schema inspection). The session table exposes
 * per-session aggregated token counts as direct columns:
 *
 *   - tokens_input           -> input
 *   - tokens_output          -> output excluding reasoning (SQLite adapter contract)
 *   - tokens_reasoning       -> reasoningOutput
 *   - tokens_cache_read      -> cachedInput
 *   - tokens_cache_write     -> cachedWriteInput
 *
 * The session.directory column contains the absolute path of the worktree
 * opencode was invoked in (set by SDLBench to runRoot), so we match it
 * against the expected runRoot to find the per-task session.
 *
 * Calls should pass storageDir = agentRuntime.storageRoot from
 * prepareOpencodeSterileRuntime (which sets XDG_DATA_HOME to redirect the
 * SQLite db to a per-run temp dir).
 */
export function extractOpencodeSessionUsage({ storageDir, runRoot }) {
  const dbPath = join(storageDir, "opencode", "opencode.db");
  if (!existsSync(dbPath)) {
    return emptyUsage();
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return querySessions(db, runRoot, dbPath);
  } finally {
    db.close();
  }
}

function querySessions(db, runRoot, dbPath) {
  // Per-run storage is not proof of attribution: require the exact worktree.
  if (!runRoot) return emptyUsage();
  const normalizedRunRoot = normalizeSessionPath(runRoot);
  const sessions = db.prepare(`
    SELECT id, directory, time_created, time_updated,
           tokens_input, tokens_output, tokens_reasoning,
           tokens_cache_read, tokens_cache_write, cost
    FROM session
    ORDER BY time_updated DESC, id
  `).all();
  const session = sessions.find((row) => normalizeSessionPath(row.directory) === normalizedRunRoot);
  if (!session) return emptyUsage();

  const input = whole(session.tokens_input);
  const reasoningOutput = whole(session.tokens_reasoning);
  // Normalize the separate SQLite text/reasoning counters to inclusive output.
  const output = whole(session.tokens_output) + reasoningOutput;
  const cachedInput = whole(session.tokens_cache_read);
  const cachedWriteInput = whole(session.tokens_cache_write);
  const total = input + output;
  return {
    input,
    output,
    total,
    reasoningOutput,
    cachedInput,
    cachedWriteInput,
    uncachedInput: Math.max(0, input - cachedInput - cachedWriteInput),
    tokenizerSource: "opencode-session",
    usageSource: "opencode_session_usage",
    sessionId: session.id,
    sessionDirectory: session.directory,
    sessionFiles: [dbPath],
  };
}

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    total: 0,
    reasoningOutput: 0,
    cachedInput: 0,
    cachedWriteInput: 0,
    uncachedInput: 0,
    tokenizerSource: "opencode-session",
    usageSource: "opencode_session_usage",
    sessionId: null,
    sessionDirectory: null,
    sessionFiles: [],
  };
}

function whole(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

function normalizeSessionPath(value) {
  return resolve(String(value).replace(/^\\\\\?\\/, "")).replace(/\\/g, "/").toLowerCase();
}

/**
 * Reshape extracted OpenCode session usage into the v3 tokens schema used by
 * estimateCost and the SessionRecord tokens field. Input is the provider total;
 * cachedInput and cachedWriteInput remain subsets of that input. Output includes
 * reasoningOutput. These counters do not identify the provider tokenizer.
 *
 * Mirrors tokensFromCodexSessionCounts in sdlbench.mjs (kept here so all
 * OpenCode-specific token logic lives in one agent module, isolating new
 * work per the project's bundling policy).
 */
export function tokensFromOpencodeSessionCounts(sessionCounts, estimatedTokens) {
  const input = sessionCounts.input ?? 0;
  const output = sessionCounts.output ?? 0;
  const total = input + output;
  const cachedInput = sessionCounts.cachedInput ?? 0;
  const reasoningOutput = sessionCounts.reasoningOutput ?? 0;
  const cachedWriteInput = sessionCounts.cachedWriteInput ?? 0;
  return {
    input,
    output,
    total,
    cachedInput,
    uncachedInput: Math.max(0, input - cachedInput - cachedWriteInput),
    cachedWriteInput,
    reasoningOutput,
    productContext: 0,
    rawEquivalent: total,
    saved: 0,
    savingsPercent: 0,
    model: estimatedTokens.model,
    encoding: null,
    modelHint: estimatedTokens.modelHint,
    tokenizerResolution: "provider_usage",
    tokenizerVersion: null,
    tokenizerSource: "opencode-session",
    usageSource: "opencode_session_usage",
    sessionFiles: sessionCounts.sessionFiles ?? [],
  };
}
