/**
 * Centralized graceful-shutdown manager for SDL-MCP.
 *
 * Handles:
 * - SIGINT / SIGTERM / SIGHUP signal handlers
 * - stdin end/close detection (for stdio transport — detects terminal close)
 * - Forced exit timeout to prevent hanging on stuck cleanup
 * - Idempotent shutdown (prevents double-cleanup races)
 * - PID file removal
 *
 * Usage:
 *   const mgr = new ShutdownManager({ forceTimeoutMs: 5000 });
 *   mgr.addCleanup("server", () => server.stop());
 *   mgr.addCleanup("db", () => closeLadybugDb());
 *   mgr.registerSignals();         // SIGINT, SIGTERM, SIGHUP
 *   mgr.monitorStdin();            // stdin pipe close (stdio transport)
 *   mgr.setPidfilePath(path);      // auto-remove on shutdown
 */

import { SHUTDOWN_FORCE_EXIT_TIMEOUT_MS } from "../config/constants.js";
import { removePidfile } from "./pidfile.js";

export type CleanupFn = () => void | Promise<void>;

export interface ShutdownManagerOptions {
  /**
   * Milliseconds to wait for cleanup before force-exiting.
   * Defaults to `SHUTDOWN_FORCE_EXIT_TIMEOUT_MS` (5 000).
   */
  forceTimeoutMs?: number;

  /**
   * Logger function. Defaults to stderr.
   */
  log?: (msg: string) => void;
}

export class ShutdownManager {
  private shutdownCalled = false;
  private cleanups: Array<{ name: string; fn: CleanupFn }> = [];
  private pidfilePath: string | null = null;
  private forceTimeoutMs: number;
  private log: (msg: string) => void;
  private shutdownResolve: (() => void) | null = null;
  /** Promise that resolves when shutdown is initiated (before cleanup runs) */
  readonly shutdownInitiated: Promise<void>;

  constructor(options: ShutdownManagerOptions = {}) {
    this.forceTimeoutMs =
      options.forceTimeoutMs ?? SHUTDOWN_FORCE_EXIT_TIMEOUT_MS;
    this.log =
      options.log ??
      ((msg: string) => process.stderr.write(`[sdl-mcp] ${msg}\n`));
    this.shutdownInitiated = new Promise((resolve) => {
      this.shutdownResolve = resolve;
    });
  }

  /**
   * Register a named cleanup callback. Cleanups run sequentially in
   * registration order during shutdown.
   */
  addCleanup(name: string, fn: CleanupFn): void {
    this.cleanups.push({ name, fn });
  }

  /**
   * Set the PID file path so it is automatically removed during shutdown.
   */
  setPidfilePath(path: string): void {
    this.pidfilePath = path;
  }

  /**
   * Register SIGINT, SIGTERM, and SIGHUP handlers.
   *
   * SIGHUP is sent on many platforms when the controlling terminal is
   * closed (e.g. closing a terminal window). On Windows Node.js
   * approximates SIGHUP when the console window is closed.
   */
  registerSignals(): void {
    const handle = (signal: string): void => {
      void this.shutdown(signal);
    };

    process.once("SIGINT", () => handle("SIGINT"));
    process.once("SIGTERM", () => handle("SIGTERM"));

    // SIGHUP fires when the controlling terminal closes. On Windows,
    // Node.js emits this when the console window is closed.
    process.once("SIGHUP", () => handle("SIGHUP"));
  }

  /**
   * Monitor stdin for end/close events. When the MCP client disconnects
   * (or the spawning terminal closes), stdin will emit these events.
   * This is critical for stdio transport because without an active I/O
   * handle Node.js may silently exit, leaving LadybugDB in a dirty state.
   */
  monitorStdin(): void {
    process.stdin.once("end", () => void this.shutdown("stdin-end"));
    process.stdin.once("close", () => void this.shutdown("stdin-close"));
  }

  /**
   * Execute the graceful shutdown sequence.
   *
   * 1. Logs the triggering signal.
   * 2. Starts a forced-exit timer as a safety net.
   * 3. Runs all registered cleanup callbacks sequentially.
   * 4. Removes the PID file.
   * 5. Exits with code 0.
   *
   * Idempotent — second and subsequent calls are no-ops.
   */
  async shutdown(reason: string): Promise<void> {
    if (this.shutdownCalled) {
      return;
    }
    this.shutdownCalled = true;

    // Signal shutdown initiated so waiters can unblock
    if (this.shutdownResolve) {
      this.shutdownResolve();
      this.shutdownResolve = null;
    }

    this.log(`Received ${reason}, shutting down gracefully...`);

    // Safety net: if cleanup hangs, force exit after timeout.
    const forceTimer = setTimeout(() => {
      this.log(
        `Cleanup did not finish within ${this.forceTimeoutMs}ms — forcing exit.`,
      );
      // Remove PID file even on forced exit.
      if (this.pidfilePath) {
        removePidfile(this.pidfilePath);
      }
      process.exit(1);
    }, this.forceTimeoutMs);
    forceTimer.unref(); // Don't let the timer itself keep the process alive.

    // Run cleanups sequentially.
    for (const { name, fn } of this.cleanups) {
      try {
        await fn();
      } catch (error) {
        this.log(
          `Cleanup "${name}" error: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // Remove PID file.
    if (this.pidfilePath) {
      removePidfile(this.pidfilePath);
    }

    clearTimeout(forceTimer);
    process.exit(0);
  }

  /**
   * Whether shutdown has already been triggered.
   */
  get isShuttingDown(): boolean {
    return this.shutdownCalled;
  }
}
