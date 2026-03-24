/**
 * NN-based summary transfer: uses ANN index + embedding provider to find
 * structurally similar symbols and transfer/adapt their summaries to
 * symbols that lack good summaries.
 */

import type { LadybugConn } from "./indexer-init.js";

import { logger } from "../util/logger.js";
import type { IndexProgress } from "./indexer.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import { getAnnIndexManager } from "./ann-index.js";
import {
  buildRawEmbeddingText,
  cosineSimilarity,
  type EmbeddingProvider,
} from "./embeddings.js";
import { splitCamelCase, isNameOnlySummary } from "./summaries.js";

export interface SummaryTransferResult {
  transferred: number;
  directTransfers: number;
  adaptedTransfers: number;
  skipped: number;
  noNeighbor: number;
  rejected: number;
}

export interface SummaryTransferOptions {
  repoId: string;
  conn: LadybugConn;
  embeddingProvider: EmbeddingProvider;
  minSimilarity?: number;            // default 0.7
  maxNeighbors?: number;             // default 5
  directTransferThreshold?: number;  // default 0.85
  batchSize?: number;                // default 20
}

/**
 * Transfer summaries from high-quality neighbor symbols to candidates
 * that have no summary, a low-quality summary, or a name-only summary.
 *
 * Uses the ANN index to find structurally similar symbols, then either
 * directly transfers the donor summary (high similarity) or adapts it
 * to the target symbol's name/kind (moderate similarity).
 */
export async function transferSummariesFromNeighbors(
  options: SummaryTransferOptions,
  onProgress?: (progress: IndexProgress) => void,
): Promise<SummaryTransferResult> {
  const {
    repoId,
    conn,
    embeddingProvider,
    minSimilarity = 0.7,
    maxNeighbors = 5,
    directTransferThreshold = 0.85,
    batchSize = 20,
  } = options;

  const result: SummaryTransferResult = {
    transferred: 0,
    directTransfers: 0,
    adaptedTransfers: 0,
    skipped: 0,
    noNeighbor: 0,
    rejected: 0,
  };

  // Gate: ANN index must be ready
  const annManager = getAnnIndexManager();
  if (annManager.getStatus() !== "ready") {
    logger.debug("summary-transfer: ANN index not ready, skipping NN transfer");
    return result;
  }

  // Gather candidates: null/low-quality summaries
  const allSymbols = await ladybugDb.getSymbolsByRepo(conn, repoId);
  const candidates = allSymbols.filter(
    (s) =>
      !s.summary ||
      (s.summaryQuality !== undefined && s.summaryQuality < 0.5) ||
      isNameOnlySummary(s.summary, s.name),
  );

  if (candidates.length === 0) {
    logger.debug("summary-transfer: no candidates found");
    return result;
  }

  logger.info(
    `summary-transfer: ${candidates.length} candidates for NN transfer`,
  );
  const total = candidates.length;

  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize);
    const texts = batch.map((s) => buildRawEmbeddingText(s));

    let embeddings: number[][];
    try {
      embeddings = await embeddingProvider.embed(texts);
    } catch (err) {
      logger.warn("summary-transfer: embedding failed for batch, skipping", {
        error: err,
      });
      result.rejected += batch.length;
      continue;
    }

    for (let j = 0; j < batch.length; j++) {
      const candidate = batch[j];
      const candidateEmbedding = embeddings[j];

      try {
        // Search ANN index for nearest neighbors
        const neighbors = annManager.search(candidateEmbedding, maxNeighbors);

        let bestNeighbor: {
          symbolId: string;
          score: number;
          summary: string;
        } | null = null;

        for (const neighbor of neighbors) {
          if (neighbor.score < minSimilarity) continue;
          if (neighbor.symbolId === candidate.symbolId) continue;

          const neighborSymbol = await ladybugDb.getSymbol(
            conn,
            neighbor.symbolId,
          );
          if (!neighborSymbol) continue;
          if (!neighborSymbol.summary) continue;
          if (neighborSymbol.kind !== candidate.kind) continue;
          if (isNameOnlySummary(neighborSymbol.summary, neighborSymbol.name))
            continue;

          if (!bestNeighbor || neighbor.score > bestNeighbor.score) {
            bestNeighbor = {
              symbolId: neighbor.symbolId,
              score: neighbor.score,
              summary: neighborSymbol.summary,
            };
          }
        }

        if (!bestNeighbor) {
          result.noNeighbor++;
          continue;
        }

        let transferredSummary: string;
        let quality: number;
        let source: string;

        if (bestNeighbor.score >= directTransferThreshold) {
          // High similarity: transfer summary directly
          transferredSummary = bestNeighbor.summary;
          quality = 0.6;
          source = `nn-direct:${bestNeighbor.symbolId}`;
          result.directTransfers++;
        } else {
          // Moderate similarity: adapt the summary to the target
          transferredSummary = adaptSummary(
            bestNeighbor.summary,
            candidate.name,
            candidate.kind,
          );
          quality = 0.5;
          source = `nn-adapted:${bestNeighbor.symbolId}`;
          result.adaptedTransfers++;
        }

        // Quality validation: ensure the transferred summary is semantically
        // relevant to the candidate by checking embedding similarity
        try {
          const [summaryEmbedding] = await embeddingProvider.embed([
            transferredSummary,
          ]);
          const sim = cosineSimilarity(candidateEmbedding, summaryEmbedding);
          if (sim < 0.5) {
            result.rejected++;
            continue;
          }
        } catch {
          // Accept transfer even if validation embedding fails
        }

        await ladybugDb.updateSymbolSummary(
          conn,
          candidate.symbolId,
          transferredSummary,
          quality,
          source,
        );
        result.transferred++;
      } catch (err) {
        logger.debug("summary-transfer: error processing candidate", {
          symbolId: candidate.symbolId,
          error: err,
        });
        result.rejected++;
      }
    }

    if (onProgress) {
      onProgress({
        stage: "summary-transfer",
        current: Math.min(i + batchSize, total),
        total,
      });
    }
  }

  logger.info(
    `summary-transfer: ${result.transferred} transferred ` +
      `(${result.directTransfers} direct, ${result.adaptedTransfers} adapted), ` +
      `${result.noNeighbor} no neighbor, ${result.rejected} rejected`,
  );
  return result;
}

/**
 * Adapt a donor summary to fit a target symbol by replacing the object
 * of the first verb with the target symbol's name components.
 */
function adaptSummary(
  donorSummary: string,
  targetName: string,
  targetKind: string,
): string {
  const words = donorSummary.split(/\s+/);
  if (words.length === 0) return donorSummary;
  const verb = words[0];

  if (targetKind === "function" || targetKind === "method") {
    const targetWords = splitCamelCase(targetName);
    const targetObject = targetWords.slice(1).join(" ").toLowerCase();
    if (targetObject) return `${verb} ${targetObject}`;
    return `${verb} ${targetWords.join(" ").toLowerCase()}`;
  }

  if (targetKind === "class") {
    if (donorSummary.startsWith("Implements the")) {
      const patternMatch = donorSummary.match(
        /Implements the (\w+) pattern for/,
      );
      if (patternMatch) {
        const targetBase = splitCamelCase(targetName).join(" ").toLowerCase();
        return `Implements the ${patternMatch[1]} pattern for ${targetBase}`;
      }
    }
  }

  const targetContext = splitCamelCase(targetName).join(" ").toLowerCase();
  if (words.length > 1) return `${verb} ${targetContext}`;
  return donorSummary;
}
