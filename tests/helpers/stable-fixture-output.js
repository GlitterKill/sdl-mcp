const WORKSPACE_PREFIX = `${process.cwd().replaceAll("\\", "/")}/`;

function normalizeWorkspacePath(value) {
  const normalized = value.replaceAll("\\", "/");
  return normalized.startsWith(WORKSPACE_PREFIX)
    ? normalized.slice(WORKSPACE_PREFIX.length)
    : value;
}

/** Remove checkout-specific prefixes while preserving the fixture's data shape. */
export function normalizeFixtureOutput(value) {
  return JSON.parse(
    JSON.stringify(value, (_key, entry) =>
      typeof entry === "string" ? normalizeWorkspacePath(entry) : entry,
    ),
  );
}

/** Serialize golden data without embedding the current checkout path. */
export function stringifyFixtureOutput(value) {
  return JSON.stringify(normalizeFixtureOutput(value), null, 2);
}
