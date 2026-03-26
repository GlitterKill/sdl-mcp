import * as path from "path";
import { ValidationError } from "../domain/errors.js";

function toForwardSlashes(p: string): string {
  return p.replace(/\\/g, "/");
}

function toBackSlashes(p: string): string {
  return p.replace(/\//g, "\\");
}

function isWindowsPathLike(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\") || p.startsWith("//");
}

export function normalizePath(p: string): string {
  if (p === "") {
    return path.posix.normalize(p);
  }

  const slashNormalized = toForwardSlashes(p);
  if (isWindowsPathLike(slashNormalized)) {
    const winNormalized = path.win32.normalize(toBackSlashes(slashNormalized));
    return toForwardSlashes(winNormalized);
  }

  return path.posix.normalize(slashNormalized);
}

export function getRelativePath(from: string, to: string): string {
  const normalizedFrom = normalizePath(from);
  const normalizedTo = normalizePath(to);
  const useWindowsPaths =
    isWindowsPathLike(normalizedFrom) || isWindowsPathLike(normalizedTo);

  if (useWindowsPaths) {
    return normalizePath(
      path.win32.relative(
        toBackSlashes(normalizedFrom),
        toBackSlashes(normalizedTo),
      ),
    );
  }

  return normalizePath(path.posix.relative(normalizedFrom, normalizedTo));
}

export function safeJoin(...parts: string[]): string {
  if (parts.length === 0) {
    return ".";
  }

  const normalizedParts = parts.map((part) => normalizePath(part));
  if (isWindowsPathLike(normalizedParts[0])) {
    const winResult = path.win32.join(
      ...normalizedParts.map((part) => toBackSlashes(part)),
    );
    return normalizePath(winResult);
  }

  return normalizePath(path.posix.join(...normalizedParts));
}

function containsPathTraversal(p: string): boolean {
  // Decode percent-encoded sequences before checking (e.g., %2e%2e = ..)
  let decoded: string;
  try {
    decoded = decodeURIComponent(p);
  } catch {
    decoded = p;
  }
  const normalized = normalizePath(decoded);
  if (normalized.startsWith("..")) return true;
  if (normalized.includes("/../")) return true;
  if (normalized.endsWith("/..")) return true;
  return false;
}

export function validatePathWithinRoot(root: string, target: string): string {
  const normalizedRootInput = normalizePath(root);
  const normalizedTargetInput = normalizePath(target);
  const useWindowsPaths = isWindowsPathLike(normalizedRootInput);

  const absoluteRoot = useWindowsPaths
    ? path.win32.resolve(toBackSlashes(normalizedRootInput))
    : path.posix.resolve(normalizedRootInput);
  const absoluteTarget = useWindowsPaths
    ? path.win32.resolve(
        toBackSlashes(normalizedRootInput),
        toBackSlashes(normalizedTargetInput),
      )
    : path.posix.resolve(normalizedRootInput, normalizedTargetInput);

  const normalizedRoot = normalizePath(absoluteRoot);
  const normalizedTarget = normalizePath(absoluteTarget);
  const comparisonRoot = useWindowsPaths
    ? normalizedRoot.toLowerCase()
    : normalizedRoot;
  const comparisonTarget = useWindowsPaths
    ? normalizedTarget.toLowerCase()
    : normalizedTarget;
  const rootPrefix = comparisonRoot.endsWith("/")
    ? comparisonRoot
    : `${comparisonRoot}/`;

  if (
    comparisonTarget !== comparisonRoot &&
    !comparisonTarget.startsWith(rootPrefix)
  ) {
    throw new ValidationError(
      `Path traversal detected: ${target} escapes repository root`,
    );
  }

  return absoluteTarget;
}

/**
 * Async variant that follows symlinks before validation.
 * Use this when the caller can await and symlink escape must be prevented.
 */
export async function validatePathWithinRootAsync(
  root: string,
  target: string,
): Promise<string> {
  const absoluteTarget = validatePathWithinRoot(root, target);
  let realTarget: string;
  let realRoot: string;
  try {
    const { realpath } = await import("node:fs/promises");
    realTarget = await realpath(absoluteTarget);
    realRoot = await realpath(root);
  } catch {
    return absoluteTarget;
  }
  const normalizedRealTarget = normalizePath(realTarget);
  const normalizedRealRoot = normalizePath(realRoot);
  const useWindows = isWindowsPathLike(normalizedRealRoot);
  const cmpTarget = useWindows ? normalizedRealTarget.toLowerCase() : normalizedRealTarget;
  const cmpRoot = useWindows ? normalizedRealRoot.toLowerCase() : normalizedRealRoot;
  const prefix = cmpRoot.endsWith("/") ? cmpRoot : cmpRoot + "/";
  if (cmpTarget !== cmpRoot && !cmpTarget.startsWith(prefix)) {
    throw new ValidationError(
      "Symlink escape detected: " + target + " resolves outside repository root",
    );
  }
  return absoluteTarget;
}

export function getAbsolutePathFromRepoRoot(
  repoRoot: string,
  relPath: string,
): string {
  if (containsPathTraversal(relPath)) {
    throw new ValidationError(`Path traversal sequence detected in: ${relPath}`);
  }

  const absolutePath = validatePathWithinRoot(repoRoot, relPath);
  return normalizePath(absolutePath);
}
