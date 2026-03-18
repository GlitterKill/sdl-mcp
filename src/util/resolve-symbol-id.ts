/**
 * resolve-symbol-id.ts — Resolves symbolId shorthands to full SHA-256 hashes.
 *
 * Supports two formats:
 *   1. Full hash:      64-char hex string (passthrough)
 *   2. File shorthand:  "relPath::symbolName" (resolved via DB lookup)
 */
import type { Connection } from "kuzu";

import { resolveSymbolByShorthand } from "../db/ladybug-symbols.js";
import { getOverlaySnapshot } from "../live-index/overlay-reader.js";
import { NotFoundError } from "../mcp/errors.js";

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const SHORTHAND_RE = /^(.+)::([^:]+)$/;

export interface ResolvedSymbolId {
  symbolId: string;
  wasShorthand: boolean;
}

/**
 * Resolve a symbolId input that may be a full hash or a `file::name` shorthand.
 * Throws NotFoundError if shorthand format is used but no match is found.
 */
export async function resolveSymbolId(
  conn: Connection,
  repoId: string,
  input: string,
): Promise<ResolvedSymbolId> {
  // Case 1: Already a full SHA-256 hash
  if (SHA256_HEX_RE.test(input)) {
    return { symbolId: input, wasShorthand: false };
  }

  // Case 2: file::name shorthand
  const match = SHORTHAND_RE.exec(input);
  if (match) {
    const [, relPath, symbolName] = match;

    // Try durable DB first
    const resolved = await resolveSymbolByShorthand(conn, repoId, relPath!, symbolName!);
    if (resolved) {
      return { symbolId: resolved, wasShorthand: true };
    }

    // Try overlay (in-memory symbols from recently changed files)
    const overlayResult = resolveShorthandFromOverlay(repoId, relPath!, symbolName!);
    if (overlayResult) {
      return { symbolId: overlayResult, wasShorthand: true };
    }

    throw new NotFoundError(
      `No symbol "${symbolName}" found in file matching "${relPath}" for repo "${repoId}". ` +
        `Try sdl.symbol.search to find the correct symbol.`,
    );
  }

  // Case 3: Not a hash and not a shorthand — pass through as-is
  return { symbolId: input, wasShorthand: false };
}

/**
 * Check the live overlay for a matching symbol by file path suffix and name.
 */
function resolveShorthandFromOverlay(
  repoId: string,
  relPath: string,
  symbolName: string,
): string | null {
  let snapshot;
  try {
    snapshot = getOverlaySnapshot(repoId);
  } catch {
    return null;
  }
  if (!snapshot) return null;

  const normalizedPath = relPath.replace(/\\/g, "/");

  for (const symbol of snapshot.symbolsById.values()) {
    if (symbol.repoId !== repoId) continue;
    if (symbol.name !== symbolName) continue;

    const file = snapshot.filesById.get(symbol.fileId);
    if (!file) continue;

    const fileRelPath = file.relPath.replace(/\\/g, "/");
    if (fileRelPath.endsWith(normalizedPath)) {
      return symbol.symbolId;
    }
  }

  return null;
}
