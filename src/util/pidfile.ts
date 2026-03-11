/**
 * PID file management for SDL-MCP server process discovery and reuse.
 *
 * Writes a JSON PID file alongside the graph database so that:
 * 1. A new server can detect a stale (crashed) predecessor and clean up.
 * 2. A client can discover a running server's PID and transport info.
 *
 * The PID file lives at `<graphDbDir>/sdl-mcp.pid` and contains:
 *   { pid, transport, port?, startedAt }
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { dirname, resolve } from "path";

import { PIDFILE_NAME } from "../config/constants.js";

export interface PidfileData {
  /** Process ID of the running server. */
  pid: number;
  /** Transport type the server is listening on. */
  transport: "stdio" | "http";
  /** HTTP port (only present when transport === "http"). */
  port?: number;
  /** ISO-8601 timestamp when the server started. */
  startedAt: string;
}

function formatPidfileDirectoryGuidance(graphDbPath: string): string {
  const pidfilePath = resolvePidfilePath(graphDbPath);
  return (
    `Kill it first or use an SDL_GRAPH_DB_PATH in a different directory ` +
    `so it gets a separate PID file (${pidfilePath}).`
  );
}

/**
 * Resolve the pidfile path given a graph database path.
 * The pidfile lives in the same directory as the LadybugDB database file.
 */
export function resolvePidfilePath(graphDbPath: string): string {
  return resolve(dirname(graphDbPath), PIDFILE_NAME);
}

/**
 * Check whether a process with the given PID is still alive.
 * Uses `process.kill(pid, 0)` which sends no signal but throws if the
 * process does not exist. Works cross-platform (Node.js handles the
 * Windows/POSIX difference internally).
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read and parse an existing PID file, returning `null` if it does not
 * exist or cannot be parsed.
 */
export function readPidfile(pidfilePath: string): PidfileData | null {
  if (!existsSync(pidfilePath)) {
    return null;
  }

  try {
    const raw = readFileSync(pidfilePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      "pid" in parsed &&
      typeof (parsed as PidfileData).pid === "number" &&
      "transport" in parsed &&
      "startedAt" in parsed
    ) {
      return parsed as PidfileData;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Attempt to find a running SDL-MCP process from the PID file.
 *
 * Returns the PID file data when the referenced process is still alive,
 * `null` otherwise. Automatically removes stale PID files for dead
 * processes.
 */
export function findExistingProcess(graphDbPath: string): PidfileData | null {
  const pidfilePath = resolvePidfilePath(graphDbPath);
  const data = readPidfile(pidfilePath);
  if (!data) {
    return null;
  }

  if (isProcessAlive(data.pid)) {
    return data;
  }

  // Stale PID file — process is no longer running. Clean up.
  removePidfile(pidfilePath);
  return null;
}

export function formatExistingProcessMessage(
  graphDbPath: string,
  existing: PidfileData,
): string {
  return (
    `Found existing SDL-MCP server (PID ${existing.pid}, ` +
    `transport: ${existing.transport}, started: ${existing.startedAt}). ` +
    formatPidfileDirectoryGuidance(graphDbPath)
  );
}

/**
 * Write a PID file for the current process.
 *
 * If a PID file already exists for a **live** process, throws an error
 * to prevent two servers from sharing the same database directory.
 * Stale PID files (dead processes) are silently replaced.
 */
export function writePidfile(
  graphDbPath: string,
  transport: "stdio" | "http",
  port?: number,
): string {
  const pidfilePath = resolvePidfilePath(graphDbPath);

  // Check for an existing live process first.
  const existing = readPidfile(pidfilePath);
  if (
    existing &&
    isProcessAlive(existing.pid) &&
    existing.pid !== process.pid
  ) {
    throw new Error(
      `Another SDL-MCP server (PID ${existing.pid}) is already running ` +
        `for this database directory. ` +
        formatPidfileDirectoryGuidance(graphDbPath),
    );
  }

  const parentDir = dirname(pidfilePath);
  if (parentDir && parentDir !== "." && !existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true });
  }

  const data: PidfileData = {
    pid: process.pid,
    transport,
    ...(port !== undefined ? { port } : {}),
    startedAt: new Date().toISOString(),
  };

  writeFileSync(pidfilePath, JSON.stringify(data, null, 2) + "\n", "utf8");
  return pidfilePath;
}

/**
 * Remove the PID file. Safe to call even if the file does not exist.
 */
export function removePidfile(pidfilePath: string): void {
  try {
    if (existsSync(pidfilePath)) {
      unlinkSync(pidfilePath);
    }
  } catch {
    // Best-effort — file may already be gone or locked.
  }
}
