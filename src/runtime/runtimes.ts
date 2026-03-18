/**
 * Runtime registry — detection and command-building for supported runtimes.
 *
 * v1 runtimes: node, python, shell.
 * Each runtime implements RuntimeDescriptor for detection and command construction.
 */

import { execSync } from "child_process";
import { basename } from "path";
import type { RuntimeDescriptor, RuntimeDetectionResult } from "./types.js";

// ============================================================================
// Detection Cache
// ============================================================================

const detectionCache = new Map<string, RuntimeDetectionResult>();
const RUNTIME_EXECUTABLE_ALIASES = new Map<string, Set<string>>([
  ["node", new Set(["node", "node.exe", "bun", "bun.exe"])],
  [
    "python",
    new Set([
      "python",
      "python.exe",
      "python3",
      "python3.exe",
      "py",
      "py.exe",
    ]),
  ],
  ["shell", new Set(["bash", "bash.exe", "sh", "sh.exe", "cmd", "cmd.exe"])],
]);

function getCached(name: string): RuntimeDetectionResult | undefined {
  return detectionCache.get(name);
}

function setCached(name: string, result: RuntimeDetectionResult): void {
  detectionCache.set(name, result);
}

/**
 * Clear the detection cache. Primarily for testing.
 */
export function clearDetectionCache(): void {
  detectionCache.clear();
}

// ============================================================================
// Cross-Platform Helpers
// ============================================================================

const IS_WINDOWS = process.platform === "win32";

/**
 * Escape a string for safe inclusion in a shell command by wrapping it in
 * single quotes and escaping any embedded single quotes.
 */
function shellEscape(arg: string): string {
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

export function normalizeExecutableName(executable: string): string {
  const trimmed = executable.trim().replace(/^["']|["']$/g, "");
  return basename(trimmed.replace(/\\/g, "/")).toLowerCase();
}

export function isExecutableCompatibleWithRuntime(
  runtime: string,
  executable: string,
): boolean {
  const aliases = RUNTIME_EXECUTABLE_ALIASES.get(runtime);
  if (!aliases) {
    return false;
  }
  return aliases.has(normalizeExecutableName(executable));
}

/**
 * Resolve an executable to its absolute path using `where` (Windows) or `which` (Unix).
 * Returns undefined if not found.
 */
function resolveExecutable(name: string): string | undefined {
  try {
    const cmd = IS_WINDOWS ? `where ${name}` : `which ${name}`;
    const result = execSync(cmd, {
      encoding: "utf-8",
      timeout: 5000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    // `where` on Windows may return multiple lines; take the first
    const firstLine = result.split(/\r?\n/)[0];
    return firstLine || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Get version string from an executable.
 */
function getVersion(
  executable: string,
  versionFlag: string,
): string | undefined {
  try {
    const result = execSync(`${executable} ${versionFlag}`, {
      encoding: "utf-8",
      timeout: 5000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return result || undefined;
  } catch {
    return undefined;
  }
}

// ============================================================================
// Node Runtime
// ============================================================================

const nodeRuntime: RuntimeDescriptor = {
  name: "node",

  async detect(): Promise<RuntimeDetectionResult> {
    const cached = getCached("node");
    if (cached) return cached;

    // Check for Bun first (preferred for JS/TS)
    const bunPath = resolveExecutable("bun");
    if (bunPath) {
      const version = getVersion("bun", "--version");
      const result: RuntimeDetectionResult = {
        available: true,
        version: version ? `bun ${version}` : "bun",
        path: bunPath,
      };
      setCached("node", result);
      return result;
    }

    // Fall back to Node
    const nodePath = resolveExecutable("node");
    if (nodePath) {
      const version = getVersion("node", "--version");
      const result: RuntimeDetectionResult = {
        available: true,
        version: version ? `node ${version}` : "node",
        path: nodePath,
      };
      setCached("node", result);
      return result;
    }

    const result: RuntimeDetectionResult = { available: false };
    setCached("node", result);
    return result;
  },

  buildCommand(
    args: string[],
    opts: { codePath?: string; executable?: string },
  ): { executable: string; args: string[] } {
    const executable = opts.executable ?? "node";

    if (opts.codePath) {
      return { executable, args: [opts.codePath, ...args] };
    }

    return { executable, args };
  },
};

// ============================================================================
// Python Runtime
// ============================================================================

const pythonRuntime: RuntimeDescriptor = {
  name: "python",

  async detect(): Promise<RuntimeDetectionResult> {
    const cached = getCached("python");
    if (cached) return cached;

    // On Unix, prefer `python3`; on Windows, `python`
    const candidates = IS_WINDOWS
      ? ["python", "python3"]
      : ["python3", "python"];

    for (const candidate of candidates) {
      const execPath = resolveExecutable(candidate);
      if (execPath) {
        const version = getVersion(candidate, "--version");
        const result: RuntimeDetectionResult = {
          available: true,
          version: version ?? candidate,
          path: execPath,
        };
        setCached("python", result);
        return result;
      }
    }

    const result: RuntimeDetectionResult = { available: false };
    setCached("python", result);
    return result;
  },

  buildCommand(
    args: string[],
    opts: { codePath?: string; executable?: string },
  ): { executable: string; args: string[] } {
    const executable = opts.executable ?? (IS_WINDOWS ? "python" : "python3");

    if (opts.codePath) {
      return { executable, args: [opts.codePath, ...args] };
    }

    return { executable, args };
  },
};

// ============================================================================
// Shell Runtime
// ============================================================================

const shellRuntime: RuntimeDescriptor = {
  name: "shell",

  async detect(): Promise<RuntimeDetectionResult> {
    const cached = getCached("shell");
    if (cached) return cached;

    if (IS_WINDOWS) {
      // cmd.exe is always available on Windows
      const result: RuntimeDetectionResult = {
        available: true,
        version: "cmd.exe",
        path: "cmd.exe",
      };
      setCached("shell", result);
      return result;
    }

    // Unix: prefer bash
    const bashPath = resolveExecutable("bash");
    if (bashPath) {
      const version = getVersion("bash", "--version");
      const firstLine = version?.split("\n")[0];
      const result: RuntimeDetectionResult = {
        available: true,
        version: firstLine ?? "bash",
        path: bashPath,
      };
      setCached("shell", result);
      return result;
    }

    // Fall back to sh
    const shPath = resolveExecutable("sh");
    if (shPath) {
      const result: RuntimeDetectionResult = {
        available: true,
        version: "sh",
        path: shPath,
      };
      setCached("shell", result);
      return result;
    }

    const result: RuntimeDetectionResult = { available: false };
    setCached("shell", result);
    return result;
  },

  buildCommand(
    args: string[],
    opts: { codePath?: string; executable?: string },
  ): { executable: string; args: string[] } {
    if (IS_WINDOWS) {
      const executable = opts.executable ?? "cmd.exe";
      if (opts.codePath) {
        return { executable, args: ["/c", opts.codePath, ...args] };
      }
      return { executable, args: ["/c", ...args] };
    }

    const executable = opts.executable ?? "bash";
    if (opts.codePath) {
      return { executable, args: [opts.codePath, ...args] };
    }
    return { executable, args: ["-c", args.map(shellEscape).join(" ")] };
  },
};

// ============================================================================
// Registry
// ============================================================================

const RUNTIME_REGISTRY = new Map<string, RuntimeDescriptor>([
  ["node", nodeRuntime],
  ["python", pythonRuntime],
  ["shell", shellRuntime],
]);

/**
 * Get a runtime descriptor by name.
 */
export function getRuntime(name: string): RuntimeDescriptor | undefined {
  return RUNTIME_REGISTRY.get(name);
}

/**
 * Get all registered runtime names.
 */
export function getRegisteredRuntimes(): string[] {
  return Array.from(RUNTIME_REGISTRY.keys());
}

/**
 * Detect all registered runtimes and return their availability.
 */
export async function detectAllRuntimes(): Promise<
  Map<string, RuntimeDetectionResult>
> {
  const results = new Map<string, RuntimeDetectionResult>();
  for (const [name, descriptor] of RUNTIME_REGISTRY) {
    const detection = await descriptor.detect();
    results.set(name, detection);
  }
  return results;
}
