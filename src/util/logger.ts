export type LogLevel = "debug" | "info" | "warn" | "error";

// MCP servers must use stderr for ALL logging - stdout is reserved for JSON-RPC
const writeToStderr = (msg: string): void => {
  process.stderr.write(msg + "\n");
};

function safeStringify(obj: Record<string, unknown>): string {
  try {
    return JSON.stringify(obj);
  } catch (e) {
    return "[circular or unstringifiable]";
  }
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
      const metaStr = meta ? " " + safeStringify(meta) : "";
      writeToStderr(`[DEBUG] ${message}${metaStr}`);
    }
  }

  info(message: string, meta?: Record<string, unknown>): void {
    if (this.shouldLog("info")) {
      const metaStr = meta ? " " + safeStringify(meta) : "";
      writeToStderr(`[INFO] ${message}${metaStr}`);
    }
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    if (this.shouldLog("warn")) {
      const metaStr = meta ? " " + safeStringify(meta) : "";
      writeToStderr(`[WARN] ${message}${metaStr}`);
    }
  }

  error(message: string, meta?: Record<string, unknown>): void {
    if (this.shouldLog("error")) {
      const metaStr = meta ? " " + safeStringify(meta) : "";
      writeToStderr(`[ERROR] ${message}${metaStr}`);
    }
  }
}

export const logger = new Logger();
