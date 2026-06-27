import type { ShutdownManager } from "../util/shutdown.js";
import { logger } from "../util/logger.js";
import { isBrokenPipeError, safeWriteStderr } from "../util/stdio-safety.js";

type ProcessHandlerShutdown = Pick<ShutdownManager, "shutdown">;

let installed = false;
let installedHandlers:
  | {
      uncaughtException: (error: Error) => void;
      unhandledRejection: (reason: unknown) => void;
      stdioError: (error: Error) => void;
    }
  | null = null;

/**
 * Install process-level fatal/error handlers once per process.
 *
 * Both the direct MCP entrypoint and the CLI serve command need the same
 * behavior. Keeping the handlers here avoids listener drift and duplicate
 * shutdown attempts when both paths are embedded in a single host process.
 */
export function installProcessHandlers(
  shutdownMgr: ProcessHandlerShutdown,
): () => void {
  if (installed) return () => {};

  const stdioError = (error: Error): void => {
    if (!isBrokenPipeError(error)) throw error;
    void shutdownMgr.shutdown("stdio pipe error", 1);
  };

  const uncaughtException = (error: Error): void => {
    safeWriteStderr(
      `[sdl-mcp] Fatal uncaught exception: ${error.message}\n`,
    );
    logger.error("Uncaught exception", {
      error: error.message,
      stack: error.stack,
    });
    void shutdownMgr.shutdown("uncaught exception", 1);
  };

  const unhandledRejection = (reason: unknown): void => {
    const message = reason instanceof Error ? reason.message : String(reason);
    safeWriteStderr(`[sdl-mcp] Unhandled rejection: ${message}\n`);
    logger.error("Unhandled rejection", {
      error: message,
      stack: reason instanceof Error ? reason.stack : undefined,
    });
    // Do not exit for fire-and-forget task failures; the handler exists to
    // preserve diagnostics without killing healthy long-lived transports.
  };

  process.on("uncaughtException", uncaughtException);
  process.on("unhandledRejection", unhandledRejection);
  process.stdout.on("error", stdioError);
  process.stderr.on("error", stdioError);
  installed = true;
  installedHandlers = { uncaughtException, unhandledRejection, stdioError };

  return () => {
    if (!installedHandlers) return;
    process.off("uncaughtException", installedHandlers.uncaughtException);
    process.off("unhandledRejection", installedHandlers.unhandledRejection);
    process.stdout.off("error", installedHandlers.stdioError);
    process.stderr.off("error", installedHandlers.stdioError);
    installedHandlers = null;
    installed = false;
  };
}
