import crypto from "crypto";
import type {
  PolicyRequestContext,
  PolicyDecision,
  PolicyRule,
  PolicyConfig,
  PolicyEvidence,
} from "./types.js";
import { DEFAULT_POLICY_CONFIG } from "./types.js";
import { logger } from "../util/logger.js";
import type { NextBestAction, RequiredFieldsForNext } from "../mcp/types.js";
import {
  POLICY_PRIORITY_WINDOW_SIZE_LIMIT,
  POLICY_PRIORITY_IDENTIFIERS_REQUIRED,
  POLICY_PRIORITY_BUDGET_CAPS,
  POLICY_PRIORITY_BREAK_GLASS,
  POLICY_PRIORITY_DEFAULT_DENY_RAW,
} from "../config/constants.js";

/**
 * Policy rule priorities - higher values run first.
 * Rules are evaluated in descending priority order until one denies or all pass.
 *
 * Priority tiers:
 * - 100: Hard limits (window size) - must be checked first
 * - 90: Input validation (required fields)
 * - 80: Budget enforcement (token/request caps)
 * - 10: Override mechanisms (break-glass)
 */
const RULE_PRIORITY = {
  WINDOW_SIZE_LIMIT: POLICY_PRIORITY_WINDOW_SIZE_LIMIT,
  IDENTIFIERS_REQUIRED: POLICY_PRIORITY_IDENTIFIERS_REQUIRED,
  BUDGET_CAPS: POLICY_PRIORITY_BUDGET_CAPS,
  BREAK_GLASS: POLICY_PRIORITY_BREAK_GLASS,
  DEFAULT_DENY_RAW: POLICY_PRIORITY_DEFAULT_DENY_RAW,
} as const;

export type {
  PolicyRequestContext,
  PolicyDecision,
  PolicyRule,
  PolicyConfig,
  PolicyEvidence,
};

export function generateAuditHash(
  decision: string,
  evidence: PolicyEvidence[],
  context: PolicyRequestContext,
): string {
  const hashInput = {
    decision,
    evidence,
    requestType: context.requestType,
    repoId: context.repoId,
    symbolId: context.symbolId,
    timestamp: Date.now(),
  };
  const hashString = JSON.stringify(hashInput);
  return crypto.createHash("sha256").update(hashString).digest("hex");
}

export class PolicyEngine {
  private rules: Map<string, PolicyRule> = new Map();
  private config: PolicyConfig;

  constructor(config: Partial<PolicyConfig> = {}) {
    this.config = { ...DEFAULT_POLICY_CONFIG, ...config };
    this.registerDefaultRules();
  }

  private registerDefaultRules(): void {
    this.addRule({
      name: "window-size-limit",
      enabled: true,
      priority: RULE_PRIORITY.WINDOW_SIZE_LIMIT,
      evaluate: (ctx) => {
        if (ctx.requestType !== "codeWindow") {
          return {
            passed: true,
            evidence: {
              type: "check-skipped",
              value: null,
              reason: "Rule only applies to codeWindow requests",
            },
          };
        }

        const failed: PolicyEvidence[] = [];

        if (
          ctx.maxWindowLines &&
          ctx.maxWindowLines > this.config.maxWindowLines
        ) {
          failed.push({
            type: "max-lines-exceeded",
            value: {
              requested: ctx.maxWindowLines,
              limit: this.config.maxWindowLines,
            },
            reason: `Requested lines (${ctx.maxWindowLines}) exceed maximum (${this.config.maxWindowLines})`,
          });
        }

        if (
          ctx.maxWindowTokens &&
          ctx.maxWindowTokens > this.config.maxWindowTokens
        ) {
          failed.push({
            type: "max-tokens-exceeded",
            value: {
              requested: ctx.maxWindowTokens,
              limit: this.config.maxWindowTokens,
            },
            reason: `Requested tokens (${ctx.maxWindowTokens}) exceed maximum (${this.config.maxWindowTokens})`,
          });
        }

        if (failed.length > 0) {
          return {
            passed: false,
            evidence: failed[0],
            downgradeTo: "skeleton",
          };
        }

        return {
          passed: true,
          evidence: {
            type: "window-size-check",
            value: {
              maxLines: this.config.maxWindowLines,
              maxTokens: this.config.maxWindowTokens,
            },
            reason: "Window size within limits",
          },
        };
      },
    });

    this.addRule({
      name: "identifiers-required",
      enabled: true,
      priority: RULE_PRIORITY.IDENTIFIERS_REQUIRED,
      evaluate: (ctx) => {
        if (ctx.requestType !== "codeWindow") {
          return {
            passed: true,
            evidence: {
              type: "check-skipped",
              value: null,
              reason: "Rule only applies to codeWindow requests",
            },
          };
        }

        if (!this.config.requireIdentifiers) {
          return {
            passed: true,
            evidence: {
              type: "identifiers-not-required",
              value: null,
              reason: "Identifiers not required by policy",
            },
          };
        }

        if (!ctx.identifiersToFind || ctx.identifiersToFind.length === 0) {
          return {
            passed: false,
            evidence: {
              type: "missing-identifiers",
              value: null,
              reason: "No identifiers provided, but required by policy",
            },
            downgradeTo: "skeleton",
          };
        }

        return {
          passed: true,
          evidence: {
            type: "identifiers-provided",
            value: {
              count: ctx.identifiersToFind.length,
              identifiers: ctx.identifiersToFind.slice(0, 5),
            },
            reason: `Provided ${ctx.identifiersToFind.length} identifiers`,
          },
        };
      },
    });

    this.addRule({
      name: "budget-caps",
      enabled: true,
      priority: RULE_PRIORITY.BUDGET_CAPS,
      evaluate: (ctx) => {
        if (ctx.requestType !== "graphSlice" || !ctx.budget) {
          return {
            passed: true,
            evidence: {
              type: "check-skipped",
              value: null,
              reason: "Rule only applies to graphSlice with budget",
            },
          };
        }

        const failed: PolicyEvidence[] = [];

        if (
          ctx.budget.maxCards &&
          ctx.budget.maxCards > this.config.budgetCaps.maxCards
        ) {
          failed.push({
            type: "max-cards-exceeded",
            value: {
              requested: ctx.budget.maxCards,
              limit: this.config.budgetCaps.maxCards,
            },
            reason: `Requested cards (${ctx.budget.maxCards}) exceed maximum (${this.config.budgetCaps.maxCards})`,
          });
        }

        if (
          ctx.budget.maxEstimatedTokens &&
          ctx.budget.maxEstimatedTokens >
            this.config.budgetCaps.maxEstimatedTokens
        ) {
          failed.push({
            type: "max-tokens-budget-exceeded",
            value: {
              requested: ctx.budget.maxEstimatedTokens,
              limit: this.config.budgetCaps.maxEstimatedTokens,
            },
            reason: `Requested tokens (${ctx.budget.maxEstimatedTokens}) exceed maximum (${this.config.budgetCaps.maxEstimatedTokens})`,
          });
        }

        if (failed.length > 0) {
          return {
            passed: false,
            evidence: failed[0],
          };
        }

        return {
          passed: true,
          evidence: {
            type: "budget-within-limits",
            value: {
              maxCards: this.config.budgetCaps.maxCards,
              maxEstimatedTokens: this.config.budgetCaps.maxEstimatedTokens,
            },
            reason: "Budget within caps",
          },
        };
      },
    });

    this.addRule({
      name: "break-glass",
      enabled: true,
      priority: RULE_PRIORITY.BREAK_GLASS,
      evaluate: (ctx) => {
        if (!this.config.allowBreakGlass) {
          return {
            passed: true,
            evidence: {
              type: "break-glass-disabled",
              value: null,
              reason: "Break glass not allowed by policy",
            },
          };
        }

        if (ctx.reason) {
          const reasonUpper = ctx.reason.toUpperCase();
          if (
            reasonUpper.includes("AUDIT") ||
            reasonUpper.includes("BREAK-GLASS")
          ) {
            return {
              passed: true,
              evidence: {
                type: "break-glass-triggered",
                value: { reason: ctx.reason },
                reason: "Break glass override triggered",
              },
            };
          }
        }

        return {
          passed: true,
          evidence: {
            type: "break-glass-not-triggered",
            value: null,
            reason: "No break glass override requested",
          },
        };
      },
    });

    this.addRule({
      name: "default-deny-raw",
      enabled: true,
      priority: RULE_PRIORITY.DEFAULT_DENY_RAW,
      evaluate: (ctx) => {
        if (ctx.requestType !== "codeWindow") {
          return {
            passed: true,
            evidence: {
              type: "check-skipped",
              value: null,
              reason: "Rule only applies to codeWindow requests",
            },
          };
        }

        if (!this.config.defaultDenyRaw) {
          return {
            passed: true,
            evidence: {
              type: "default-allow-raw",
              value: null,
              reason: "Raw code access allowed by default",
            },
          };
        }

        if (
          ctx.sliceContext?.cards.some((c) => c.symbolId === ctx.symbolId) ||
          ctx.sliceContext?.frontier?.some((f) => f.symbolId === ctx.symbolId)
        ) {
          return {
            passed: true,
            evidence: {
              type: "in-slice-or-frontier",
              value: { symbolId: ctx.symbolId },
              reason: "Symbol is in slice or frontier",
            },
          };
        }

        const hasIdentifiers =
          ctx.identifiersToFind && ctx.identifiersToFind.length > 0;

        const downgradeTarget = hasIdentifiers ? "hotpath" : "skeleton";

        return {
          passed: false,
          evidence: {
            type: "default-deny-raw",
            value: {
              symbolId: ctx.symbolId,
              hasIdentifiers,
              suggestedDowngrade: downgradeTarget,
            },
            reason: `Raw code access denied by default policy - try ${downgradeTarget} instead`,
          },
          downgradeTo: downgradeTarget,
        };
      },
    });
  }

  addRule(rule: PolicyRule): void {
    this.rules.set(rule.name, rule);
  }

  removeRule(name: string): void {
    this.rules.delete(name);
  }

  getRule(name: string): PolicyRule | undefined {
    return this.rules.get(name);
  }

  evaluate(context: PolicyRequestContext): PolicyDecision {
    const evidence: PolicyEvidence[] = [];
    const deniedReasons: string[] = [];
    let downgradeTo: "skeleton" | "hotpath" | null = null;

    const sortedRules = Array.from(this.rules.values()).sort((a, b) => {
      const priorityDiff = b.priority - a.priority;
      if (priorityDiff !== 0) return priorityDiff;
      return a.name.localeCompare(b.name);
    });

    for (const rule of sortedRules) {
      if (!rule.enabled) continue;

      try {
        const result = rule.evaluate(context);
        evidence.push(result.evidence);

        if (!result.passed) {
          deniedReasons.push(result.evidence.reason);
          if (result.downgradeTo && !downgradeTo) {
            downgradeTo = result.downgradeTo;
          }
        }
      } catch (error) {
        logger.error(`Policy rule "${rule.name}" evaluation failed`, {
          error,
          context,
        });
        evidence.push({
          type: "rule-error",
          value: { ruleName: rule.name, error: String(error) },
          reason: `Rule "${rule.name}" failed to evaluate`,
        });
      }
    }

    let decision: PolicyDecision["decision"] = "approve";

    if (deniedReasons.length > 0) {
      if (downgradeTo === "skeleton") {
        decision = "downgrade-to-skeleton";
      } else if (downgradeTo === "hotpath") {
        decision = "downgrade-to-hotpath";
      } else {
        decision = "deny";
      }
    }

    const auditHash = generateAuditHash(decision, evidence, context);

    let downgradeTarget;
    if (downgradeTo && context.symbolId) {
      downgradeTarget = {
        type: downgradeTo,
        symbolId: context.symbolId,
        repoId: context.repoId,
      };
    }

    return {
      decision,
      evidenceUsed: evidence,
      auditHash,
      deniedReasons: deniedReasons.length > 0 ? deniedReasons : undefined,
      downgradeTarget,
    };
  }

  generateNextBestAction(
    decision: PolicyDecision,
    context: PolicyRequestContext,
  ): {
    nextBestAction?: NextBestAction;
    requiredFieldsForNext?: RequiredFieldsForNext;
  } {
    if (decision.decision === "approve") {
      return {};
    }

    const deniedReasons = decision.deniedReasons ?? [];
    let nextBestAction: NextBestAction = "retryWithSameInputs";
    const requiredFieldsForNext: RequiredFieldsForNext = {};

    const deniedReasonSet = new Set(deniedReasons);
    const deniedEvidence = decision.evidenceUsed.filter((e) =>
      deniedReasonSet.has(e.reason),
    );

    if (decision.decision === "downgrade-to-skeleton") {
      nextBestAction = "requestSkeleton";
      if (context.symbolId) {
        requiredFieldsForNext.requestSkeleton = {
          symbolId: context.symbolId,
          repoId: context.repoId,
        };
      }
    } else if (decision.decision === "downgrade-to-hotpath") {
      nextBestAction = "requestHotPath";
      if (context.symbolId) {
        requiredFieldsForNext.requestHotPath = {
          symbolId: context.symbolId,
          repoId: context.repoId,
          identifiersToFind: context.identifiersToFind ?? [],
          maxTokens: context.maxWindowTokens,
        };
      }
    } else {
      // Prefer evidence.type matching (deniedReasons contains evidence.reason strings).
      for (const ev of deniedEvidence) {
        if (ev.type === "missing-identifiers") {
          nextBestAction = "provideIdentifiersToFind";
          requiredFieldsForNext.provideIdentifiersToFind = {
            minCount: 1,
            examples: context.symbolData?.name
              ? [context.symbolData.name]
              : undefined,
          };
          break;
        }
        if (ev.type === "max-cards-exceeded") {
          nextBestAction = "narrowScope";
          requiredFieldsForNext.narrowScope = {
            field: "budget.maxCards",
            reason: `Requested maxCards exceeds policy cap (${this.config.budgetCaps.maxCards}). Reduce maxCards or narrow scope (more specific entrySymbols/taskText).`,
          };
          break;
        }
        if (ev.type === "max-tokens-budget-exceeded") {
          nextBestAction = "narrowScope";
          requiredFieldsForNext.narrowScope = {
            field: "budget.maxEstimatedTokens",
            reason: `Requested maxEstimatedTokens exceeds policy cap (${this.config.budgetCaps.maxEstimatedTokens}). Reduce maxEstimatedTokens or narrow scope (more specific entrySymbols/taskText).`,
          };
          break;
        }
      }

      // Fallback to substring matching for older/custom rules that don't set useful types.
      if (nextBestAction === "retryWithSameInputs") {
        for (const reason of deniedReasons) {
          if (reason.includes("missing identifiers")) {
            nextBestAction = "provideIdentifiersToFind";
            requiredFieldsForNext.provideIdentifiersToFind = {
              minCount: 1,
              examples: context.symbolData?.name
                ? [context.symbolData.name]
                : undefined,
            };
            break;
          }
          if (
            reason.includes("Requested cards") &&
            reason.includes("exceed maximum")
          ) {
            nextBestAction = "narrowScope";
            requiredFieldsForNext.narrowScope = {
              field: "budget.maxCards",
              reason: `Requested maxCards exceeds policy cap (${this.config.budgetCaps.maxCards}). Reduce maxCards or narrow scope (more specific entrySymbols/taskText).`,
            };
            break;
          }
          if (
            reason.includes("Requested tokens") &&
            reason.includes("exceed maximum")
          ) {
            nextBestAction = "narrowScope";
            requiredFieldsForNext.narrowScope = {
              field: "budget.maxEstimatedTokens",
              reason: `Requested maxEstimatedTokens exceeds policy cap (${this.config.budgetCaps.maxEstimatedTokens}). Reduce maxEstimatedTokens or narrow scope (more specific entrySymbols/taskText).`,
            };
            break;
          }
        }
      }
    }

    return {
      nextBestAction,
      requiredFieldsForNext,
    };
  }

  updateConfig(config: Partial<PolicyConfig>): void {
    this.config = { ...this.config, ...config };
  }

  getConfig(): PolicyConfig {
    return { ...this.config };
  }
}
