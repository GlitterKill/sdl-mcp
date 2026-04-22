/**
 * Server Harness — starts/stops an in-process SDL-MCP HTTP server with isolated temp DB.
 *
 * Imports from dist/ (compiled code). Must `npm run build:runtime` before use.
 */

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { importStressDistModule } from "./dist-runtime.js";
import type { StressTestConfig } from "./types.js";
import { stressLog } from "./types.js";

interface HttpServerHandle {
  close(): Promise<void>;
  port: number;
  authToken: string;
}

interface SessionManagerInstance {
  getStats(): { activeSessions: number; maxSessions: number };
  setMaxSessions(maxSessions: number): void;
}

type SetupHttpTransport = (
  host: string,
  port: number,
  graphDbPath: string,
  options: {
    sessionManager: SessionManagerInstance | null;
    codeModeConfig?: {
      enabled: boolean;
      exclusive: boolean;
      maxWorkflowSteps: number;
      maxWorkflowTokens: number;
      maxWorkflowDurationMs: number;
      ladderValidation: "off" | "warn" | "enforce";
      etagCaching: boolean;
    };
  },
) => Promise<HttpServerHandle>;

type PoolStats = {
  readPoolSize: number;
  readPoolInitialized: number;
  writeInitialized: boolean;
  writeQueued: number;
  writeActive: number;
};

type ToolDispatchStats = { active: number; queued: number };

type DispatchLimiter = { getStats(): ToolDispatchStats };

type SessionManagerConstructor = new (
  maxSessions: number,
) => SessionManagerInstance;

const transportModule = await importStressDistModule<{
  setupHttpTransport: SetupHttpTransport;
}>(import.meta.url, "cli/transport/http.js");
const ladybugModule = await importStressDistModule<{
  initLadybugDb: (dbPath: string) => Promise<void>;
  closeLadybugDb: () => Promise<void>;
  getPoolStats: () => PoolStats;
}>(import.meta.url, "db/ladybug.js");
const dispatchLimiterModule = await importStressDistModule<{
  configureToolDispatchLimiter: (opts: {
    maxConcurrency?: number;
    queueTimeoutMs?: number;
  }) => void;
  getToolDispatchLimiter: () => DispatchLimiter;
  resetToolDispatchLimiter: () => void;
}>(import.meta.url, "mcp/dispatch-limiter.js");
const sessionManagerModule = await importStressDistModule<{
  SessionManager: SessionManagerConstructor;
}>(import.meta.url, "mcp/session-manager.js");

const { setupHttpTransport } = transportModule;
const { initLadybugDb, closeLadybugDb, getPoolStats } = ladybugModule;
const {
  configureToolDispatchLimiter,
  getToolDispatchLimiter,
  resetToolDispatchLimiter,
} = dispatchLimiterModule;
const { SessionManager } = sessionManagerModule;

export interface ServerHarnessOptions {
  maxSessions?: number;
  maxToolConcurrency?: number;
  queueTimeoutMs?: number;
}

export class ServerHarness {
  private config: StressTestConfig;
  private handle: HttpServerHandle | null = null;
  private tempDir: string | null = null;
  private sessionManager: SessionManagerInstance | null = null;
  private actualPort: number = 0;
  private _authToken: string = "";

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
          // Stress scenarios exercise both flat tools and Code Mode context tools.
          // Keep Code Mode non-exclusive so core tools remain available.
          codeMode: {
            enabled: true,
            exclusive: false,
          },
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

    // The harness bypasses serveCommand(), so it must perform the DB bootstrap
    // that production HTTP startup normally completes before transport setup.
    await initLadybugDb(graphDbPath);

    // Start the HTTP transport in-process
    this.handle = await setupHttpTransport(
      this.config.host,
      this.config.port,
      graphDbPath,
      {
        sessionManager: this.sessionManager,
        codeModeConfig: {
          enabled: true,
          exclusive: false,
          maxWorkflowSteps: 20,
          maxWorkflowTokens: 50_000,
          maxWorkflowDurationMs: 60_000,
          ladderValidation: "warn",
          etagCaching: true,
        },
      },
    );

    // setupHttpTransport now waits for listen and exposes the actual bound port
    // (supports port 0 → OS-assigned).
    this.actualPort = this.handle.port;
    this._authToken = this.handle.authToken;

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
    this._authToken = "";

    stressLog("info", "Server harness stopped");
  }

  getPort(): number {
    return this.actualPort;
  }

  getAuthToken(): string {
    return this._authToken;
  }

  getPoolStats(): PoolStats {
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

  /** Reconfigure max session cap between scenarios without restarting server. */
  reconfigureSessions(maxSessions: number): void {
    if (!this.sessionManager) {
      return;
    }
    this.sessionManager.setMaxSessions(maxSessions);
  }
}
