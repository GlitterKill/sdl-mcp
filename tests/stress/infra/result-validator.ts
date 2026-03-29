/**
 * Tool Result Validator — semantic validation of MCP tool responses.
 *
 * Each tool has validators that check the *content* of responses,
 * not just HTTP status.  These are the "smoke-test" assertions
 * that would catch a tool returning empty/garbage while still
 * reporting success at the transport level.
 *
 * Validators are intentionally lenient: they check structural shape
 * and minimum-viable content.  They never check exact values (those
 * belong in unit tests).
 */

import type { ToolResultCheck } from "./types.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate a tool result and return the checks performed.
 *
 * Returns an empty array for tools without registered validators
 * (unknown tools silently pass — we only gate on known contracts).
 */
export function validateToolResult(
  toolName: string,
  args: Record<string, unknown>,
  result: Record<string, unknown>,
): ToolResultCheck[] {
  const validator = VALIDATORS[toolName];
  if (!validator) return [];
  try {
    return validator(args, result);
  } catch {
    // Validator itself crashed — record one failure check
    return [
      {
        tool: toolName,
        check: "validator_internal",
        passed: false,
        actual: "validator threw",
      },
    ];
  }
}

/**
 * Extract notable sample values from a tool result for the report.
 *
 * Returns key→value pairs that give a human reader a quick sense of
 * whether the tool returned real data.
 */
export function extractSampleValues(
  toolName: string,
  result: Record<string, unknown>,
): Record<string, string> {
  const extractor = SAMPLE_EXTRACTORS[toolName];
  if (!extractor) return {};
  try {
    return extractor(result);
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok(tool: string, check: string, actual?: string): ToolResultCheck {
  return { tool, check, passed: true, actual };
}

function fail(tool: string, check: string, actual?: string): ToolResultCheck {
  return { tool, check, passed: false, actual };
}

function checkExists(
  tool: string,
  label: string,
  value: unknown,
): ToolResultCheck {
  return value !== undefined && value !== null
    ? ok(tool, label, String(typeof value === "object" ? "present" : value))
    : fail(tool, label, "missing");
}

function checkNonEmptyString(
  tool: string,
  label: string,
  value: unknown,
): ToolResultCheck {
  return typeof value === "string" && value.length > 0
    ? ok(tool, label, `${value.length} chars`)
    : fail(tool, label, typeof value === "string" ? "empty" : "missing");
}

function checkArrayMinLen(
  tool: string,
  label: string,
  value: unknown,
  min: number,
): ToolResultCheck {
  if (!Array.isArray(value)) return fail(tool, label, "not an array");
  return value.length >= min
    ? ok(tool, label, String(value.length))
    : fail(tool, label, `${value.length} < ${min}`);
}

function checkPositiveNumber(
  tool: string,
  label: string,
  value: unknown,
): ToolResultCheck {
  return typeof value === "number" && value > 0
    ? ok(tool, label, String(value))
    : fail(tool, label, String(value ?? "missing"));
}

type ValidatorFn = (
  args: Record<string, unknown>,
  result: Record<string, unknown>,
) => ToolResultCheck[];

type SampleExtractorFn = (
  result: Record<string, unknown>,
) => Record<string, string>;

// ---------------------------------------------------------------------------
// Per-tool validators
// ---------------------------------------------------------------------------

const VALIDATORS: Record<string, ValidatorFn> = {
  // -------------------------------------------------------------------------
  // Repository
  // -------------------------------------------------------------------------

  "sdl.repo.register": (_args, result) => {
    const tool = "sdl.repo.register";
    return [checkNonEmptyString(tool, "repoId returned", result.repoId)];
  },

  "sdl.repo.status": (_args, result) => {
    const tool = "sdl.repo.status";
    const checks: ToolResultCheck[] = [
      checkExists(tool, "symbolsIndexed present", result.symbolsIndexed),
      checkExists(tool, "filesIndexed present", result.filesIndexed),
    ];
    if (typeof result.symbolsIndexed === "number") {
      checks.push(
        result.symbolsIndexed > 0
          ? ok(tool, "symbolsIndexed > 0", String(result.symbolsIndexed))
          : fail(tool, "symbolsIndexed > 0", "0"),
      );
    }
    if (typeof result.filesIndexed === "number") {
      checks.push(
        result.filesIndexed > 0
          ? ok(tool, "filesIndexed > 0", String(result.filesIndexed))
          : fail(tool, "filesIndexed > 0", "0"),
      );
    }
    return checks;
  },

  "sdl.repo.overview": (_args, result) => {
    const tool = "sdl.repo.overview";
    // stats-level returns a stats object; full/directories return more
    return [
      checkExists(
        tool,
        "stats or directories present",
        result.stats ?? result.directories ?? result.hotspots,
      ),
    ];
  },

  "sdl.index.refresh": (_args, result) => {
    const tool = "sdl.index.refresh";
    return [checkNonEmptyString(tool, "versionId returned", result.versionId)];
  },

  // -------------------------------------------------------------------------
  // Symbol
  // -------------------------------------------------------------------------

  "sdl.symbol.search": (args, result) => {
    const tool = "sdl.symbol.search";
    const results = result.results as
      | Array<Record<string, unknown>>
      | undefined;
    const checks: ToolResultCheck[] = [
      checkExists(tool, "results array present", results),
    ];
    if (Array.isArray(results)) {
      // For non-garbage queries, expect at least 1 result
      checks.push(checkArrayMinLen(tool, "results.length >= 1", results, 1));
      // Validate structure of first result
      if (results.length > 0) {
        const first = results[0];
        checks.push(
          checkNonEmptyString(tool, "result[0].symbolId", first.symbolId),
          checkNonEmptyString(tool, "result[0].name", first.name),
          checkNonEmptyString(tool, "result[0].file", first.file),
          checkNonEmptyString(tool, "result[0].kind", first.kind),
        );
      }
    }
    // If semantic was requested, we can't assert it was used (may degrade)
    // but we record it as a sample value
    return checks;
  },

  "sdl.symbol.getCard": (_args, result) => {
    const tool = "sdl.symbol.getCard";
    // Could be a notModified response or a full card
    if (result.notModified === true) {
      return [
        ok(tool, "notModified response", "true"),
        checkNonEmptyString(tool, "etag present", result.etag),
      ];
    }
    const card = result.card as Record<string, unknown> | undefined;
    if (!card) return [fail(tool, "card present", "missing")];
    return [
      ok(tool, "card present", "present"),
      checkNonEmptyString(tool, "card.symbolId", card.symbolId),
      checkNonEmptyString(tool, "card.name", card.name),
      checkNonEmptyString(tool, "card.kind", card.kind),
      checkNonEmptyString(tool, "card.file", card.file),
      checkExists(tool, "card.range present", card.range),
      checkExists(tool, "card.deps present", card.deps),
      checkExists(tool, "card.version present", card.version),
    ];
  },

  "sdl.symbol.getCards": (_args, result) => {
    const tool = "sdl.symbol.getCards";
    const cards = result.cards as unknown[] | undefined;
    const checks: ToolResultCheck[] = [
      checkExists(tool, "cards array present", cards),
    ];
    if (Array.isArray(cards)) {
      checks.push(checkArrayMinLen(tool, "cards.length >= 1", cards, 1));
      // Spot-check first card
      if (cards.length > 0) {
        const first = cards[0] as Record<string, unknown> | undefined;
        if (first && first.notModified !== true) {
          checks.push(
            checkNonEmptyString(tool, "cards[0].symbolId", first.symbolId),
            checkNonEmptyString(tool, "cards[0].name", first.name),
          );
        } else if (first?.notModified === true) {
          checks.push(ok(tool, "cards[0] notModified", "true"));
        }
      }
    }
    return checks;
  },

  // -------------------------------------------------------------------------
  // Slice
  // -------------------------------------------------------------------------

  "sdl.slice.build": (_args, result) => {
    const tool = "sdl.slice.build";
    // Compact wire format has different shape than full
    const checks: ToolResultCheck[] = [];
    // sliceHandle is always present regardless of wire format
    checks.push(
      checkNonEmptyString(tool, "sliceHandle present", result.sliceHandle),
    );
    // Compact format: result.slice.c (cards array) or result.cards
    const slice = result.slice as Record<string, unknown> | undefined;
    const cards = (slice?.c ?? result.cards) as unknown[] | undefined;
    if (cards) {
      checks.push(checkArrayMinLen(tool, "cards.length >= 1", cards, 1));
    } else {
      checks.push(checkExists(tool, "cards present (compact or full)", cards));
    }
    // ledgerVersion
    checks.push(
      checkExists(
        tool,
        "ledgerVersion present",
        result.ledgerVersion ?? slice?.vid,
      ),
    );
    return checks;
  },

  "sdl.slice.refresh": (_args, result) => {
    const tool = "sdl.slice.refresh";
    return [
      checkNonEmptyString(tool, "sliceHandle present", result.sliceHandle),
      checkExists(
        tool,
        "delta or notModified",
        result.delta ?? (result.notModified === true ? true : undefined),
      ),
    ];
  },

  "sdl.slice.spillover.get": (_args, result) => {
    const tool = "sdl.slice.spillover.get";
    return [checkExists(tool, "cards array present", result.cards)];
  },

  // -------------------------------------------------------------------------
  // Code
  // -------------------------------------------------------------------------

  "sdl.code.getSkeleton": (_args, result) => {
    const tool = "sdl.code.getSkeleton";
    return [checkNonEmptyString(tool, "skeleton content", result.skeleton)];
  },

  "sdl.code.getHotPath": (_args, result) => {
    const tool = "sdl.code.getHotPath";
    // Excerpt may be empty if identifiers not found — existence is the check
    return [checkExists(tool, "excerpt present", result.excerpt)];
  },

  "sdl.code.needWindow": (_args, result) => {
    const tool = "sdl.code.needWindow";
    // Either approved (code present) or denied (denial info present)
    const hasCode = typeof result.code === "string" && result.code.length > 0;
    const denied = result.approved === false;
    if (hasCode) {
      return [
        ok(
          tool,
          "approved with code",
          `${(result.code as string).length} chars`,
        ),
      ];
    }
    if (denied) {
      const whyDenied = Array.isArray(result.whyDenied)
        ? (result.whyDenied as string[]).join("; ")
        : "denied";
      return [ok(tool, "denied by policy", whyDenied)];
    }
    return [fail(tool, "code or denial expected", "neither present")];
  },

  // -------------------------------------------------------------------------
  // Policy
  // -------------------------------------------------------------------------

  "sdl.policy.get": (_args, result) => {
    const tool = "sdl.policy.get";
    const policy = result.policy as Record<string, unknown> | undefined;
    return [
      checkExists(tool, "policy object present", policy),
      ...(policy
        ? [checkExists(tool, "maxWindowLines in policy", policy.maxWindowLines)]
        : []),
    ];
  },

  "sdl.policy.set": (_args, result) => {
    const tool = "sdl.policy.set";
    return [
      checkExists(tool, "ok or policy returned", result.ok ?? result.policy),
    ];
  },

  // -------------------------------------------------------------------------
  // Context Summary
  // -------------------------------------------------------------------------

  "sdl.context.summary": (_args, result) => {
    const tool = "sdl.context.summary";
    return [
      checkNonEmptyString(tool, "content string", result.content),
      checkExists(tool, "summary object present", result.summary),
      checkNonEmptyString(tool, "format present", result.format),
    ];
  },

  // -------------------------------------------------------------------------
  // Agent
  // -------------------------------------------------------------------------

  "sdl.agent.context": (_args, result) => {
    const tool = "sdl.agent.context";
    return [
      checkNonEmptyString(tool, "taskId present", result.taskId),
      checkExists(tool, "actionsTaken array", result.actionsTaken),
      checkNonEmptyString(tool, "taskType present", result.taskType),
    ];
  },

  "sdl.agent.feedback": (_args, result) => {
    const tool = "sdl.agent.feedback";
    return [
      result.ok === true
        ? ok(tool, "ok === true", "true")
        : fail(tool, "ok === true", String(result.ok)),
      checkNonEmptyString(tool, "feedbackId present", result.feedbackId),
      checkPositiveNumber(tool, "symbolsRecorded > 0", result.symbolsRecorded),
    ];
  },

  "sdl.agent.feedback.query": (_args, result) => {
    const tool = "sdl.agent.feedback.query";
    return [checkExists(tool, "feedback array present", result.feedback)];
  },

  // -------------------------------------------------------------------------
  // Delta
  // -------------------------------------------------------------------------

  "sdl.delta.get": (_args, result) => {
    const tool = "sdl.delta.get";
    return [
      checkExists(
        tool,
        "delta or noChanges",
        result.delta ?? result.noChanges ?? result.changes,
      ),
    ];
  },

  // -------------------------------------------------------------------------
  // PR Risk
  // -------------------------------------------------------------------------

  "sdl.pr.risk.analyze": (_args, result) => {
    const tool = "sdl.pr.risk.analyze";
    return [
      checkExists(
        tool,
        "risk data present",
        result.riskScore ?? result.risks ?? result.analysis,
      ),
    ];
  },

  // -------------------------------------------------------------------------
  // Buffer (live index)
  // -------------------------------------------------------------------------

  "sdl.buffer.push": (_args, result) => {
    const tool = "sdl.buffer.push";
    return [checkExists(tool, "ok or accepted", result.ok ?? result.accepted)];
  },

  "sdl.buffer.checkpoint": (_args, result) => {
    const tool = "sdl.buffer.checkpoint";
    return [
      checkExists(tool, "ok or checkpointId", result.ok ?? result.checkpointId),
    ];
  },

  "sdl.buffer.status": (_args, result) => {
    const tool = "sdl.buffer.status";
    return [
      checkExists(
        tool,
        "status data present",
        result.draftFiles ?? result.status,
      ),
    ];
  },
};

// ---------------------------------------------------------------------------
// Sample value extractors — surface interesting numbers in the report
// ---------------------------------------------------------------------------

const SAMPLE_EXTRACTORS: Record<string, SampleExtractorFn> = {
  "sdl.repo.status": (result) => ({
    symbolsIndexed: String(result.symbolsIndexed ?? "?"),
    filesIndexed: String(result.filesIndexed ?? "?"),
  }),

  "sdl.symbol.search": (result) => {
    const results = result.results as unknown[] | undefined;
    const vals: Record<string, string> = {
      resultCount: String(results?.length ?? 0),
    };
    if (result._tokenUsage) {
      const usage = result._tokenUsage as Record<string, unknown>;
      vals.savingsPercent = String(usage.savingsPercent ?? "?");
    }
    return vals;
  },

  "sdl.symbol.getCard": (result) => {
    if (result.notModified) {
      const vals: Record<string, string> = { notModified: "true" };
      return vals;
    }
    const card = result.card as Record<string, unknown> | undefined;
    const vals: Record<string, string> = {
      name: String(card?.name ?? "?"),
      kind: String(card?.kind ?? "?"),
      hasDeps: card?.deps ? "true" : "false",
      hasMetrics: card?.metrics ? "true" : "false",
      hasSignature: card?.signature ? "true" : "false",
    };
    return vals;
  },

  "sdl.symbol.getCards": (result) => {
    const cards = result.cards as unknown[] | undefined;
    return {
      cardsReturned: String(cards?.length ?? 0),
    };
  },

  "sdl.slice.build": (result) => {
    const slice = result.slice as Record<string, unknown> | undefined;
    const cards = (slice?.c ?? result.cards) as unknown[] | undefined;
    return {
      cardCount: String(cards?.length ?? 0),
      hasSliceHandle: result.sliceHandle ? "true" : "false",
    };
  },

  "sdl.code.getSkeleton": (result) => ({
    skeletonLength: String(
      typeof result.skeleton === "string" ? result.skeleton.length : 0,
    ),
  }),

  "sdl.code.getHotPath": (result) => ({
    excerptLength: String(
      typeof result.excerpt === "string" ? result.excerpt.length : 0,
    ),
  }),

  "sdl.context.summary": (result) => ({
    contentLength: String(
      typeof result.content === "string" ? result.content.length : 0,
    ),
  }),

  "sdl.agent.context": (result) => {
    const actions = result.actionsTaken as unknown[] | undefined;
    return {
      actionCount: String(actions?.length ?? 0),
      taskType: String(result.taskType ?? "?"),
    };
  },

  "sdl.index.refresh": (result) => ({
    versionId: String(result.versionId ?? "?"),
  }),

  "sdl.agent.feedback": (result) => ({
    symbolsRecorded: String(result.symbolsRecorded ?? 0),
  }),

  "sdl.repo.overview": (result) => {
    const stats = result.stats as Record<string, unknown> | undefined;
    return {
      symbolCount: String(stats?.symbolCount ?? "?"),
    };
  },
};
