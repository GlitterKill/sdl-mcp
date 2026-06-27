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
 * Permissions are auto-approved via the opencode --dangerously-skip-permissions
 * CLI flag in the agent command template; this config deliberately omits
 * permission rules to avoid drift with the flag.
 */
export async function prepareOpencodeSterileRuntime({ root, workDir, taskRunId, sdlSession }) {
  // Sterile opencode home: redirect storage to a per-run temp dir away from the
  // user's ~/.local/share/opencode/storage/ (honors the OPENCODE_DATA_DIR override
  // that opencode reads at startup).
  const storageRoot = join(dirname(workDir), "opencode-home", taskRunId);
  await rm(storageRoot, { force: true, recursive: true });
  const storageDir = join(storageRoot, "storage");
  await mkdir(storageDir, { recursive: true });

  const env = {
    OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeInlineConfig(sdlSession)),
    OPENCODE_DATA_DIR: storageDir,
  };
  // Pass the Neuralwatt key through so the OpenAI-compatible provider works
  // without requiring the user's opencode.json to hold credentials.
  if (process.env.NEURALWATT_API_KEY) env.NEURALWATT_API_KEY = process.env.NEURALWATT_API_KEY;
  return {
    storageRoot,
    storageDir,
    env,
  };
}

function opencodeInlineConfig(sdlSession) {
  // Minimal sterile config carrying only the SDL MCP remote-mount entry (if any).
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
  };
}
