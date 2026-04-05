/**
 * Create external symbol nodes from SCIP external symbol info.
 *
 * External symbols represent dependencies on code outside the repository
 * (e.g., npm packages, Go modules, Maven artifacts). They are stored as
 * synthetic Symbol nodes with a special `ext://` relPath convention.
 */

import { createHash } from "node:crypto";
import type { SymbolKind } from "../domain/types.js";
import {
  mapScipKind,
  extractPackageInfo,
  parseScipSymbol,
  extractNameFromDescriptors,
} from "./kind-mapping.js";
import type { ScipExternalSymbol } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Row-shaped object ready for insertion into the Symbol graph node table.
 */
export interface ExternalSymbolRow {
  symbolId: string;
  repoId: string;
  /** Synthetic path: `ext://<scheme>/<manager>/<package>/<version>/<descriptorPath>` */
  relPath: string;
  kind: SymbolKind;
  name: string;
  external: true;
  source: "scip";
  scipSymbol: string;
  packageName: string;
  packageVersion: string;
  exported: true;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a stable symbolId for an external SCIP symbol.
 *
 * Formula: `sha256(repoId + ":ext:" + scipSymbol)`
 *
 * This ensures the same external symbol always gets the same ID within
 * a repository, regardless of re-ingestion order.
 */
function generateExternalSymbolId(repoId: string, scipSymbol: string): string {
  return createHash("sha256")
    .update(`${repoId}:ext:${scipSymbol}`)
    .digest("hex");
}

/**
 * Build a synthetic relPath for an external symbol.
 *
 * Format: `ext://<scheme>/<manager>/<package>/<version>/<descriptorPath>`
 *
 * The descriptor path has suffix characters (`.`, `#`, `().`) stripped
 * and separators normalized to `/`.
 */
function buildExternalRelPath(
  scheme: string,
  manager: string,
  packageName: string,
  packageVersion: string,
  descriptors: string,
): string {
  // Normalize descriptors: strip trailing suffix chars, normalize separators
  let normalized = descriptors;

  // Strip trailing method/type/term suffixes
  if (normalized.endsWith("().")) {
    normalized = normalized.slice(0, -3);
  } else if (normalized.length > 0) {
    const last = normalized[normalized.length - 1];
    if (
      last === "#" ||
      last === "." ||
      last === "(" ||
      last === "[" ||
      last === ")" ||
      last === "!"
    ) {
      normalized = normalized.slice(0, -1);
    }
  }

  // Replace `#` separators with `/` for path uniformity
  normalized = normalized.replace(/#/g, "/");

  // Collapse consecutive slashes
  normalized = normalized.replace(/\/+/g, "/");

  // Remove trailing slash
  if (normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }

  return `ext://${scheme}/${manager}/${packageName}/${packageVersion}/${normalized}`;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Create an ExternalSymbolRow from a SCIP external symbol.
 *
 * Returns `null` if the symbol's kind cannot be mapped to an SDL kind
 * (e.g., type parameters, local variables).
 *
 * @param scipSymbol  The SCIP symbol string
 * @param scipInfo    The SCIP external symbol info (documentation, kind, etc.)
 * @param repoId     The repository ID this symbol is referenced from
 */
export function createExternalSymbol(
  scipSymbol: string,
  scipInfo: ScipExternalSymbol,
  repoId: string,
): ExternalSymbolRow | null {
  // Map to SDL kind
  const kindResult = mapScipKind(scipSymbol, scipInfo.kind);

  if (kindResult.skip) return null;

  // Parse symbol for package info and descriptors
  const parsed = parseScipSymbol(scipSymbol);
  const pkgInfo = extractPackageInfo(scipSymbol);

  // Extract display name
  const name =
    scipInfo.displayName || extractNameFromDescriptors(parsed.descriptors);

  if (name === "") return null;

  // Build synthetic relPath
  const relPath = buildExternalRelPath(
    parsed.scheme,
    parsed.manager,
    pkgInfo.packageName,
    pkgInfo.packageVersion,
    parsed.descriptors,
  );

  // Generate stable symbolId
  const symbolId = generateExternalSymbolId(repoId, scipSymbol);

  return {
    symbolId,
    repoId,
    relPath,
    kind: kindResult.sdlKind,
    name,
    external: true,
    source: "scip",
    scipSymbol,
    packageName: pkgInfo.packageName,
    packageVersion: pkgInfo.packageVersion,
    exported: true,
  };
}
