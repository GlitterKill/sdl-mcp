function hasNestedSlice<T>(result: T | { slice: T }): result is { slice: T } {
  return typeof result === "object" && result !== null && "slice" in result;
}

export function unwrapSliceBuildResult<T>(result: T | { slice: T }): T {
  return hasNestedSlice(result) ? result.slice : result;
}
