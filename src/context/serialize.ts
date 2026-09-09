import { normalizeValue, type NormalizedValue } from "../util/hashing.js";
import type {
  ContextEvidence,
  ContextLaneId,
  ContextPayload,
  ContextRung,
  LogicalAction,
  OmittedContextItem,
} from "./types.js";

const LANE_ORDER: readonly ContextLaneId[] = [
  "exactIdentifier",
  "symbolFts",
  "symbolVec",
  "fileSummaryFts",
  "fileSummaryVec",
  "graph",
  "overlay",
  "feedback",
  "memory",
];
const RUNG_ORDER: readonly ContextRung[] = ["card", "skeleton", "hotPath"];

function compareRung(left: ContextRung, right: ContextRung): number {
  return RUNG_ORDER.indexOf(left) - RUNG_ORDER.indexOf(right);
}

function compareEvidence(
  left: ContextEvidence,
  right: ContextEvidence,
): number {
  return (
    left.tier - right.tier ||
    left.rank - right.rank ||
    left.symbolId.localeCompare(right.symbolId) ||
    compareRung(left.rung, right.rung)
  );
}

function compareOmitted(
  left: OmittedContextItem,
  right: OmittedContextItem,
): number {
  return (
    left.tier - right.tier ||
    left.rank - right.rank ||
    left.symbolId.localeCompare(right.symbolId) ||
    compareRung(left.rung, right.rung)
  );
}

function compareAction(left: LogicalAction, right: LogicalAction): number {
  return (
    left.id.localeCompare(right.id) ||
    JSON.stringify(normalizeValue(left.args)).localeCompare(
      JSON.stringify(normalizeValue(right.args)),
    )
  );
}

function canonicalizeEvidence(item: ContextEvidence): ContextEvidence {
  return {
    ...item,
    lanes: [...item.lanes].sort(
      (left, right) =>
        LANE_ORDER.indexOf(left) - LANE_ORDER.indexOf(right),
    ),
  };
}

export function canonicalizeContextPayload(
  payload: ContextPayload,
): ContextPayload {
  const evidence = payload.evidence
    .map(canonicalizeEvidence)
    .sort(compareEvidence);
  const edges = [...payload.edges].sort(
    (left, right) =>
      left.from.localeCompare(right.from) ||
      left.to.localeCompare(right.to) ||
      left.kind.localeCompare(right.kind) ||
      right.confidencePermille - left.confidencePermille,
  );

  return {
    status: payload.status,
    taskType: payload.taskType,
    retrieval: {
      level: payload.retrieval.level,
      lanes: payload.retrieval.lanes
        .map((lane) => ({ ...lane }))
        .sort(
          (left, right) =>
            LANE_ORDER.indexOf(left.id) - LANE_ORDER.indexOf(right.id),
        ),
    },
    evidence,
    edges,
    omitted: {
      total: payload.omitted.total,
      byReason: payload.omitted.byReason,
      highestRanked: [...payload.omitted.highestRanked].sort(compareOmitted),
    },
    nextActions: [...payload.nextActions].sort(compareAction),
  };
}

export function serializeContextEvidence(evidence: ContextEvidence): string {
  return JSON.stringify(normalizeValue(canonicalizeEvidence(evidence)));
}

export function stableContextValue(payload: ContextPayload): NormalizedValue {
  return normalizeValue(canonicalizeContextPayload(payload));
}

export function serializeContextPayload(payload: ContextPayload): string {
  return JSON.stringify(stableContextValue(payload));
}

/** Fold surviving card metadata into code only after budget eviction preserves fallback. */
export function consolidateContextEvidence(payload: ContextPayload): ContextPayload {
  const codeByIdentity = new Map<string, ContextEvidence>();
  const identity = (item: ContextEvidence): string =>
    JSON.stringify([item.symbolId, item.path, item.rank, item.tier, item.lanes]);
  for (const item of payload.evidence) {
    if (item.rung === "card" || !isEvidenceContent(item.content)) continue;
    if (typeof item.content.skeleton !== "string"
      && typeof item.content.excerpt !== "string"
      && typeof item.content.code !== "string") continue;
    if (!Object.hasOwn(item.content, "card") && !codeByIdentity.has(identity(item))) {
      codeByIdentity.set(identity(item), item);
    }
  }
  const nestedCards = new Map<ContextEvidence, unknown>();
  const folded = new Set<ContextEvidence>();
  for (const item of payload.evidence) {
    if (item.rung !== "card" || !isEvidenceContent(item.content)) continue;
    const code = codeByIdentity.get(identity(item));
    if (!code || nestedCards.has(code)) continue;
    nestedCards.set(code, item.content);
    folded.add(item);
  }
  return {
    ...payload,
    evidence: payload.evidence.filter(item => !folded.has(item)).map(item =>
      nestedCards.has(item) && isEvidenceContent(item.content)
        ? { ...item, content: { ...item.content, card: nestedCards.get(item) } }
        : item),
  };
}

function isEvidenceContent(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
