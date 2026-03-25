import { appendFileSync, createWriteStream, mkdirSync, renameSync, statSync, type WriteStream } from "fs";
import { dirname, join } from "path";
import { homedir, tmpdir } from "os";
import {
  initTracing as initTracingInternal,
  isTracingEnabled,
  shutdownTracing as shutdownTracingInternal,
} from "./tracing.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_FILE_MAX_BYTES = 5 * 1024 * 1024;
const LOG_FILE_MAX_ROTATIONS = 3;
const LOG_ROTATION_CHECK_INTERVAL_BYTES = 64 * 1024;
const DEFAULT_LOG_DIR = join(homedir(), ".sdl-mcp", "logs");
const FALLBACK_LOG_DIR = join(tmpdir(), "sdl-mcp");
const DEFAULT_LOG_FILE_NAME = "sdl-mcp.log";

interface LoggerDiagnostics {
  configuredPath: string | null;
  activePath: string | null;
  consoleMirroring: boolean;
  fallbackUsed: boolean;
}

let logFilePath: string | null = null;
let configuredLogFilePath: string | null = null;
let logFileEnabled = false;
let logFileBytesSinceRotationCheck = 0;
let consoleMirroringEnabled = false;
let fallbackUsed = false;
let logStream: WriteStream | null = null;
let logWriteErrorCount = 0;

function isLogLevel(value: string | undefined): value is LogLevel {
  return value === "debug" || value === "info" || value === "warn" || value === "error";
}

function ensureDirectory(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true });
}

function resolveDefaultLogPath(): string {
  return join(DEFAULT_LOG_DIR, DEFAULT_LOG_FILE_NAME);
}

function resolveFallbackLogPath(): string {
  return join(FALLBACK_LOG_DIR, DEFAULT_LOG_FILE_NAME);
}

function rotateLogFile(filePath: string): void {
  try {
    const fileStats = statSync(filePath);
    if (fileStats.size < LOG_FILE_MAX_BYTES) return;
  } catch {
    return;
  }

  for (let i = LOG_FILE_MAX_ROTATIONS; i >= 1; i--) {
    const src = i === 1 ? filePath : `${filePath}.${i - 1}`;
    const dst = `${filePath}.${i}`;
    try {
      renameSync(src, dst);
    } catch {
      // Source may not exist. Skip rotation for that slot.
    }
  }
}

function setLogDestination(targetPath: string): void {
  ensureDirectory(dirname(targetPath));
  appendFileSync(targetPath, "", "utf-8");
  logFilePath = targetPath;
  logFileEnabled = true;
}

function applyLogPath(targetPath: string): void {
  configuredLogFilePath = targetPath;
  fallbackUsed = false;

  try {
    setLogDestination(targetPath);
  } catch {
    const fallbackPath = resolveFallbackLogPath();
    ensureDirectory(dirname(fallbackPath));
    setLogDestination(fallbackPath);
    fallbackUsed = true;
  }
}

function writeToLogFile(msg: string): void {
  if (!logFileEnabled || !logFilePath) return;

  try {
    const line = msg + "\n";
    logFileBytesSinceRotationCheck += Buffer.byteLength(line, "utf-8");
    if (logFileBytesSinceRotationCheck >= LOG_ROTATION_CHECK_INTERVAL_BYTES) {
      logStream?.end();
      logStream = null;
      rotateLogFile(logFilePath);
      logFileBytesSinceRotationCheck = 0;
    }
    if (!logStream) {
      logStream = createWriteStream(logFilePath, { flags: "a" });
    }
    logStream.write(line);
  } catch (err) {
    logWriteErrorCount++;
    if (logWriteErrorCount === 1 || logWriteErrorCount % 100 === 0) {
      process.stderr.write(`[sdl-mcp] Log file write failed (count: ${logWriteErrorCount}): ${err}\n`);
    }
  }
}

function writeToStderr(msg: string): void {
  if (!consoleMirroringEnabled) {
    return;
  }
  process.stderr.write(msg + "\n");
}

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

function formatLogLine(
  level: Uppercase<LogLevel>,
  message: string,
  meta?: Record<string, unknown>,
): string {
  const processed = extractErrorMeta(meta);
  const metaStr = processed ? " " + safeStringify(processed) : "";
  return `[${new Date().toISOString()}] [${level}] ${message}${metaStr}`;
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

  private emit(
    level: LogLevel,
    uppercaseLevel: Uppercase<LogLevel>,
    message: string,
    meta?: Record<string, unknown>,
  ): void {
    if (!this.shouldLog(level)) {
      return;
    }

    const line = formatLogLine(uppercaseLevel, message, meta);
    writeToLogFile(line);
    writeToStderr(line);
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.emit("debug", "DEBUG", message, meta);
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.emit("info", "INFO", message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.emit("warn", "WARN", message, meta);
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.emit("error", "ERROR", message, meta);
  }
}

export const logger = new Logger();

export function enableFileLogging(filePath?: string): void {
  applyLogPath(filePath ?? resolveDefaultLogPath());
}

export function disableFileLogging(): void {
  logStream?.end();
  logStream = null;
  logFileEnabled = false;
  logFilePath = null;
  configuredLogFilePath = null;
  fallbackUsed = false;
}

export function getLogFilePath(): string | null {
  return logFileEnabled ? logFilePath : null;
}

export function setConsoleMirroring(enabled: boolean): void {
  consoleMirroringEnabled = enabled;
}

export function getLoggerDiagnostics(): LoggerDiagnostics {
  return {
    configuredPath: configuredLogFilePath,
    activePath: getLogFilePath(),
    consoleMirroring: consoleMirroringEnabled,
    fallbackUsed,
  };
}

export function configureLoggerFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): void {
  const envLogLevel = env.SDL_LOG_LEVEL?.toLowerCase();
  if (isLogLevel(envLogLevel)) {
    logger.setLevel(envLogLevel);
  }

  consoleMirroringEnabled = /^(1|true)$/i.test(
    env.SDL_CONSOLE_LOGGING ?? "",
  );

  const envLogFile = env.SDL_LOG_FILE;
  if (!envLogFile) {
    return;
  }

  if (envLogFile === "1" || envLogFile.toLowerCase() === "true") {
    enableFileLogging();
    return;
  }

  enableFileLogging(envLogFile);
}

export function flushLogger(): void {
  // End the write stream to flush pending writes.
  logStream?.end();
  logStream = null;
}

export function shutdownLogger(): void {
  flushLogger();
}

export function closeLogStream(): void {
  logStream?.end();
  logStream = null;
}

configureLoggerFromEnvironment();

export {
  initTracingInternal as initTracing,
  isTracingEnabled,
  shutdownTracingInternal as shutdownTracing,
};
