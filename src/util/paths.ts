import * as path from "path";

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
  const normalized = normalizePath(p);
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
  const rootPrefix = normalizedRoot.endsWith("/")
    ? normalizedRoot
    : `${normalizedRoot}/`;

  if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(rootPrefix)) {
    throw new Error(
      `Path traversal detected: ${target} escapes repository root`,
    );
  }

  return absoluteTarget;
}

export function getAbsolutePathFromRepoRoot(
  repoRoot: string,
  relPath: string,
): string {
  if (containsPathTraversal(relPath)) {
    throw new Error(`Path traversal sequence detected in: ${relPath}`);
  }

  const absolutePath = validatePathWithinRoot(repoRoot, relPath);
  return normalizePath(absolutePath);
}
