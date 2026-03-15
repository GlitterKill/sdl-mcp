export type LogLevel = "debug" | "info" | "warn" | "error";

import { mkdirSync, appendFileSync, statSync, renameSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import {
  initTracing as initTracingInternal,
  isTracingEnabled,
  shutdownTracing as shutdownTracingInternal,
} from "./tracing.js";

// ============================================================================
// File logging support
// ============================================================================

/**
 * Maximum log file size before rotation (5 MB).
 */
const LOG_FILE_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Number of rotated log files to keep.
 */
const LOG_FILE_MAX_ROTATIONS = 3;

/**
 * Default log directory under user home.
 */
const DEFAULT_LOG_DIR = join(homedir(), ".sdl-mcp", "logs");

let logFilePath: string | null = null;
let logFileEnabled = false;
let logFileBytesSinceRotationCheck = 0;
const LOG_ROTATION_CHECK_INTERVAL_BYTES = 64 * 1024; // check every ~64KB of writes

function ensureLogDir(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // Directory may already exist or be uncreatable — degrade gracefully.
  }
}

function rotateLogFile(filePath: string): void {
  try {
    const fileStats = statSync(filePath);
    if (fileStats.size < LOG_FILE_MAX_BYTES) return;
  } catch {
    // File does not exist yet — nothing to rotate.
    return;
  }

  // Shift existing rotations: .3 → delete, .2 → .3, .1 → .2, current → .1
  for (let i = LOG_FILE_MAX_ROTATIONS; i >= 1; i--) {
    const src = i === 1 ? filePath : `${filePath}.${i - 1}`;
    const dst = `${filePath}.${i}`;
    try {
      renameSync(src, dst);
    } catch {
      // Source may not exist — skip.
    }
  }
}

function writeToLogFile(msg: string): void {
  if (!logFileEnabled || !logFilePath) return;
  try {
    const line = msg + "\n";
    logFileBytesSinceRotationCheck += line.length;
    if (logFileBytesSinceRotationCheck >= LOG_ROTATION_CHECK_INTERVAL_BYTES) {
      rotateLogFile(logFilePath);
      logFileBytesSinceRotationCheck = 0;
    }
    appendFileSync(logFilePath, line, "utf-8");
  } catch {
    // File write failed — degrade silently. Don't crash the server
    // because of a logging failure.
  }
}

/**
 * Enable file-based logging.
 *
 * - Pass a specific file path, or omit to use the default
 *   `~/.sdl-mcp/logs/sdl-mcp.log`.
 * - Can also be enabled via the `SDL_LOG_FILE` environment variable.
 *   Set it to a file path or `"1"` / `"true"` to use the default location.
 */
export function enableFileLogging(filePath?: string): void {
  const resolvedPath = filePath ?? join(DEFAULT_LOG_DIR, "sdl-mcp.log");
  const dir = resolvedPath.substring(
    0,
    Math.max(resolvedPath.lastIndexOf("/"), resolvedPath.lastIndexOf("\\")),
  );
  ensureLogDir(dir);
  logFilePath = resolvedPath;
  logFileEnabled = true;
}

/**
 * Disable file-based logging.
 */
export function disableFileLogging(): void {
  logFileEnabled = false;
  logFilePath = null;
}

/**
 * Returns the currently active log file path, or null if file logging
 * is disabled.
 */
export function getLogFilePath(): string | null {
  return logFileEnabled ? logFilePath : null;
}

// Auto-enable from environment variable.
const envLogFile = process.env.SDL_LOG_FILE;
if (envLogFile) {
  if (envLogFile === "1" || envLogFile.toLowerCase() === "true") {
    enableFileLogging();
  } else {
    enableFileLogging(envLogFile);
  }
}

// ============================================================================
// Core logger
// ============================================================================

const writeToStderr = (msg: string): void => {
  process.stderr.write(msg + "\n");
};

function safeStringify(obj: Record<string, unknown>): string {
  try {
    return JSON.stringify(obj);
  } catch {
    return "[circular or unstringifiable]";
  }
}

function extractErrorMeta(
  meta?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!meta) return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (value instanceof Error) {
      result[key] = value.message;
      if (value.stack) {
        result[`${key}Stack`] = value.stack;
      }
    } else {
      result[key] = value;
    }
  }
  return result;
}

class Logger {
  private level: LogLevel;

  constructor(level: LogLevel = "info") {
    this.level = level;
  }

  private shouldLog(level: LogLevel): boolean {
    const levels: LogLevel[] = ["debug", "info", "warn", "error"];
    return levels.indexOf(level) >= levels.indexOf(this.level);
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    if (this.shouldLog("debug")) {
      const processed = extractErrorMeta(meta);
      const metaStr = processed ? " " + safeStringify(processed) : "";
      const timestamp = new Date().toISOString();
      const line = `[${timestamp}] [DEBUG] ${message}${metaStr}`;
      writeToStderr(line);
      writeToLogFile(line);
    }
  }

  info(message: string, meta?: Record<string, unknown>): void {
    if (this.shouldLog("info")) {
      const processed = extractErrorMeta(meta);
      const metaStr = processed ? " " + safeStringify(processed) : "";
      const timestamp = new Date().toISOString();
      const line = `[${timestamp}] [INFO] ${message}${metaStr}`;
      writeToStderr(line);
      writeToLogFile(line);
    }
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    if (this.shouldLog("warn")) {
      const processed = extractErrorMeta(meta);
      const metaStr = processed ? " " + safeStringify(processed) : "";
      const timestamp = new Date().toISOString();
      const line = `[${timestamp}] [WARN] ${message}${metaStr}`;
      writeToStderr(line);
      writeToLogFile(line);
    }
  }

  error(message: string, meta?: Record<string, unknown>): void {
    if (this.shouldLog("error")) {
      const processed = extractErrorMeta(meta);
      const metaStr = processed ? " " + safeStringify(processed) : "";
      const timestamp = new Date().toISOString();
      const line = `[${timestamp}] [ERROR] ${message}${metaStr}`;
      writeToStderr(line);
      writeToLogFile(line);
    }
  }
}

export const logger = new Logger();

export {
  initTracingInternal as initTracing,
  isTracingEnabled,
  shutdownTracingInternal as shutdownTracing,
};
