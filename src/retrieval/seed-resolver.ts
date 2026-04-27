/**
 * Seed resolver for chat-aware Personalized PageRank.
 *
 * Maps caller-supplied `chatMentions` strings (full symbol IDs, short ID
 * prefixes, or bare names) to canonical symbol IDs that anchor the PPR walk.
 *
 * Resolution rules (in priority order):
 *   1. Full symbolId (64-char hex)  → accepted as-is after existence check.
 *   2. shortId prefix (16-63 hex)   → expanded via `STARTS WITH` lookup.
 *   3. Bare name                    → top hybrid-search hit.
 *
 * Unresolved mentions are dropped silently and surfaced in `evidence` so
 * callers can debug why a seed had no effect.
 *
 * @module retrieval/seed-resolver
 */

import type { Connection } from "kuzu";
import { queryAll } from "../db/ladybug-core.js";
import { logger } from "../util/logger.js";
import { extractIdentifiersFromText } from "../agent/identifier-extraction.js";

/** Cap on auto-extracted mentions; conservative vs. the schema's 20-mention max. */
export const AUTO_EXTRACT_LIMIT = 8;

/**
 * Extract candidate PPR seeds from free-form text (a query or task prompt).
 *
 * Used when the caller does not pass `chatMentions` explicitly. Empty result
 * (or empty input) means PPR will skip — same effect as caller passing `[]`.
 */
export function autoExtractMentions(text: string | undefined | null): string[] {
  if (!text || text.trim().length === 0) return [];
  return extractIdentifiersFromText(text, text).slice(0, AUTO_EXTRACT_LIMIT);
}

/** Public output shape returned alongside the seeds map. */
export interface SeedResolverEvidence {
  /** symbolIds that were successfully resolved (one per accepted mention). */
  resolved: string[];
  /** Mention strings that could not be resolved to any symbol. */
  unresolved: string[];
  /** Bare-name mentions where top-1 / top-2 score ratio was < 1.5. */
  ambiguous: string[];
}

export interface SeedResolverResult {
  /** symbolId -> normalized seed weight (sums to 1 across all seeds). */
  seeds: Map<string, number>;
  evidence: SeedResolverEvidence;
}

const FULL_ID_LENGTH = 64;
const MIN_SHORT_ID_LENGTH = 16;
const HEX_RE = /^[0-9a-f]+$/i;
const AMBIGUITY_RATIO = 1.5;

interface RawSeed {
  /** symbolId once resolved, otherwise null. */
  symbolId: string | null;
  /** raw weight from caller (un-normalized). */
  weight: number;
  /** original mention string (for evidence). */
  mention: string;
  /** classification result. */
  kind: "fullId" | "shortId" | "name";
  /** flag set when bare-name resolution was ambiguous. */
  ambiguous: boolean;
}

function classify(mention: string): RawSeed["kind"] {
  if (mention.length === FULL_ID_LENGTH && HEX_RE.test(mention)) {
    return "fullId";
  }
  if (
    mention.length >= MIN_SHORT_ID_LENGTH &&
    mention.length < FULL_ID_LENGTH &&
    HEX_RE.test(mention)
  ) {
    return "shortId";
  }
  return "name";
}

interface IdRow {
  symbolId: string;
}

async function existsFullId(
  conn: Connection,
  repoId: string,
  symbolId: string,
): Promise<boolean> {
  try {
    const rows = await queryAll<IdRow>(
      conn,
      `MATCH (s:Symbol)
       WHERE s.symbolId = $symbolId AND s.repoId = $repoId
       RETURN s.symbolId AS symbolId
       LIMIT 1`,
      { symbolId, repoId },
    );
    return rows.length > 0;
  } catch (err) {
    logger.debug(
      `[seed-resolver] full-id lookup failed for ${symbolId.slice(0, 16)}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}

async function expandShortId(
  conn: Connection,
  repoId: string,
  prefix: string,
): Promise<string | null> {
  try {
    const rows = await queryAll<IdRow>(
      conn,
      `MATCH (s:Symbol)
       WHERE s.repoId = $repoId AND s.symbolId STARTS WITH $prefix
       RETURN s.symbolId AS symbolId
       LIMIT 2`,
      { repoId, prefix },
    );
    if (rows.length === 0) return null;
    if (rows.length > 1) {
      logger.debug(
        `[seed-resolver] short-id prefix '${prefix}' is ambiguous; dropping`,
      );
      return null;
    }
    return rows[0].symbolId;
  } catch (err) {
    logger.debug(
      `[seed-resolver] short-id expansion failed for ${prefix}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

interface NameRow {
  symbolId: string;
  score: number;
}

async function resolveBareName(
  conn: Connection,
  repoId: string,
  name: string,
): Promise<{ symbolId: string | null; ambiguous: boolean }> {
  // Direct lexical search via the durable Symbol FTS index. Avoids re-entering
  // the hybrid orchestrator (which would itself try to resolve seeds and risk
  // recursion). Top-2 are inspected to detect ambiguity.
  try {
    const rows = await queryAll<NameRow>(
      conn,
      `MATCH (s:Symbol)
       WHERE s.repoId = $repoId AND s.name = $name
       RETURN s.symbolId AS symbolId, 1.0 AS score
       LIMIT 2`,
      { repoId, name },
    );
    if (rows.length === 0) {
      // Fall back to prefix match for camelCase / partial name input.
      const prefixRows = await queryAll<NameRow>(
        conn,
        `MATCH (s:Symbol)
         WHERE s.repoId = $repoId AND s.name STARTS WITH $name
         RETURN s.symbolId AS symbolId, 1.0 AS score
         LIMIT 2`,
        { repoId, name },
      );
      if (prefixRows.length === 0) {
        return { symbolId: null, ambiguous: false };
      }
      const ambiguous =
        prefixRows.length > 1 &&
        prefixRows[0].score / Math.max(prefixRows[1].score, 1e-9) <
          AMBIGUITY_RATIO;
      return { symbolId: prefixRows[0].symbolId, ambiguous };
    }
    const ambiguous =
      rows.length > 1 &&
      rows[0].score / Math.max(rows[1].score, 1e-9) < AMBIGUITY_RATIO;
    return { symbolId: rows[0].symbolId, ambiguous };
  } catch (err) {
    logger.debug(
      `[seed-resolver] bare-name lookup failed for '${name}': ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return { symbolId: null, ambiguous: false };
  }
}

/**
 * Resolve caller mentions to a canonical seed map for Personalized PageRank.
 *
 * Output weights are normalized so the seed vector sums to 1.0. Empty /
 * all-unresolved input returns an empty seeds map and evidence describing
 * what was dropped.
 */
export async function resolveSeedSymbols(
  conn: Connection,
  repoId: string,
  mentions: readonly string[],
  weights?: Readonly<Record<string, number>>,
): Promise<SeedResolverResult> {
  const evidence: SeedResolverEvidence = {
    resolved: [],
    unresolved: [],
    ambiguous: [],
  };

  if (mentions.length === 0) {
    return { seeds: new Map(), evidence };
  }

  // De-dup mentions while preserving first-seen weight assignment.
  const seenMentions = new Set<string>();
  const unique: string[] = [];
  for (const m of mentions) {
    const trimmed = m.trim();
    if (trimmed.length === 0) continue;
    if (seenMentions.has(trimmed)) continue;
    seenMentions.add(trimmed);
    unique.push(trimmed);
  }

  const raw: RawSeed[] = [];
  for (const mention of unique) {
    const kind = classify(mention);
    const weight = weights?.[mention] ?? 1.0;
    let symbolId: string | null = null;
    let ambiguous = false;

    if (kind === "fullId") {
      symbolId = (await existsFullId(conn, repoId, mention)) ? mention : null;
    } else if (kind === "shortId") {
      symbolId = await expandShortId(conn, repoId, mention);
    } else {
      const result = await resolveBareName(conn, repoId, mention);
      symbolId = result.symbolId;
      ambiguous = result.ambiguous;
    }

    raw.push({ symbolId, weight, mention, kind, ambiguous });
  }

  // Collapse to a per-symbol map (last-write-wins on dup symbolIds, but with
  // accumulated weight so multiple aliases of the same symbol stack).
  const accumulated = new Map<string, number>();
  for (const seed of raw) {
    if (seed.symbolId === null) {
      evidence.unresolved.push(seed.mention);
      continue;
    }
    if (seed.ambiguous) {
      evidence.ambiguous.push(seed.mention);
    }
    accumulated.set(
      seed.symbolId,
      (accumulated.get(seed.symbolId) ?? 0) + Math.max(seed.weight, 0),
    );
  }

  // Normalize: sum-to-1 across resolved seeds.
  let totalWeight = 0;
  for (const w of accumulated.values()) totalWeight += w;

  const seeds = new Map<string, number>();
  if (totalWeight > 0) {
    for (const [id, w] of accumulated) {
      seeds.set(id, w / totalWeight);
      evidence.resolved.push(id);
    }
  } else {
    // Defensive: if every weight is zero, drop everything.
    for (const id of accumulated.keys()) {
      evidence.unresolved.push(id);
    }
  }

  return { seeds, evidence };
}
