import { ACTION_DEFINITION_BY_ACTION } from "../code-mode/action-catalog.js";
import { estimateTokens } from "../util/tokenize.js";
import {
  canonicalizeContextPayload,
  serializeContextEvidence,
  serializeContextPayload,
} from "./serialize.js";
import type {
  ContextBudgetError,
  ContextCandidate,
  ContextEvidence,
  ContextPayload,
  ContextRung,
  LogicalAction,
  OmittedContextItem,
  SelectedContextBundle,
  TaskProfile,
} from "./types.js";

const RUNG_VALUE: Readonly<Record<ContextRung, number>> = {
  card: 300,
  skeleton: 180,
  hotPath: 240,
};
export const CONTEXT_RUNG_TOKEN_LIMITS: Readonly<
  Record<ContextRung, number>
> = {
  card: 160,
  skeleton: 128,
  hotPath: 300,
};
// Stable headroom for the standard MCP text-content wrapper around the
// canonical payload. The invariant is pinned in context-v2 tests.
export const CONTEXT_MCP_WRAPPER_RESERVE_TOKENS = 64;
const CONTEXT_OMISSION_EDGE_RESERVE_TOKENS = 192;
const OMITTED_CAP = 1;

export function estimateContextRungTokens(
  candidate: ContextCandidate,
  rung: ContextRung,
): number {
  const shell: ContextEvidence = {
    rung,
    symbolId: candidate.symbolId,
    path: candidate.path,
    rank: candidate.rank,
    tier: candidate.tier,
    lanes: [...candidate.lanes],
    content: "",
  };
  return (
    (candidate.estimates[rung] ?? CONTEXT_RUNG_TOKEN_LIMITS[rung]) +
    estimateTokens(serializeContextEvidence(shell))
  );
}

export function estimateContextResponseTokens(
  payload: ContextPayload,
): number {
  return (
    estimateTokens(serializeContextPayload(payload)) +
    CONTEXT_MCP_WRAPPER_RESERVE_TOKENS
  );
}

export function estimateContextSelectionEnvelopeTokens(
  emptyPayload: ContextPayload,
): number {
  return (
    estimateContextResponseTokens(emptyPayload) +
    CONTEXT_OMISSION_EDGE_RESERVE_TOKENS
  );
}

export function logicalActionForRung(
  rung: ContextRung,
  symbolId: string,
  identifiersToFind: readonly string[] = [],
): LogicalAction {
  const requestedId =
    rung === "card"
      ? "symbol.getCard"
      : rung === "skeleton"
        ? "code.getSkeleton"
        : "code.getHotPath";
  const definition = ACTION_DEFINITION_BY_ACTION[requestedId];
  const identifiers = [
    ...new Set(
      identifiersToFind
        .map((identifier) => identifier.trim())
        .filter(Boolean),
    ),
  ].slice(0, 50);
  return {
    id: definition?.action ?? requestedId,
    args:
      rung === "card"
        ? { symbolIds: [symbolId] }
        : rung === "skeleton"
          ? { symbolId }
          : {
              symbolId,
              identifiersToFind:
                identifiers.length > 0
                  ? identifiers
                  : ["contextTarget"],
            },
  };
}

function omittedItem(
  candidate: ContextCandidate,
  rung: ContextRung,
  identifiersToFind: readonly string[],
): OmittedContextItem {
  return {
    symbolId: candidate.symbolId,
    path: candidate.path,
    rung,
    rank: candidate.rank,
    tier: candidate.tier,
    reason: "budget",
    action: logicalActionForRung(
      rung,
      candidate.symbolId,
      identifiersToFind,
    ),
  };
}

function compareCandidate(
  left: ContextCandidate,
  right: ContextCandidate,
): number {
  return (
    left.rank - right.rank || left.symbolId.localeCompare(right.symbolId)
  );
}

interface MarginalRung {
  candidate: ContextCandidate;
  rung: ContextRung;
  rungIndex: number;
}

function compareValuePerToken(
  left: MarginalRung,
  right: MarginalRung,
): number {
  const leftTokens = estimateContextRungTokens(
    left.candidate,
    left.rung,
  );
  const rightTokens = estimateContextRungTokens(
    right.candidate,
    right.rung,
  );
  const leftValue =
    RUNG_VALUE[left.rung] *
    Math.max(1, 1_000 - left.candidate.rank);
  const rightValue =
    RUNG_VALUE[right.rung] *
    Math.max(1, 1_000 - right.candidate.rank);
  const leftDensity = Math.round((leftValue * 1_000) / leftTokens);
  const rightDensity = Math.round((rightValue * 1_000) / rightTokens);
  return (
    rightDensity - leftDensity ||
    compareCandidate(left.candidate, right.candidate) ||
    left.rungIndex - right.rungIndex
  );
}

export interface SelectContextBundlesInput {
  candidates: ContextCandidate[];
  profile: TaskProfile;
  availableTokens: number;
  identifiersToFind?: string[];
}

export interface SelectContextBundlesResult {
  selected: SelectedContextBundle[];
  omitted: OmittedContextItem[];
  estimatedTokens: number;
  tier0Limited: boolean;
}

function completeProfileCost(
  candidate: ContextCandidate,
  profile: TaskProfile,
): number {
  return profile.rungPreference.reduce(
    (total, rung) =>
      total + estimateContextRungTokens(candidate, rung),
    0,
  );
}

function omittedRungs(
  candidate: ContextCandidate,
  rungs: readonly ContextRung[],
  identifiersToFind: readonly string[],
): OmittedContextItem[] {
  return rungs.map((rung) =>
    omittedItem(candidate, rung, identifiersToFind),
  );
}

function selectProgressiveTier(
  candidates: ContextCandidate[],
  profile: TaskProfile,
  remainingTokens: number,
  identifiersToFind: readonly string[] = [],
): {
  selected: SelectedContextBundle[];
  omitted: OmittedContextItem[];
  usedTokens: number;
} {
  const bundles = new Map(
    candidates.map((candidate) => [
      candidate.symbolId,
      { candidate, rungs: [] as ContextRung[] },
    ]),
  );
  const omitted: OmittedContextItem[] = [];
  const nextRungIndex = new Map(
    candidates.map((candidate) => [candidate.symbolId, 0]),
  );
  const blocked = new Set<string>();
  let usedTokens = 0;

  while (true) {
    const queue = candidates
      .filter((candidate) => !blocked.has(candidate.symbolId))
      .flatMap((candidate): MarginalRung[] => {
        const rungIndex = nextRungIndex.get(candidate.symbolId) ?? 0;
        const rung = profile.rungPreference[rungIndex];
        return rung ? [{ candidate, rung, rungIndex }] : [];
      })
      // Cover Tier 0 candidates in retrieval-rank order before using value
      // density to decide which admitted bundle is most valuable to upgrade.
      .sort((left, right) =>
        left.rungIndex === 0 || right.rungIndex === 0
          ? left.rungIndex - right.rungIndex ||
            compareCandidate(left.candidate, right.candidate)
          : compareValuePerToken(left, right),
      );
    const marginal = queue[0];
    if (!marginal) break;

    const cost = estimateContextRungTokens(
      marginal.candidate,
      marginal.rung,
    );
    if (usedTokens + cost <= remainingTokens) {
      bundles
        .get(marginal.candidate.symbolId)
        ?.rungs.push(marginal.rung);
      usedTokens += cost;
      nextRungIndex.set(
        marginal.candidate.symbolId,
        marginal.rungIndex + 1,
      );
      continue;
    }

    omitted.push(
      ...omittedRungs(
        marginal.candidate,
        profile.rungPreference.slice(marginal.rungIndex),
        identifiersToFind,
      ),
    );
    blocked.add(marginal.candidate.symbolId);
  }

  for (const candidate of candidates) {
    if (
      (nextRungIndex.get(candidate.symbolId) ?? 0) === 0 &&
      !blocked.has(candidate.symbolId)
    ) {
      omitted.push(
        ...omittedRungs(
          candidate,
          profile.rungPreference,
          identifiersToFind,
        ),
      );
    }
  }

  return {
    selected: [...bundles.values()]
      .filter((bundle) => bundle.rungs.length > 0)
      .sort((left, right) =>
        compareCandidate(left.candidate, right.candidate),
      ),
    omitted,
    usedTokens,
  };
}

function selectTierOne(
  candidates: ContextCandidate[],
  profile: TaskProfile,
  remainingTokens: number,
  identifiersToFind: readonly string[],
): {
  selected: SelectedContextBundle[];
  omitted: OmittedContextItem[];
  usedTokens: number;
} {
  const baseRung = profile.rungPreference[0];
  if (!baseRung) {
    return { selected: [], omitted: [], usedTokens: 0 };
  }

  const bundles = new Map<string, SelectedContextBundle>();
  const omitted: OmittedContextItem[] = [];
  const exactIdentifiers = candidates
    .filter((candidate) =>
      candidate.lanes.includes("exactIdentifier"),
    )
    .map(
      (candidate): MarginalRung => ({
        candidate,
        rung: baseRung,
        rungIndex: 0,
      }),
    )
    .sort((left, right) => compareCandidate(left.candidate, right.candidate));
  const admittedExact: ContextCandidate[] = [];
  let usedTokens = 0;

  // Exact lexical provenance is the only Tier 1 admission that may enter on
  // its base card alone. This preserves derived identifier hits without
  // turning general retrieval into partial-symbol breadth.
  for (const marginal of exactIdentifiers) {
    const cost = estimateContextRungTokens(
      marginal.candidate,
      marginal.rung,
    );
    if (usedTokens + cost <= remainingTokens) {
      bundles.set(marginal.candidate.symbolId, {
        candidate: marginal.candidate,
        rungs: [marginal.rung],
      });
      admittedExact.push(marginal.candidate);
      usedTokens += cost;
    } else {
      omitted.push(
        ...omittedRungs(
          marginal.candidate,
          profile.rungPreference,
          identifiersToFind,
        ),
      );
    }
  }

  const nextRungIndex = new Map(
    admittedExact.map((candidate) => [candidate.symbolId, 1]),
  );
  const blocked = new Set<string>();
  while (true) {
    const queue = admittedExact
      .filter((candidate) => !blocked.has(candidate.symbolId))
      .flatMap((candidate): MarginalRung[] => {
        const rungIndex = nextRungIndex.get(candidate.symbolId) ?? 1;
        const rung = profile.rungPreference[rungIndex];
        return rung ? [{ candidate, rung, rungIndex }] : [];
      })
      .sort(compareValuePerToken);
    const marginal = queue[0];
    if (!marginal) break;

    const cost = estimateContextRungTokens(
      marginal.candidate,
      marginal.rung,
    );
    if (usedTokens + cost <= remainingTokens) {
      bundles.get(marginal.candidate.symbolId)?.rungs.push(marginal.rung);
      usedTokens += cost;
      nextRungIndex.set(
        marginal.candidate.symbolId,
        marginal.rungIndex + 1,
      );
      continue;
    }

    omitted.push(
      ...omittedRungs(
        marginal.candidate,
        profile.rungPreference.slice(marginal.rungIndex),
        identifiersToFind,
      ),
    );
    blocked.add(marginal.candidate.symbolId);
  }

  const completeCandidates = candidates
    .filter(
      (candidate) =>
        !candidate.lanes.includes("exactIdentifier"),
    )
    .sort(compareCandidate);
  for (const candidate of completeCandidates) {
    const cost = completeProfileCost(candidate, profile);
    if (usedTokens + cost <= remainingTokens) {
      bundles.set(candidate.symbolId, {
        candidate,
        rungs: [...profile.rungPreference],
      });
      usedTokens += cost;
    } else {
      omitted.push(
        ...omittedRungs(
          candidate,
          profile.rungPreference,
          identifiersToFind,
        ),
      );
    }
  }

  return {
    selected: [...bundles.values()].sort((left, right) =>
      compareCandidate(left.candidate, right.candidate),
    ),
    omitted,
    usedTokens,
  };
}

export function selectContextBundles({
  candidates,
  profile,
  availableTokens,
  identifiersToFind = [],
}: SelectContextBundlesInput): SelectContextBundlesResult {
  const unique = new Map<string, ContextCandidate>();
  for (const candidate of candidates) {
    const existing = unique.get(candidate.symbolId);
    if (
      !existing ||
      candidate.tier < existing.tier ||
      (candidate.tier === existing.tier &&
        compareCandidate(candidate, existing) < 0)
    ) {
      unique.set(candidate.symbolId, candidate);
    }
  }

  const tier0 = [...unique.values()]
    .filter((candidate) => candidate.tier === 0)
    .sort(compareCandidate);
  const tier1 = [...unique.values()]
    .filter((candidate) => candidate.tier === 1)
    .sort(compareCandidate);
  const completeTierZeroCost = tier0.reduce(
    (total, candidate) =>
      total + completeProfileCost(candidate, profile),
    0,
  );
  const selectedTier0 = selectProgressiveTier(
    tier0,
    profile,
    availableTokens,
    identifiersToFind,
  );
  const tier0Limited = completeTierZeroCost > availableTokens;

  if (tier0Limited) {
    return {
      selected: selectedTier0.selected,
      omitted: [
        ...selectedTier0.omitted,
        ...tier1.flatMap((candidate) =>
          profile.rungPreference.map((rung) =>
            omittedItem(candidate, rung, identifiersToFind),
          ),
        ),
      ],
      estimatedTokens: selectedTier0.usedTokens,
      tier0Limited: true,
    };
  }

  const remainingTokens = Math.max(
    0,
    availableTokens - selectedTier0.usedTokens,
  );
  const selectedTier1 = selectTierOne(
    tier1,
    profile,
    remainingTokens,
    identifiersToFind,
  );
  return {
    selected: [...selectedTier0.selected, ...selectedTier1.selected],
    omitted: [...selectedTier0.omitted, ...selectedTier1.omitted],
    estimatedTokens:
      selectedTier0.usedTokens + selectedTier1.usedTokens,
    tier0Limited: false,
  };
}

function evidenceEvictionOrder(
  left: ContextEvidence,
  right: ContextEvidence,
): number {
  const rungOrder: Readonly<Record<ContextRung, number>> = {
    card: 0,
    skeleton: 1,
    hotPath: 2,
  };
  return (
    left.tier - right.tier ||
    rungOrder[left.rung] - rungOrder[right.rung] ||
    left.rank - right.rank ||
    left.symbolId.localeCompare(right.symbolId)
  );
}

function compareOmittedPriority(
  left: OmittedContextItem,
  right: OmittedContextItem,
): number {
  return (
    left.tier - right.tier ||
    // A missing card is first coverage; skeleton and hot path are upgrades.
    (left.rung === "card" ? 0 : 1) -
      (right.rung === "card" ? 0 : 1) ||
    left.rank - right.rank ||
    left.symbolId.localeCompare(right.symbolId) ||
    left.rung.localeCompare(right.rung)
  );
}

function rebuildBoundedRecovery(
  payload: ContextPayload,
  trackedOmissions: readonly OmittedContextItem[],
): void {
  payload.omitted.highestRanked = [...trackedOmissions]
    .sort(compareOmittedPriority)
    .slice(0, OMITTED_CAP);
  const actions = new Map<string, LogicalAction>();
  for (const item of payload.omitted.highestRanked) {
    const key = `${item.action.id}\0${JSON.stringify(item.action.args)}`;
    if (!actions.has(key)) actions.set(key, item.action);
  }
  payload.nextActions = [...actions.values()].slice(0, OMITTED_CAP);
}

function contextBudgetError(
  maxTokens: number,
  minimumTokens: number,
): ContextBudgetError {
  return {
    isError: true,
    error: {
      code: "CONTEXT_BUDGET_TOO_SMALL",
      message:
        `Context budget ${maxTokens} is below the minimum ` +
        `${minimumTokens} tokens required for the retrieval envelope.`,
      minimumTokens,
    },
  };
}

function minimalBudgetPayload(input: ContextPayload): ContextPayload {
  return canonicalizeContextPayload({
    ...input,
    status: input.status === "empty" ? "empty" : "budgetLimited",
    evidence: [],
    edges: [],
    omitted: {
      total: input.omitted.total,
      byReason: { ...input.omitted.byReason },
      highestRanked: [],
    },
    nextActions: [],
  });
}

export function enforceContextBudget(
  input: ContextPayload,
  maxTokens: number,
  identifiersToFind: readonly string[] = [],
): {
  payload: ContextPayload;
  estimatedTokens: number;
  budgetError?: ContextBudgetError;
} {
  let payload = canonicalizeContextPayload(structuredClone(input));
  const trackedOmissions = [...payload.omitted.highestRanked];
  const initialMinimumTokens = estimateContextResponseTokens(
    minimalBudgetPayload(payload),
  );
  if (maxTokens < initialMinimumTokens) {
    return {
      payload,
      estimatedTokens: estimateContextResponseTokens(payload),
      budgetError: contextBudgetError(maxTokens, initialMinimumTokens),
    };
  }

  let estimatedTokens = estimateContextResponseTokens(payload);
  while (estimatedTokens > maxTokens && payload.evidence.length > 0) {
    const evidence = [...payload.evidence]
      .sort(evidenceEvictionOrder)
      .at(-1);
    if (!evidence) break;
    const evidenceIndex = payload.evidence.findIndex(
      (item) =>
        item.symbolId === evidence.symbolId &&
        item.rung === evidence.rung &&
        item.path === evidence.path &&
        item.rank === evidence.rank &&
        item.tier === evidence.tier,
    );
    if (evidenceIndex < 0) break;
    payload.evidence.splice(evidenceIndex, 1);
    const removed: OmittedContextItem = {
      symbolId: evidence.symbolId,
      path: evidence.path,
      rung: evidence.rung,
      rank: evidence.rank,
      tier: evidence.tier,
      reason: "budget",
      action: logicalActionForRung(
        evidence.rung,
        evidence.symbolId,
        identifiersToFind,
      ),
    };
    if (
      !payload.evidence.some(
        (item) => item.symbolId === evidence.symbolId,
      )
    ) {
      payload.edges = payload.edges.filter(
        (edge) =>
          edge.from !== evidence.symbolId &&
          edge.to !== evidence.symbolId,
      );
    }
    payload.status = "budgetLimited";
    payload.omitted.total += 1;
    payload.omitted.byReason.budget += 1;
    trackedOmissions.push(removed);
    rebuildBoundedRecovery(payload, trackedOmissions);
    payload = canonicalizeContextPayload(payload);
    estimatedTokens = estimateContextResponseTokens(payload);
  }

  if (
    estimatedTokens > maxTokens &&
    (payload.omitted.highestRanked.length > 0 ||
      payload.nextActions.length > 0)
  ) {
    // Recovery detail is bounded and optional; aggregate omission counts remain
    // authoritative when a very small budget cannot carry the detail record.
    payload.omitted.highestRanked = [];
    payload.nextActions = [];
    payload = canonicalizeContextPayload(payload);
    estimatedTokens = estimateContextResponseTokens(payload);
  }

  if (estimatedTokens > maxTokens) {
    const minimumPayload = minimalBudgetPayload(payload);
    const minimumTokens = estimateContextResponseTokens(minimumPayload);
    return {
      payload: minimumPayload,
      estimatedTokens: minimumTokens,
      budgetError: contextBudgetError(maxTokens, minimumTokens),
    };
  }

  return {
    payload: canonicalizeContextPayload(payload),
    estimatedTokens,
  };
}
