import type { LogLevel, LogFormat } from "./types.js";

let currentLogLevel: LogLevel = "info";
let currentFormat: LogFormat = "pretty";
let requestIdCounter = 0;

export function configureLogger(level: LogLevel, format: LogFormat): void {
  currentLogLevel = level;
  currentFormat = format;
}

export function generateRequestId(): string {
  return `req_${Date.now()}_${++requestIdCounter}`;
}

function shouldLog(level: LogLevel): boolean {
  const levels: LogLevel[] = ["debug", "info", "warn", "error"];
  return levels.indexOf(level) >= levels.indexOf(currentLogLevel);
}

function formatMessage(
  level: LogLevel,
  message: string,
  meta?: Record<string, unknown>,
): string {
  const timestamp = new Date().toISOString();
  const requestId = meta?.requestId as string | undefined;

  if (currentFormat === "json") {
    const logEntry: Record<string, unknown> = {
      timestamp,
      level,
      message,
      ...meta,
    };
    if (requestId) {
      logEntry.requestId = requestId;
    }
    return JSON.stringify(logEntry);
  }

  const prefix = `[${timestamp}] [${level.toUpperCase()}]`;
  const requestIdStr = requestId ? ` [${requestId}]` : "";
  const metaStr = meta ? ` ${JSON.stringify(meta)}` : "";
  return `${prefix}${requestIdStr} ${message}${metaStr}`;
}

function log(
  level: LogLevel,
  message: string,
  meta?: Record<string, unknown>,
): void {
  if (!shouldLog(level)) {
    return;
  }

  const formatted = formatMessage(level, message, meta);
  console.error(formatted);
}

export const logger = {
  debug: (message: string, meta?: Record<string, unknown>) =>
    log("debug", message, meta),
  info: (message: string, meta?: Record<string, unknown>) =>
    log("info", message, meta),
  warn: (message: string, meta?: Record<string, unknown>) =>
    log("warn", message, meta),
  error: (message: string, meta?: Record<string, unknown>) =>
    log("error", message, meta),
};
