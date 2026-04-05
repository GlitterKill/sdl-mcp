/**
 * SCIP descriptor -> SDL kind mapping.
 *
 * Maps SCIP symbol strings and LSP SymbolKind enum values to the
 * canonical SDL SymbolKind union used throughout the codebase.
 */

import type { ScipKindResult } from "./types.js";

// ---------------------------------------------------------------------------
// LSP SymbolKind enum values (from SCIP / LSP spec)
// ---------------------------------------------------------------------------

export const LSP_KIND = {
  UnspecifiedSymbolKind: 0,
  File: 1,
  Module: 2,
  Namespace: 3,
  Package: 4,
  Class: 5,
  Method: 6,
  Property: 7,
  Field: 8,
  Constructor: 9,
  Enum: 10,
  Interface: 11,
  Function: 12,
  Variable: 13,
  Constant: 14,
  String: 15,
  Number: 16,
  Boolean: 17,
  Array: 18,
  Object: 19,
  Key: 20,
  Null: 21,
  EnumMember: 22,
  Struct: 23,
  Event: 24,
  Operator: 25,
  TypeParameter: 26,
} as const;

// ---------------------------------------------------------------------------
// Constructor-name detection (language-agnostic)
// ---------------------------------------------------------------------------

const CONSTRUCTOR_NAMES = new Set([
  "constructor",
  "__init__",
  "<init>",
  "<clinit>",
  "new",
]);

// ---------------------------------------------------------------------------
// SCIP symbol string parser
// ---------------------------------------------------------------------------

/**
 * Parsed components of a SCIP symbol string.
 *
 * Format: `<scheme> <manager> <name> <version> <descriptors>`
 *
 * Example: `scip-typescript npm @types/node 18.0.0 path/posix/join().`
 */
export interface ParsedScipSymbol {
  scheme: string;
  manager: string;
  packageName: string;
  packageVersion: string;
  descriptors: string;
}

/**
 * Parse a SCIP symbol string into its constituent parts.
 *
 * SCIP symbol format: `<scheme> <manager> <name> <version> <descriptors>`
 *
 * The first four space-separated tokens are scheme, manager, name, version.
 * Everything after the fourth space is the descriptor path.
 *
 * Local symbols start with `local ` and have no package info.
 */
export function parseScipSymbol(scipSymbol: string): ParsedScipSymbol {
  const trimmed = scipSymbol.trim();

  // Local symbols: "local <id>"
  if (trimmed.startsWith("local ")) {
    return {
      scheme: "local",
      manager: "",
      packageName: "",
      packageVersion: "",
      descriptors: trimmed.slice(6), // everything after "local "
    };
  }

  // Standard format: scheme manager name version descriptors...
  // We need exactly 4 tokens for metadata, rest is descriptors
  let spaceCount = 0;
  let lastSpaceIdx = -1;
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] === " ") {
      spaceCount++;
      if (spaceCount === 4) {
        lastSpaceIdx = i;
        break;
      }
    }
  }

  if (spaceCount < 4) {
    // Malformed — return best-effort parse
    const parts = trimmed.split(" ");
    return {
      scheme: parts[0] ?? "",
      manager: parts[1] ?? "",
      packageName: parts[2] ?? "",
      packageVersion: parts[3] ?? "",
      descriptors: parts.slice(4).join(" "),
    };
  }

  const header = trimmed.slice(0, lastSpaceIdx);
  const descriptors = trimmed.slice(lastSpaceIdx + 1);

  const parts = header.split(" ");
  return {
    scheme: parts[0]!,
    manager: parts[1]!,
    packageName: parts[2]!,
    packageVersion: parts[3]!,
    descriptors,
  };
}

// ---------------------------------------------------------------------------
// Package info extraction
// ---------------------------------------------------------------------------

/**
 * Extract package manager, name, and version from a SCIP symbol string.
 */
export function extractPackageInfo(scipSymbol: string): {
  packageManager: string;
  packageName: string;
  packageVersion: string;
} {
  const parsed = parseScipSymbol(scipSymbol);
  return {
    packageManager: parsed.manager,
    packageName: parsed.packageName,
    packageVersion: parsed.packageVersion,
  };
}

// ---------------------------------------------------------------------------
// External symbol detection
// ---------------------------------------------------------------------------

/**
 * Returns `true` when the SCIP symbol refers to code outside the project.
 *
 * A symbol is external when:
 *  - Its scheme is NOT "local"
 *  - Its manager is non-empty (i.e., it belongs to a package registry)
 *
 * The `projectRoot` parameter is reserved for future use (e.g., checking
 * if a `file://` scheme symbol falls outside the root).
 */
export function isExternalSymbol(
  scipSymbol: string,
  _projectRoot: string,
): boolean {
  const parsed = parseScipSymbol(scipSymbol);

  // Local symbols are always internal
  if (parsed.scheme === "local") return false;

  // If there is a package manager and a package name, it is external
  if (parsed.manager !== "" && parsed.packageName !== "") return true;

  return false;
}

// ---------------------------------------------------------------------------
// Descriptor suffix analysis
// ---------------------------------------------------------------------------

/**
 * Descriptor suffix categories in SCIP symbol strings.
 *
 * The last character(s) of the descriptor path determine the symbol type:
 *   - `().`  → Term with parentheses (method/function)
 *   - `#`   → Type (class/interface/enum)
 *   - `.`   → Term without parentheses / Namespace (variable/namespace)
 *   - `(`   → Parameter (skip)
 *   - `[`   → TypeParameter (skip)
 *   - `)`   → Local (skip)
 *   - `!`   → Meta/Macro (skip)
 */
type DescriptorKind =
  | "termWithParens"
  | "type"
  | "termWithoutParens"
  | "namespace"
  | "parameter"
  | "typeParameter"
  | "local"
  | "meta"
  | "macro"
  | "unknown";

function classifyDescriptorSuffix(descriptors: string): DescriptorKind {
  if (descriptors.length === 0) return "unknown";

  // Check for "()." at the end — method/function
  if (descriptors.endsWith("().")) return "termWithParens";

  const lastChar = descriptors[descriptors.length - 1];

  switch (lastChar) {
    case "#":
      return "type";
    case ".":
      // Could be namespace or term-without-parens
      // If the part before the dot contains a `/`, treat as namespace
      // Otherwise treat as term (variable/constant)
      return classifyDotSuffix(descriptors);
    case "(":
      return "parameter";
    case "[":
      return "typeParameter";
    case ")":
      return "local";
    case "!":
      return "meta";
    default:
      return "unknown";
  }
}

/**
 * Disambiguate a `.` suffix between namespace and term-without-parens.
 *
 * A descriptor ending in `.` is a namespace if it is a path segment
 * (e.g., `src/foo.ts/`) or a term if it is a leaf identifier
 * (e.g., `src/foo.ts/MY_CONST.`).
 *
 * Heuristic: if the portion before the trailing `.` contains `/` or is
 * entirely composed of path-like segments, treat as namespace.
 * Otherwise treat as term-without-parens.
 */
function classifyDotSuffix(descriptors: string): DescriptorKind {
  // Remove trailing dot
  const withoutTrailingDot = descriptors.slice(0, -1);

  // If it ends with `/` before the dot, it's a namespace path
  if (withoutTrailingDot.endsWith("/")) return "namespace";

  // Check if the last segment (after the last `/` or `#`) looks like an identifier
  const lastSepIdx = Math.max(
    withoutTrailingDot.lastIndexOf("/"),
    withoutTrailingDot.lastIndexOf("#"),
  );

  if (lastSepIdx === -1) {
    // No separator — single descriptor, ambiguous
    // Default to term-without-parens (variable/constant)
    return "termWithoutParens";
  }

  // There is a separator, so the last segment is an identifier
  return "termWithoutParens";
}

/**
 * Extract the display name from the descriptor path.
 *
 * For `src/foo.ts/MyClass#myMethod().`, returns `myMethod`.
 * For `src/foo.ts/MyClass#`, returns `MyClass`.
 * For `src/foo.ts/MY_CONST.`, returns `MY_CONST`.
 */
export function extractNameFromDescriptors(descriptors: string): string {
  if (descriptors.length === 0) return "";

  // Strip trailing suffix characters: (). # . ( [ ) !
  let stripped = descriptors;

  // Remove trailing `().` for methods
  if (stripped.endsWith("().")) {
    stripped = stripped.slice(0, -3);
  } else {
    // Remove single trailing suffix char
    const last = stripped[stripped.length - 1];
    if (
      last === "#" ||
      last === "." ||
      last === "(" ||
      last === "[" ||
      last === ")" ||
      last === "!"
    ) {
      stripped = stripped.slice(0, -1);
    }
  }

  // Now find the last separator (/ or #)
  const lastSepIdx = Math.max(
    stripped.lastIndexOf("/"),
    stripped.lastIndexOf("#"),
  );

  if (lastSepIdx === -1) return stripped;

  return stripped.slice(lastSepIdx + 1);
}

// ---------------------------------------------------------------------------
// Main mapping function
// ---------------------------------------------------------------------------

/**
 * Map a SCIP symbol string + optional LSP SymbolKind to an SDL SymbolKind.
 *
 * The descriptor suffix is the primary signal; `kind` (LSP enum) is used
 * to disambiguate when the suffix alone is not enough (e.g., Type `#` can
 * be class, interface, or enum → type).
 *
 * Returns either `{ sdlKind, skip: false }` or `{ sdlKind: null, skip: true, reason }`.
 */
export function mapScipKind(scipSymbol: string, kind?: number): ScipKindResult {
  const parsed = parseScipSymbol(scipSymbol);

  // Local symbols (scheme "local") are always skipped regardless of descriptor suffix
  if (parsed.scheme === "local") {
    return { sdlKind: null, skip: true, reason: "local" };
  }

  const descriptorKind = classifyDescriptorSuffix(parsed.descriptors);

  switch (descriptorKind) {
    case "termWithParens": {
      // Method or function — check for constructor names
      const name = extractNameFromDescriptors(parsed.descriptors);

      if (kind === LSP_KIND.Constructor || CONSTRUCTOR_NAMES.has(name)) {
        return { sdlKind: "constructor", skip: false };
      }

      // Use LSP kind to decide function vs method
      if (kind === LSP_KIND.Method) {
        return { sdlKind: "method", skip: false };
      }
      if (kind === LSP_KIND.Function) {
        return { sdlKind: "function", skip: false };
      }

      // Fallback: if the descriptor path contains a `#` before the method,
      // it's likely a class member → method. Otherwise → function.
      const beforeMethod = parsed.descriptors.slice(
        0,
        parsed.descriptors.length - name.length - 3, // "name()."
      );
      if (beforeMethod.includes("#")) {
        return { sdlKind: "method", skip: false };
      }

      return { sdlKind: "function", skip: false };
    }

    case "type": {
      // Disambiguate via LSP SymbolKind
      if (kind === LSP_KIND.Class || kind === LSP_KIND.Struct) {
        return { sdlKind: "class", skip: false };
      }
      if (kind === LSP_KIND.Interface) {
        return { sdlKind: "interface", skip: false };
      }
      if (kind === LSP_KIND.Enum) {
        return { sdlKind: "type", skip: false };
      }

      // Without LSP kind, default to class (most common for Type descriptor)
      if (kind === undefined || kind === LSP_KIND.UnspecifiedSymbolKind) {
        return { sdlKind: "class", skip: false };
      }

      // Other LSP kinds mapped to type descriptor — treat as type alias
      return { sdlKind: "type", skip: false };
    }

    case "termWithoutParens": {
      // Variable or constant
      if (kind === LSP_KIND.Function) {
        // Some indexers emit arrow functions / function expressions as
        // terms without parens but with Function LSP kind
        return { sdlKind: "function", skip: false };
      }
      return { sdlKind: "variable", skip: false };
    }

    case "namespace": {
      return { sdlKind: "module", skip: false };
    }

    case "parameter":
      return { sdlKind: null, skip: true, reason: "parameter" };

    case "typeParameter":
      return { sdlKind: null, skip: true, reason: "typeParameter" };

    case "local":
      return { sdlKind: null, skip: true, reason: "local" };

    case "meta":
    case "macro":
      return { sdlKind: null, skip: true, reason: descriptorKind };

    case "unknown":
      return { sdlKind: null, skip: true, reason: "unknown descriptor suffix" };
  }
}
