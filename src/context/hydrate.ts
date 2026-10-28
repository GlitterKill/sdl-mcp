import type { Connection } from "kuzu";

import { loadSourceMetadata } from "../code/source-metadata.js";
import {
  createHotPathSourceMatcher,
  extractHotPath,
  prepareHotPath,
  renderPreparedHotPath,
  type PreparedHotPath,
} from "../code/hotpath.js";
import {
  generateSymbolSkeleton,
  parseFile,
  prepareSymbolSkeleton,
  renderPreparedSymbolSkeleton,
  type PreparedSymbolSkeleton,
} from "../code/skeleton.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import type { SymbolCard } from "../domain/types.js";
import { loadSymbolCards } from "../graph/slice/card-hydrator.js";
import { normalizeEdgeConfidence } from "../graph/slice/beam-search-engine.js";
import {
  getOverlaySymbol,
  mergeEdgeMapWithOverlay,
  type OverlaySnapshot,
} from "../live-index/overlay-reader.js";
import {
  CONTEXT_RUNG_TOKEN_LIMITS,
  logicalActionForRung,
} from "./select.js";
import { projectCardContent } from "./card-content.js";
import type {
  ContextEdge,
  ContextEvidence,
  ContextRung,
  OmittedContextItem,
  SelectedContextBundle,
} from "./types.js";

export interface HydrateContextBundlesInput {
  conn: Connection;
  repoId: string;
  versionId: string;
  selected: SelectedContextBundle[];
  identifiers: string[];
  overlaySnapshot: OverlaySnapshot;
  prepared?: PreparedContextHydrationPlan;
}

export interface HydrateContextBundlesResult {
  evidence: ContextEvidence[];
  edges: ContextEdge[];
  unavailable: OmittedContextItem[];
}

export interface HydrateContextBundlesDependencies {
  loadCards: typeof loadSymbolCards;
  loadEdges: typeof ladybugDb.getEdgesFromSymbolsForSlice;
  loadSkeleton: typeof generateSymbolSkeleton;
  loadHotPath: typeof extractHotPath;
  renderSkeleton: typeof renderPreparedSymbolSkeleton;
  renderHotPath: typeof renderPreparedHotPath;
}

export interface PrepareContextHydrationPlanDependencies {
  loadCards: typeof loadSymbolCards;
  loadEdges: typeof ladybugDb.getEdgesFromSymbolsForSlice;
  prepareSkeleton: typeof prepareSymbolSkeleton;
  prepareHotPath: typeof prepareHotPath;
}

export interface PreparedContextHydrationPlan {
  readonly selected: readonly SelectedContextBundle[];
  readonly cards: readonly SymbolCard[];
  readonly durableEdges: Awaited<
    ReturnType<typeof ladybugDb.getEdgesFromSymbolsForSlice>
  >;
  readonly skeletons: ReadonlyMap<string, PreparedSymbolSkeleton | null>;
  readonly hotPaths: ReadonlyMap<string, PreparedHotPath | null>;
  readonly overlaySnapshot: OverlaySnapshot;
}

const DEFAULT_DEPENDENCIES: HydrateContextBundlesDependencies = {
  loadCards: loadSymbolCards,
  loadEdges: ladybugDb.getEdgesFromSymbolsForSlice,
  loadSkeleton: generateSymbolSkeleton,
  loadHotPath: extractHotPath,
  renderSkeleton: renderPreparedSymbolSkeleton,
  renderHotPath: renderPreparedHotPath,
};

const DEFAULT_PREPARE_DEPENDENCIES: PrepareContextHydrationPlanDependencies = {
  loadCards: loadSymbolCards,
  loadEdges: ladybugDb.getEdgesFromSymbolsForSlice,
  prepareSkeleton: prepareSymbolSkeleton,
  prepareHotPath,
};

function unavailable(
  bundle: SelectedContextBundle,
  rung: ContextRung,
  identifiersToFind: readonly string[],
): OmittedContextItem {
  return {
    symbolId: bundle.candidate.symbolId,
    path: bundle.candidate.path,
    rung,
    rank: bundle.candidate.rank,
    tier: bundle.candidate.tier,
    reason: "unavailable",
    action: logicalActionForRung(
      rung,
      bundle.candidate.symbolId,
      identifiersToFind,
    ),
  };
}

/** Capture all durable hydration inputs while the request snapshot is active. */
export async function prepareContextHydrationPlan(
  {
    conn,
    repoId,
    versionId,
    selected,
    overlaySnapshot,
  }: Omit<HydrateContextBundlesInput, "identifiers" | "prepared">,
  dependencies: Partial<PrepareContextHydrationPlanDependencies> = {},
): Promise<PreparedContextHydrationPlan> {
  const { loadCards, loadEdges, prepareSkeleton, prepareHotPath: prepareHot } = {
    ...DEFAULT_PREPARE_DEPENDENCIES,
    ...dependencies,
  };
  const cardIds = selected
    .filter((bundle) => bundle.rungs.includes("card"))
    .map((bundle) => bundle.candidate.symbolId);
  const { cards } = await loadCards(
    conn,
    cardIds,
    versionId,
    repoId,
    "signature",
    undefined,
    false,
    overlaySnapshot,
  );
  const selectedIds = [
    ...new Set(selected.map((bundle) => bundle.candidate.symbolId)),
  ];
  const durableEdges = await loadEdges(conn, selectedIds);
  const skeletons = new Map<string, PreparedSymbolSkeleton | null>();
  const hotPaths = new Map<string, PreparedHotPath | null>();
  const sourceMetadata = await loadSourceMetadata(
    conn,
    repoId,
    selected
      .filter((bundle) => bundle.rungs.some((rung) => rung !== "card"))
      .filter(({ candidate, rungs }) => {
        const overlay = getOverlaySymbol(overlaySnapshot, candidate.symbolId);
        if (!overlay) return true;
        // Hot paths never fall back to durable bytes for a captured draft.
        // Skeletons retain their existing missing-content fallback.
        return rungs.includes("skeleton") && (
          overlay.symbol.repoId !== repoId ||
          !overlaySnapshot.contentByFileId?.has(overlay.file.fileId)
        );
      })
      .map((bundle) => bundle.candidate.symbolId),
  );
  for (const bundle of selected) {
    const symbolId = bundle.candidate.symbolId;
    if (bundle.rungs.includes("skeleton") && !skeletons.has(symbolId)) {
      skeletons.set(
        symbolId,
        await prepareSkeleton(
          conn, repoId, symbolId, overlaySnapshot, true,
          sourceMetadata.get(symbolId),
        ),
      );
    }
    if (bundle.rungs.includes("hotPath") && !hotPaths.has(symbolId)) {
      hotPaths.set(
        symbolId,
        await prepareHot(
          conn, repoId, symbolId, overlaySnapshot, true,
          sourceMetadata.get(symbolId),
        ),
      );
    }
  }
  return Object.freeze({
    selected: Object.freeze([...selected]),
    cards: Object.freeze([...cards]),
    durableEdges,
    skeletons,
    hotPaths,
    overlaySnapshot,
  });
}

export async function hydrateContextBundles({
  conn,
  repoId,
  versionId,
  selected,
  identifiers,
  overlaySnapshot,
  prepared,
}: HydrateContextBundlesInput,
dependencies: Partial<HydrateContextBundlesDependencies> = {},
): Promise<HydrateContextBundlesResult> {
  const {
    loadCards,
    loadEdges,
    loadSkeleton,
    loadHotPath,
    renderSkeleton,
    renderHotPath,
  } = {
    ...DEFAULT_DEPENDENCIES,
    ...dependencies,
  };
  const effectiveSelected = prepared ? [...prepared.selected] : selected;
  const cards = prepared
    ? [...prepared.cards]
    : (
        await loadCards(
          conn,
          effectiveSelected
            .filter((bundle) => bundle.rungs.includes("card"))
            .map((bundle) => bundle.candidate.symbolId),
          versionId,
          repoId,
          "signature",
          undefined,
          false,
          overlaySnapshot,
        )
      ).cards;
  const cardsById = new Map(cards.map((card) => [card.symbolId, card]));
  const evidence: ContextEvidence[] = [];
  const unavailableItems: OmittedContextItem[] = [];
  const matchSource = createHotPathSourceMatcher();
  // Reuse immutable syntax trees only for identical source bytes and grammar
  // within this request. Renderers still validate durable source hashes first.
  const parsedSources = new Map<string, Map<string, ReturnType<typeof parseFile>>>();
  const parseSource: typeof parseFile = (content, extension) => {
    let byContent = parsedSources.get(extension);
    if (!byContent) {
      byContent = new Map();
      parsedSources.set(extension, byContent);
    }
    if (!byContent.has(content)) {
      byContent.set(content, parseFile(content, extension));
    }
    return byContent.get(content) ?? null;
  };

  for (const bundle of effectiveSelected) {
    for (const rung of bundle.rungs) {
      let content: unknown = null;
      if (rung === "card") {
        const card = cardsById.get(bundle.candidate.symbolId);
        content = card ? projectCardContent(card) : null;
      } else if (rung === "skeleton") {
        const options = {
          maxLines: 100,
          maxTokens: CONTEXT_RUNG_TOKEN_LIMITS.skeleton,
        };
        const captured = prepared?.skeletons.get(
          bundle.candidate.symbolId,
        );
        content = prepared
          ? captured
            ? await renderSkeleton(captured, options, parseSource)
            : null
          : await loadSkeleton(repoId, bundle.candidate.symbolId, options);
      } else {
        const options = {
          maxLines: 80,
          maxTokens: CONTEXT_RUNG_TOKEN_LIMITS.hotPath,
        };
        const captured = prepared?.hotPaths.get(bundle.candidate.symbolId);
        content = prepared
          ? captured
            ? await renderHotPath(
                captured, identifiers, options, parseSource, matchSource,
              )
            : null
          : await loadHotPath(
              repoId,
              bundle.candidate.symbolId,
              identifiers,
              options,
            );
      }

      if (content === null) {
        unavailableItems.push(
          unavailable(bundle, rung, identifiers),
        );
        continue;
      }
      evidence.push({
        rung,
        symbolId: bundle.candidate.symbolId,
        path: bundle.candidate.path,
        rank: bundle.candidate.rank,
        tier: bundle.candidate.tier,
        lanes: bundle.candidate.lanes,
        content,
      });
    }
  }

  const selectedIds = [
    ...new Set(evidence.map((item) => item.symbolId)),
  ];
  const selectedSet = new Set(selectedIds);
  const durableEdges = prepared
    ? prepared.durableEdges
    : await loadEdges(conn, selectedIds);
  const edgeMap = mergeEdgeMapWithOverlay(
    prepared?.overlaySnapshot ?? overlaySnapshot,
    selectedIds,
    durableEdges,
  );
  const bestEdges = new Map<string, ContextEdge>();

  for (const outgoing of edgeMap.values()) {
    for (const edge of outgoing) {
      if (
        !selectedSet.has(edge.fromSymbolId) ||
        !selectedSet.has(edge.toSymbolId)
      ) {
        continue;
      }
      const projected: ContextEdge = {
        from: edge.fromSymbolId,
        to: edge.toSymbolId,
        kind: edge.edgeType,
        confidencePermille: Math.round(
          normalizeEdgeConfidence(edge.confidence) * 1_000,
        ),
      };
      const key = `${projected.from}\0${projected.to}\0${projected.kind}`;
      const existing = bestEdges.get(key);
      if (
        !existing ||
        projected.confidencePermille > existing.confidencePermille
      ) {
        bestEdges.set(key, projected);
      }
    }
  }

  return {
    evidence,
    edges: [...bestEdges.values()].sort(
      (left, right) =>
        left.from.localeCompare(right.from) ||
        left.to.localeCompare(right.to) ||
        left.kind.localeCompare(right.kind),
    ),
    unavailable: unavailableItems,
  };
}
