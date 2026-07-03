/** Global regex for finding $N references (with optional dot/bracket path) embedded in strings. */
export const REF_PATTERN = new RegExp(
  String.raw`\$\d+(?:(?:\.(?:[a-zA-Z_]\w*|\d+))|(?:\[(?:\d+|\*)\])|(?:\?\.(?:[a-zA-Z_]\w*|\d+|\[(?:\d+|\*)\])))*`,
  "g",
);

/** Non-global single-match version used inside resolveRef. */
const REF_PATTERN_SINGLE = new RegExp(
  String.raw`^\$(\d+)((?:(?:\.(?:[a-zA-Z_]\w*|\d+))|(?:\[(?:\d+|\*)\])|(?:\?\.(?:[a-zA-Z_]\w*|\d+|\[(?:\d+|\*)\])))*)$`,
);

/** Property names that must never be navigated to prevent prototype pollution. */
const BLOCKED_PROPS = new Set(["__proto__", "constructor", "prototype"]);
const REF_METADATA = Symbol("sdl.workflow.refMetadata");

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type RefMetadataMap = Map<number, Record<string, unknown>>;
type PriorResultsWithMetadata = unknown[] & {
  [REF_METADATA]?: RefMetadataMap;
};

export function attachRefMetadata(
  priorResults: unknown[],
  index: number,
  metadata: Record<string, unknown>,
): void {
  const target = priorResults as PriorResultsWithMetadata;
  let existing = target[REF_METADATA];
  if (!existing) {
    existing = new Map<number, Record<string, unknown>>();
    Object.defineProperty(target, REF_METADATA, {
      value: existing,
      enumerable: false,
      configurable: false,
    });
  }
  existing.set(index, { ...(existing.get(index) ?? {}), ...metadata });
}

function getRefMetadata(
  priorResults: unknown[],
  index: number,
): Record<string, unknown> | undefined {
  return (priorResults as PriorResultsWithMetadata)[REF_METADATA]?.get(index);
}

export class RefResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefResolutionError";
  }
}

interface RefSegment {
  optional: boolean;
  value: string | number;
  /** True for a "[*]" segment that projects over every array element. */
  wildcard?: boolean;
}

function parseSegments(pathStr: string, ref: string): RefSegment[] {
  const segments: RefSegment[] = [];
  let index = 0;

  while (index < pathStr.length) {
    const optional = pathStr.startsWith("?.", index);
    if (optional) {
      index += 2;
    } else if (pathStr[index] === ".") {
      index += 1;
    } else if (pathStr[index] !== "[") {
      throw new RefResolutionError(`Invalid reference syntax: '${ref}'`);
    }

    if (pathStr[index] === "[") {
      const closing = pathStr.indexOf("]", index);
      if (closing === -1) {
        throw new RefResolutionError(`Invalid reference syntax: '${ref}'`);
      }
      const rawIndex = pathStr.slice(index + 1, closing);
      if (rawIndex === "*") {
        segments.push({ optional, value: "*", wildcard: true });
      } else if (!/^\d+$/.test(rawIndex)) {
        throw new RefResolutionError(`Invalid reference syntax: '${ref}'`);
      } else {
        segments.push({ optional, value: parseInt(rawIndex, 10) });
      }
      index = closing + 1;
    } else {
      const numeric = /^\d+/.exec(pathStr.slice(index));
      if (numeric) {
        segments.push({ optional, value: parseInt(numeric[0], 10) });
        index += numeric[0].length;
        if (segments.length > 4) {
          throw new RefResolutionError(
            `Reference '${ref}' exceeds the maximum path depth of 4 segments`,
          );
        }
        continue;
      }
      const match = /^[a-zA-Z_]\w*/.exec(pathStr.slice(index));
      if (!match) {
        throw new RefResolutionError(`Invalid reference syntax: '${ref}'`);
      }
      segments.push({ optional, value: match[0] });
      index += match[0].length;
    }

    if (segments.length > 4) {
      throw new RefResolutionError(
        `Reference '${ref}' exceeds the maximum path depth of 4 segments`,
      );
    }
  }

  return segments;
}

/**
 * Resolves a single `$N` or `$N.path.to[i].field` reference against an array
 * of prior step results. Exported for unit testing.
 *
 * @throws {RefResolutionError} if the index is out of range, a field is missing,
 *   or an array index is out of bounds.
 */
export function resolveRef(ref: string, priorResults: unknown[]): unknown {
  const match = REF_PATTERN_SINGLE.exec(ref);
  if (!match) {
    throw new RefResolutionError(`Invalid reference syntax: '${ref}'`);
  }

  const n = parseInt(match[1], 10);
  if (n >= priorResults.length) {
    throw new RefResolutionError(
      `Reference $${n} is out of range — only ${priorResults.length} prior result(s) available`,
    );
  }

  const pathStr = match[2]; // e.g. ".field[0].name" or ""

  if (!pathStr) {
    return priorResults[n];
  }

  const segments = parseSegments(pathStr, ref);

  const metadata = getRefMetadata(priorResults, n);
  return navigateSegments(priorResults[n], segments, 0, ref, metadata);
}

function navigateSegments(
  start: unknown,
  segments: RefSegment[],
  startIndex: number,
  ref: string,
  metadata?: Record<string, unknown>,
): unknown {
  let current: unknown = start;
  for (let index = startIndex; index < segments.length; index++) {
    const segment = segments[index];
    const seg = segment.value;
    const isLastSegment = index === segments.length - 1;
    if (segment.wildcard) {
      if (current === null || current === undefined) {
        if (segment.optional) {
          return undefined;
        }
        throw new RefResolutionError(
          `Cannot navigate into null/undefined at segment '[*]' in reference '${ref}'`,
        );
      }
      if (!Array.isArray(current)) {
        throw new RefResolutionError(
          `Expected array at [*] in reference '${ref}', got ${typeof current}`,
        );
      }
      if (isLastSegment) {
        return [...current];
      }
      return current.map((element) =>
        navigateSegments(element, segments, index + 1, ref),
      );
    }
    if (current === null || current === undefined) {
      if (segment.optional) {
        return undefined;
      }
      throw new RefResolutionError(
        `Cannot navigate into null/undefined at segment '${String(seg)}' in reference '${ref}'`,
      );
    }

    if (typeof seg === "number") {
      if (!Array.isArray(current)) {
        if (segment.optional) {
          return undefined;
        }
        throw new RefResolutionError(
          `Expected array at index [${seg}] in reference '${ref}', got ${typeof current}`,
        );
      }
      if (seg >= current.length || seg < 0) {
        if (segment.optional) {
          return undefined;
        }
        if (isLastSegment) {
          throw new RefResolutionError(
            `Array index [${seg}] is out of bounds (length ${current.length}) in reference '${ref}'`,
          );
        }
        current = undefined;
        continue;
      }
      current = current[seg];
    } else {
      if (BLOCKED_PROPS.has(seg)) {
        throw new RefResolutionError(
          `Access to property '${seg}' is blocked in reference '${ref}'`,
        );
      }
      if (
        index === 0 &&
        metadata &&
        Object.prototype.hasOwnProperty.call(metadata, seg)
      ) {
        current = metadata[seg];
        continue;
      }
      if (!isPlainRecord(current)) {
        if (segment.optional) {
          return undefined;
        }
        throw new RefResolutionError(
          `Expected object at field '${seg}' in reference '${ref}', got ${Array.isArray(current) ? "array" : typeof current}`,
        );
      }
      const obj = current;
      if (!(seg in obj)) {
        if (segment.optional) {
          return undefined;
        }
        if (isLastSegment) {
          const availableKeys = Object.keys(obj).filter(k => !k.startsWith('_')).slice(0, 10);
          const suggestion = availableKeys.length > 0
            ? `. Available keys: ${availableKeys.join(', ')}`
            : '';
          throw new RefResolutionError(
            `Field '${seg}' does not exist in reference '${ref}'${suggestion}`,
          );
        }
        current = undefined;
        continue;
      }
      current = obj[seg];
    }
  }

  return current;
}

/**
 * Deep-resolves all `$N` references within an args object.
 *
 * Resolution rules:
 * - If an entire string value IS a ref (e.g. `"$0.symbols[0].symbolId"`) →
 *   the string is replaced with the resolved value directly (type-preserving).
 * - If a string CONTAINS embedded refs (e.g. `"prefix $0.name suffix"`) →
 *   each ref is stringified and interpolated in place.
 * - Arrays and plain objects are recursed into.
 * - Numbers, booleans, and null are passed through unchanged.
 *
 * @throws {RefResolutionError} if any reference is invalid or out of range.
 */
export function resolveRefs(
  args: Record<string, unknown>,
  priorResults: unknown[],
): Record<string, unknown> {
  // Deep-clone to avoid mutating the original
  const cloned = structuredClone(args);

  function resolveValue(value: unknown): unknown {
    if (typeof value === "string") {
      // Check if the entire string is a single $N reference
      if (REF_PATTERN_SINGLE.test(value)) {
        return resolveRef(value, priorResults);
      }

      // Check if the string contains any embedded $N references
      const globalRe = new RegExp(REF_PATTERN.source, "g");
      if (globalRe.test(value)) {
        // Replace each embedded ref with its stringified value
        return value.replace(
          new RegExp(REF_PATTERN.source, "g"),
          (fullMatch) => {
            const resolved = resolveRef(fullMatch, priorResults);
            if (typeof resolved === "object" && resolved !== null) {
              return JSON.stringify(resolved);
            }
            return String(resolved);
          },
        );
      }

      return value;
    }

    if (Array.isArray(value)) {
      return value.map(resolveValue);
    }

    if (value !== null && typeof value === "object") {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        result[k] = resolveValue(v);
      }
      return result;
    }

    // number, boolean, null — pass through unchanged
    return value;
  }

  const resolved = resolveValue(cloned);
  return resolved as Record<string, unknown>;
}
