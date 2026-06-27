import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Sterile OpenCode runtime for SDLBench.
 *
 * Mirrors prepareCodexSterileRuntime: produces a per-run temp opencode storage
 * dir plus an inline OPENCODE_CONFIG_CONTENT env var that wires the SDL-MCP
 * remote server when an SDL session is present. Baseline variant omits the
 * MCP server entry (mcp block is {}).
 *
 * Storage redirection (validated on opencode v1.17.11):
 *   - OPENCODE_DATA_DIR env var was added to opencode in PR #8963 (Jan 2026)
 *     but did not ship until v1.2+; opencode 1.1.6 ignores it. v1.17.11
 *     honors XDG_DATA_HOME instead, redirecting bin/log/snapshot/state AND
 *     the opencode.db SQLite database (which v1.17.11 uses in place of the
 *     v1.1.6 fragmented JSON tree).
 *   - We set XDG_DATA_HOME=<per-run temp>/ so opencode writes its SQLite
 *     database under our isolated dir, away from the user's
 *     ~/.local/share/opencode/. extractOpencodeSessionUsage then queries that
 *     SQLite database for the session matching the runRoot directory.
 *
 * Permissions are auto-approved via the opencode --dangerously-skip-permissions
 * CLI flag in the agent command template (only present in opencode >= 1.2);
 * for older opencode, non-interactive mode auto-approves per the documentation.
 * This config deliberately omits permission rules to avoid drift with the flag.
 */
export async function prepareOpencodeSterileRuntime({ root, workDir, taskRunId, sdlSession }) {
  // Per-run XDG data home: opencode v1.17.11 writes to <XDG_DATA_HOME>/opencode/
  // including the SQLite db, sessions, snapshots, and logs.
  const storageRoot = join(dirname(workDir), "opencode-home", taskRunId);
  await rm(storageRoot, { force: true, recursive: true });
  const storageDir = join(storageRoot, "storage");
  await mkdir(storageDir, { recursive: true });
  // opencode v1.17.11 expects XDG_DATA_HOME to point at the *parent* dir of
  // the `opencode/` folder it creates. So we point at storageRoot, and
  // opencode writes storageRoot/opencode/{opencode.db, storage, snapshot, ...}.
  const env = {
    XDG_DATA_HOME: storageRoot,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeInlineConfig(sdlSession)),
  };
  if (process.env.NEURALWATT_API_KEY) env.NEURALWATT_API_KEY = process.env.NEURALWATT_API_KEY;
  return {
    storageRoot,
    storageDir,
    dbPath: join(storageRoot, "opencode", "opencode.db"),
    env,
  };
}

function opencodeInlineConfig(sdlSession) {
  // Minimal sterile config. Setting plugin: [] overrides any plugins declared
  // in the user's global ~/.config/opencode/opencode.json (e.g. code-mode MCP
  // which fails to start in benchmark conditions). The mcp block carries only
  // the SDL-MCP remote entry when sdlSession?.mcpUrl is set; baseline runs
  // leave mcp as {} so no SDL tooling leaks into the baseline variant.
  const mcp = {};
  if (sdlSession?.mcpUrl) {
    mcp["sdl-mcp"] = {
      type: "remote",
      url: sdlSession.mcpUrl,
      enabled: true,
    };
  }
  return {
    $schema: "https://opencode.ai/config.json",
    mcp,
    plugin: [],
  };
}
