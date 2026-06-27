import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Extract OpenCode session usage from the fragmented per-run storage tree.
 *
 * OpenCode writes session/message/part records to separate JSON files under
 * <OPENCODE_DATA_DIR>/storage/ — caller is expected to pass that root here.
 * The per-run sterile runtime (sdlbench/src/agents/opencode-runtime.mjs)
 * already isolates OPENCODE_DATA_DIR per-taskRunId, so any usage record
 * found in storageDir belongs to the current benchmark run.
 *
 * Sums provider usage fields exposed by opencode's getUsage activation:
 *   - inputTokens
 *   - outputTokens
 *   - reasoningTokens (charged at output rate per Kimi K2.7 Code thinking mode
 *     and GLM-5.2 reasoning; returned here as reasoningOutput for parity with
 *     the Codex usage path)
 *   - cacheReadInputTokens (cached prompt-token reads)
 *   - cacheWriteInputTokens (prompt-cache write; billed like input)
 *
 * Files without a top-level `usage` object are skipped (coverage for metadata
 * files like info.json and index.json).
 */
export async function extractOpencodeSessionUsage({ storageDir }) {
  let input = 0;
  let output = 0;
  let total = 0;
  let reasoningOutput = 0;
  let cachedInput = 0;
  let cachedWriteInput = 0;
  const sessionFiles = [];

  if (storageDir) {
    const files = await findJsonFiles(storageDir);
    for (const file of files) {
      const text = await readFile(file, "utf8").catch(() => null);
      if (!text) continue;
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        continue;
      }
      const usage = parsed?.usage;
      if (!usage || typeof usage !== "object") continue;
      const fileInput = whole(usage.inputTokens);
      const fileOutput = whole(usage.outputTokens);
      const fileReasoning = whole(usage.reasoningTokens);
      const fileCacheRead = whole(usage.cacheReadInputTokens);
      const fileCacheWrite = whole(usage.cacheWriteInputTokens);
      const fileTotal = whole(usage.totalTokens) || fileInput + fileOutput + fileReasoning;
      // Skip records that have no usage signal at all (e.g. cached write-only
      // entries that some providers emit as zero-stat frames).
      if (!fileInput && !fileOutput && !fileReasoning && !fileCacheRead && !fileCacheWrite) continue;
      input += fileInput;
      output += fileOutput;
      reasoningOutput += fileReasoning;
      cachedInput += fileCacheRead;
      cachedWriteInput += fileCacheWrite;
      total += fileTotal;
      sessionFiles.push(file);
    }
  }

  return {
    input,
    output,
    total: total || input + output + reasoningOutput,
    reasoningOutput,
    cachedInput,
    cachedWriteInput,
    uncachedInput: Math.max(0, input - cachedInput - cachedWriteInput),
    tokenizerSource: "opencode-session",
    sessionFiles,
  };
}

/**
 * Reshape extracted OpenCode session usage into the v2 tokens schema used by
 * estimateCost and the SessionRecord tokens field.
 *
 * Mirrors tokensFromCodexSessionCounts in sdlbench.mjs (kept here so all
 * OpenCode-specific token logic lives in one agent module, isolating new
 * work per the project's bundling policy).
 */
export function tokensFromOpencodeSessionCounts(sessionCounts, estimatedTokens) {
  const input = sessionCounts.input ?? 0;
  const output = sessionCounts.output ?? 0;
  const total = sessionCounts.total || input + output;
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
    encoding: estimatedTokens.encoding,
    modelHint: estimatedTokens.modelHint,
    tokenizerResolution: "tiktoken_session_count",
    tokenizerVersion: "opencode",
    tokenizerSource: "opencode-session",
    usageSource: "opencode_session_usage",
    sessionFiles: sessionCounts.sessionFiles ?? [],
  };
}

function whole(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

async function findJsonFiles(root) {
  let files = [];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) {
        files = files.concat(await findJsonFiles(path));
      } else if (entry.isFile() && (entry.name.endsWith(".json"))) {
        files.push(path);
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return files;
}
