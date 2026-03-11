/**
 * Server Harness — starts/stops an in-process SDL-MCP HTTP server with isolated temp DB.
 *
 * Imports from dist/ (compiled code). Must `npm run build:runtime` before use.
 */

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Dist imports — requires build:runtime first
import {
  setupHttpTransport,
  type HttpServerHandle,
} from "../../../dist/cli/transport/http.js";
import { closeLadybugDb, getPoolStats } from "../../../dist/db/ladybug.js";
import {
  configureToolDispatchLimiter,
  getToolDispatchLimiter,
  resetToolDispatchLimiter,
} from "../../../dist/mcp/dispatch-limiter.js";
import { SessionManager } from "../../../dist/mcp/session-manager.js";

import type { StressTestConfig } from "./types.js";
import { stressLog } from "./types.js";

export interface ServerHarnessOptions {
  maxSessions?: number;
  maxToolConcurrency?: number;
  queueTimeoutMs?: number;
}

export class ServerHarness {
  private config: StressTestConfig;
  private handle: HttpServerHandle | null = null;
  private tempDir: string | null = null;
  private sessionManager: SessionManager | null = null;
  private actualPort: number = 0;

  constructor(config: StressTestConfig) {
    this.config = config;
  }

  async start(opts: ServerHarnessOptions = {}): Promise<number> {
    // Set environment for stress tests
    process.env.SDL_MCP_DISABLE_NATIVE_ADDON = "1";
    process.env.SDL_LOG_LEVEL = this.config.verbose ? "debug" : "warn";

    // Create temp directory for isolated graph DB
    this.tempDir = mkdtempSync(join(tmpdir(), "sdl-mcp-stress-"));
    const graphDbPath = join(this.tempDir, "sdl-mcp-graph");

    // Write minimal config pointing to fixture repo
    const configPath = join(this.tempDir, "sdlmcp.config.json");
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          repos: [
            {
              repoId: "stress-fixtures",
              rootPath: this.config.fixturePath,
              ignore: ["**/node_modules/**", "**/dist/**"],
            },
          ],
          policy: {},
        },
        null,
        2,
      ),
    );
    process.env.SDL_CONFIG = configPath;

    // Configure dispatch limiter before server start
    const maxToolConcurrency = opts.maxToolConcurrency ?? 8;
    const queueTimeoutMs = opts.queueTimeoutMs ?? this.config.toolCallTimeoutMs;
    configureToolDispatchLimiter({
      maxConcurrency: maxToolConcurrency,
      queueTimeoutMs,
    });

    // Create session manager with configurable limit
    const maxSessions = opts.maxSessions ?? 8;
    this.sessionManager = new SessionManager(maxSessions);

    stressLog("info", `Starting server harness`, {
      maxSessions,
      maxToolConcurrency,
      graphDbPath,
      fixturePath: this.config.fixturePath,
    });

    // Start the HTTP transport in-process
    this.handle = await setupHttpTransport(
      this.config.host,
      this.config.port,
      graphDbPath,
      { sessionManager: this.sessionManager },
    );

    // Read back the actual port (supports port 0 → OS-assigned)
    // setupHttpTransport uses httpServer.listen() which is callback-based.
    // We need to wait briefly for the listen callback to fire.
    await new Promise((resolve) => setTimeout(resolve, 200));

    // The port is embedded in the handle's serverClosed promise scope.
    // For port 0, we need to infer it from the config or use a known port.
    // Since we can't easily access httpServer.address() from outside,
    // we use a non-zero port for stress tests.
    this.actualPort = this.config.port || 0;

    // If port 0 was requested, we need a workaround — use health check to find port
    // For simplicity, stress tests should always specify a non-zero port
    if (this.actualPort === 0) {
      // Try ports starting from 19876
      this.actualPort = 19876;
    }

    stressLog("info", `Server harness started on port ${this.actualPort}`);
    return this.actualPort;
  }

  async stop(): Promise<void> {
    stressLog("info", "Stopping server harness");

    if (this.handle) {
      await this.handle.close();
      this.handle = null;
    }

    // Close DB connections
    try {
      await closeLadybugDb();
    } catch {
      // Best-effort cleanup
    }

    // Reset dispatch limiter for next scenario
    resetToolDispatchLimiter();

    // Clean temp directory
    if (this.tempDir) {
      try {
        rmSync(this.tempDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup on Windows (files may be locked)
        stressLog("warn", `Could not clean temp dir: ${this.tempDir}`);
      }
      this.tempDir = null;
    }

    this.sessionManager = null;
    this.actualPort = 0;

    stressLog("info", "Server harness stopped");
  }

  getPort(): number {
    return this.actualPort;
  }

  getPoolStats(): {
    readPoolSize: number;
    readPoolInitialized: number;
    writeQueued: number;
    writeActive: number;
  } {
    return getPoolStats();
  }

  getDispatchStats(): { active: number; queued: number } {
    return getToolDispatchLimiter().getStats();
  }

  getSessionStats(): { activeSessions: number; maxSessions: number } | null {
    if (!this.sessionManager) return null;
    const stats = this.sessionManager.getStats();
    return {
      activeSessions: stats.activeSessions,
      maxSessions: stats.maxSessions,
    };
  }

  getMemoryUsage(): { rss: number; heapUsed: number; heapTotal: number } {
    const mem = process.memoryUsage();
    return { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal };
  }

  /** Reconfigure dispatch limiter between scenarios */
  reconfigureDispatch(opts: {
    maxConcurrency?: number;
    queueTimeoutMs?: number;
  }): void {
    configureToolDispatchLimiter(opts);
  }
}
