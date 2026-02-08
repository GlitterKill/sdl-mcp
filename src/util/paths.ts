import * as path from "path";

export function normalizePath(p: string): string {
  const normalized = path.normalize(p);
  return normalized.split(path.sep).join("/");
}

export function getRelativePath(from: string, to: string): string {
  return normalizePath(path.relative(from, to));
}

export function safeJoin(...parts: string[]): string {
  const result = path.normalize(path.join(...parts));
  return normalizePath(result);
}

function containsPathTraversal(p: string): boolean {
  const normalized = normalizePath(p);
  if (normalized.startsWith("..")) return true;
  if (normalized.includes("/../")) return true;
  if (normalized.endsWith("/..")) return true;
  if (normalized.includes("\\..\\")) return true;
  return false;
}

export function validatePathWithinRoot(root: string, target: string): string {
  const absoluteRoot = path.resolve(root);
  const absoluteTarget = path.resolve(root, target);

  const normalizedRoot = normalizePath(absoluteRoot);
  const normalizedTarget = normalizePath(absoluteTarget);

  if (!normalizedTarget.startsWith(normalizedRoot + "/")) {
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
