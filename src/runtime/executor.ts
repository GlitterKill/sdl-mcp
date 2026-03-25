import { spawn, execFileSync } from "child_process";
import { mkdtemp, writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { realpath } from "fs/promises";
import { RUNTIME_SIGKILL_GRACE_MS } from "../config/constants.js";
import type {
  ExecutionRequest,
  ExecutionResult,
  ConcurrencyTracker,
} from "./types.js";
import { validatePathWithinRoot } from "../util/paths.js";
import { logger } from "../util/logger.js";

const IS_WINDOWS = process.platform === "win32";

export function killProcessTree(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) {
    logger.warn("killProcessTree: invalid PID, skipping", { pid });
    return;
  }
  if (IS_WINDOWS) {
    try {
      execFileSync("taskkill", ["/T", "/F", "/PID", String(pid)], {
        windowsHide: true,
        stdio: "ignore",
      });
    } catch {
      // Best-effort process cleanup.
    }
    return;
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // Process may already be gone.
  }

  setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Process group may already be gone.
    }
  }, RUNTIME_SIGKILL_GRACE_MS).unref();
}

export function buildScrubbedEnv(
  allowedKeys: string[],
  requiredEnvKeys: string[] = [],
): Record<string, string> {
  const env: Record<string, string> = {};

  const pathKey = process.env.PATH;
  if (pathKey) {
    env.PATH = pathKey;
  }

  if (IS_WINDOWS) {
    const home = process.env.USERPROFILE;
    const temp = process.env.TEMP;
    if (home) {
      env.USERPROFILE = home;
    }
    if (temp) {
      env.TEMP = temp;
    }
  } else {
    const home = process.env.HOME;
    const tmp = process.env.TMPDIR;
    if (home) {
      env.HOME = home;
    }
    if (tmp) {
      env.TMPDIR = tmp;
    }
  }

  for (const key of allowedKeys) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }

  // Add runtime-required env keys
  for (const key of requiredEnvKeys) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key]!;
    }
  }

  return env;
}

export async function createTempWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "sdl-runtime-"));
}

export async function cleanupTempWorkspace(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (error) {
    logger.warn("Failed to cleanup temp workspace", {
      dir,
      error: String(error),
    });
  }
}

export async function resolveAndValidateCwd(
  repoRoot: string,
  relativeCwd: string,
): Promise<string> {
  const canonicalRepoRoot = await realpath(repoRoot);
  const resolved = join(canonicalRepoRoot, relativeCwd);
  const resolvedRealpath = await realpath(resolved);
  validatePathWithinRoot(canonicalRepoRoot, resolvedRealpath);
  return resolvedRealpath;
}

export async function execute(
  request: ExecutionRequest,
): Promise<ExecutionResult> {
  const startTime = Date.now();

  let tempWorkspaceDir: string | null = null;
  let tempCodePath: string | null = null;

  if (request.codePath) {
    tempWorkspaceDir = await createTempWorkspace();
    tempCodePath = join(tempWorkspaceDir, "code-mode-script");
    await writeFile(tempCodePath, request.codePath, "utf8");
  }

  try {
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  let totalStdoutBytes = 0;
  let totalStderrBytes = 0;

  let stdoutTruncated = false;
  let stderrTruncated = false;

  const child = spawn(request.executable, request.args, {
    cwd: request.cwd,
    env: request.env,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    detached: !IS_WINDOWS,
    windowsHide: true,
  });

  child.stdout?.on("data", (chunk: Buffer | string) => {
    const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalStdoutBytes += bufferChunk.length;

    if (stdoutTruncated) {
      return;
    }

    const projectedBytes = totalStdoutBytes;
    if (projectedBytes > request.maxStdoutBytes) {
      const bytesBeforeChunk = projectedBytes - bufferChunk.length;
      const remaining = Math.max(0, request.maxStdoutBytes - bytesBeforeChunk);
      if (remaining > 0) {
        stdoutChunks.push(bufferChunk.subarray(0, remaining));
      }
      stdoutTruncated = true;
      return;
    }

    stdoutChunks.push(bufferChunk);
  });

  child.stderr?.on("data", (chunk: Buffer | string) => {
    const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalStderrBytes += bufferChunk.length;

    if (stderrTruncated) {
      return;
    }

    const projectedBytes = totalStderrBytes;
    if (projectedBytes > request.maxStderrBytes) {
      const bytesBeforeChunk = projectedBytes - bufferChunk.length;
      const remaining = Math.max(0, request.maxStderrBytes - bytesBeforeChunk);
      if (remaining > 0) {
        stderrChunks.push(bufferChunk.subarray(0, remaining));
      }
      stderrTruncated = true;
      return;
    }

    stderrChunks.push(bufferChunk);
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (child.pid) {
      killProcessTree(child.pid);
    }
  }, request.timeoutMs);
  timer.unref();

  let cancelled = false;
  const onAbort = () => {
    cancelled = true;
    if (child.pid) {
      killProcessTree(child.pid);
    }
  };

  request.signal?.addEventListener("abort", onAbort, { once: true });

  const { exitCode, signal } = await new Promise<{
    exitCode: number | null;
    signal: string | null;
  }>((resolve) => {
    child.on("close", (code, sig) => resolve({ exitCode: code, signal: sig }));
    child.on("error", (err) => {
      logger.error("Process spawn error", { error: String(err) });
      resolve({ exitCode: 1, signal: null });
    });
  });

  clearTimeout(timer);
  request.signal?.removeEventListener("abort", onAbort);

  if (timedOut) {
    logger.warn("Runtime execution timed out", {
      timeoutMs: request.timeoutMs,
      error: `Runtime execution timed out after ${request.timeoutMs}ms`,
      executable: request.executable,
    });
  }

  return {
    status: cancelled
      ? "cancelled"
      : timedOut
        ? "timeout"
        : exitCode === 0
          ? "success"
          : "failure",
    exitCode,
    signal: signal ?? null,
    durationMs: Date.now() - startTime,
    stdout: Buffer.concat(stdoutChunks),
    stderr: Buffer.concat(stderrChunks),
    stdoutTruncated,
    stderrTruncated,
    totalStdoutBytes,
    totalStderrBytes,
  };
  } finally {
    if (tempWorkspaceDir) {
      await cleanupTempWorkspace(tempWorkspaceDir);
    }
  }
}

export function createConcurrencyTracker(maxJobs: number): ConcurrencyTracker {
  let activeCount = 0;

  return {
    get activeCount() {
      return activeCount;
    },
    acquire() {
      if (activeCount >= maxJobs) {
        return false;
      }
      activeCount++;
      return true;
    },
    release() {
      if (activeCount > 0) {
        activeCount--;
      }
    },
  };
}