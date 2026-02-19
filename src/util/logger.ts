export type LogLevel = "debug" | "info" | "warn" | "error";

import {
  initTracing as initTracingInternal,
  isTracingEnabled,
  shutdownTracing as shutdownTracingInternal,
} from "./tracing.js";

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
      writeToStderr(`[DEBUG] ${message}${metaStr}`);
    }
  }

  info(message: string, meta?: Record<string, unknown>): void {
    if (this.shouldLog("info")) {
      const processed = extractErrorMeta(meta);
      const metaStr = processed ? " " + safeStringify(processed) : "";
      writeToStderr(`[INFO] ${message}${metaStr}`);
    }
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    if (this.shouldLog("warn")) {
      const processed = extractErrorMeta(meta);
      const metaStr = processed ? " " + safeStringify(processed) : "";
      writeToStderr(`[WARN] ${message}${metaStr}`);
    }
  }

  error(message: string, meta?: Record<string, unknown>): void {
    if (this.shouldLog("error")) {
      const processed = extractErrorMeta(meta);
      const metaStr = processed ? " " + safeStringify(processed) : "";
      writeToStderr(`[ERROR] ${message}${metaStr}`);
    }
  }
}

export const logger = new Logger();

export {
  initTracingInternal as initTracing,
  isTracingEnabled,
  shutdownTracingInternal as shutdownTracing,
};
