function escapeRegExp(value: string): string {
  return value.replace(
    /[.*+?^${}()|[\]\\]/g,
    (character) => "\\" + character,
  );
}

function absolutePathPattern(path: string): RegExp | undefined {
  const extendedUncPrefix = /^[\\/]{2}\?[\\/]UNC[\\/]/i;
  const standardUncPrefix = /^[\\/]{2}(?!\?[\\/])/;
  const uncPath = extendedUncPrefix.test(path)
    ? path.replace(extendedUncPrefix, "")
    : standardUncPrefix.test(path)
      ? path.replace(standardUncPrefix, "")
      : undefined;
  if (uncPath !== undefined) {
    const segments = uncPath.split(/[\\/]+/).filter(Boolean);
    if (segments.length >= 2) {
      const flexiblePath = segments
        .map(escapeRegExp)
        .join(String.raw`[\\/]+`);
      return new RegExp(
        `${String.raw`[\\/]{2}(?:\?[\\/]+UNC[\\/]+)?`}${flexiblePath}`,
        "gi",
      );
    }
  }

  const extendedWindowsPrefix = /^[\\/]{2}\?[\\/]/;
  const windowsPath = path.replace(extendedWindowsPrefix, "");
  if (
    extendedWindowsPrefix.test(path)
    && !/^[A-Za-z]:[\\/]/.test(windowsPath)
  ) {
    const segments = windowsPath.split(/[\\/]+/).filter(Boolean);
    if (segments.length >= 2) {
      const flexiblePath = segments
        .map(escapeRegExp)
        .join(String.raw`[\\/]+`);
      return new RegExp(
        `${String.raw`[\\/]{2}\?[\\/]+`}${flexiblePath}`,
        "gi",
      );
    }
  }
  if (/^[A-Za-z]:[\\/]/.test(windowsPath)) {
    const flexiblePath = windowsPath
      .split(/[\\/]+/)
      .map(escapeRegExp)
      .join(String.raw`[\\/]+`);
    return new RegExp(
      `${String.raw`(?:[\\/]{2}\?[\\/])?`}${flexiblePath}`,
      "gi",
    );
  }
  if (path.startsWith("/")) {
    const segments = path.split("/").filter(Boolean).map(escapeRegExp);
    return segments.length > 0
      ? new RegExp(`/+${segments.join("/+")}`, "g")
      : undefined;
  }
  return undefined;
}

/** Replaces known machine-specific roots while accepting either path separator. */
export function redactMachinePaths(
  message: string,
  knownPaths: readonly string[],
  replacement = "<redacted>",
): string {
  return knownPaths.reduce((redacted, path) => {
    const pattern = absolutePathPattern(path);
    return pattern ? redacted.replace(pattern, replacement) : redacted;
  }, message);
}
