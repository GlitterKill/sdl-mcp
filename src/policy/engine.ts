import crypto from "crypto";
import type {
  PolicyRequestContext,
  PolicyDecision,
  PolicyRule,
  PolicyConfig,
  PolicyEvidence,
  RuntimePolicyRequestContext,
  RuntimePolicyDecision,
} from "./types.js";
import { DEFAULT_POLICY_CONFIG } from "./types.js";
import type { RuntimeConfig } from "../config/types.js";
import type { ConcurrencyTracker } from "../runtime/types.js";
import {
  isExecutableCompatibleWithRuntime,
  normalizeExecutableName,
} from "../runtime/runtimes.js";
import { logger } from "../util/logger.js";
import type { NextBestAction, RequiredFieldsForNext } from "../domain/types.js";
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
  RuntimePolicyRequestContext,
  RuntimePolicyDecision,
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
          const reasonTrimmed = ctx.reason.trim();
          if (reasonTrimmed.startsWith("BREAK-GLASS:")) {
            logger.warn("Break-glass override triggered", {
              repoId: ctx.repoId,
              symbolId: ctx.symbolId,
              reason: ctx.reason,
              requestType: ctx.requestType,
            });
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

    let breakGlassTriggered = false;

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

        // Track break-glass activation so it can override prior denials
        if (rule.name === "break-glass" && result.evidence.type === "break-glass-triggered") {
          breakGlassTriggered = true;
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

    // Break-glass override: clear all denials when triggered
    if (breakGlassTriggered && deniedReasons.length > 0) {
      logger.warn("Break-glass override clearing prior denials", {
        clearedReasons: deniedReasons,
        repoId: context.repoId,
        symbolId: context.symbolId,
      });
      deniedReasons.length = 0;
      downgradeTo = null;
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

  /**
   * Evaluate runtime execution policy.
   * Uses a separate rule chain from code-access policy — no downgrade targets.
   */
  evaluateRuntimePolicy(
    context: RuntimePolicyRequestContext,
    runtimeConfig: RuntimeConfig,
    concurrencyTracker?: ConcurrencyTracker,
  ): RuntimePolicyDecision {
    const evidence: PolicyEvidence[] = [];
    const deniedReasons: string[] = [];

    // Rule 1: runtime-enabled (priority 100)
    if (!runtimeConfig.enabled) {
      evidence.push({
        type: "runtime-disabled",
        value: null,
        reason:
          "Runtime execution is disabled in configuration (runtime.enabled = false)",
      });
      deniedReasons.push(
        "Runtime execution is disabled in configuration (runtime.enabled = false)",
      );
    } else {
      evidence.push({
        type: "runtime-enabled-check",
        value: null,
        reason: "Runtime execution is enabled",
      });
    }

    // Rule 2: runtime-allowed (priority 95)
    if (deniedReasons.length === 0) {
      const allowedRuntimes = runtimeConfig.allowedRuntimes;
      if (!allowedRuntimes.includes(context.runtime)) {
        evidence.push({
          type: "runtime-not-allowed",
          value: { runtime: context.runtime, allowed: allowedRuntimes },
          reason: `Runtime "${context.runtime}" is not in the allowed runtimes list: [${allowedRuntimes.join(", ")}]`,
        });
        deniedReasons.push(
          `Runtime "${context.runtime}" is not in the allowed runtimes list: [${allowedRuntimes.join(", ")}]`,
        );
      } else {
        evidence.push({
          type: "runtime-allowed-check",
          value: { runtime: context.runtime },
          reason: `Runtime "${context.runtime}" is allowed`,
        });
      }

      if (!isExecutableCompatibleWithRuntime(context.runtime, context.executable)) {
        evidence.push({
          type: "runtime-executable-mismatch",
          value: {
            runtime: context.runtime,
            executable: context.executable,
          },
          reason: `Executable "${context.executable}" is not compatible with runtime "${context.runtime}"`,
        });
        deniedReasons.push(
          `Executable "${context.executable}" is not compatible with runtime "${context.runtime}"`,
        );
      } else {
        evidence.push({
          type: "runtime-executable-check",
          value: {
            runtime: context.runtime,
            executable: context.executable,
          },
          reason: `Executable "${context.executable}" is compatible with runtime "${context.runtime}"`,
        });
      }

      // Check executable allowlist (if configured)
      if (
        deniedReasons.length === 0 &&
        runtimeConfig.allowedExecutables.length > 0
      ) {
        const requestedExecutable = normalizeExecutableName(context.executable);
        const allowedExecutables = new Set(
          runtimeConfig.allowedExecutables.map((executable) =>
            normalizeExecutableName(executable),
          ),
        );

        if (!allowedExecutables.has(requestedExecutable)) {
          evidence.push({
            type: "executable-not-allowed",
            value: {
              executable: context.executable,
              allowed: runtimeConfig.allowedExecutables,
            },
            reason: `Executable "${context.executable}" is not in the allowed executables list`,
          });
          deniedReasons.push(
            `Executable "${context.executable}" is not in the allowed executables list`,
          );
        } else {
          evidence.push({
            type: "executable-allowed-check",
            value: { executable: context.executable },
            reason: `Executable "${context.executable}" is allowed`,
          });
        }
      }
    }

    // Rule 3: cwd-scope (priority 90)
    // Note: actual path resolution + symlink checking is done by the executor.
    // This rule validates the relative cwd doesn't contain obvious escapes.
    if (deniedReasons.length === 0) {
      const cwd = context.relativeCwd;
      const hasTraversal =
        cwd.includes("..") || cwd.startsWith("/") || /^[A-Za-z]:/.test(cwd);
      if (hasTraversal) {
        evidence.push({
          type: "cwd-escape-attempt",
          value: { relativeCwd: cwd },
          reason: `Relative CWD "${cwd}" contains path traversal or absolute path components`,
        });
        deniedReasons.push(
          `Relative CWD "${cwd}" contains path traversal or absolute path components`,
        );
      } else {
        evidence.push({
          type: "cwd-scope-check",
          value: { relativeCwd: cwd },
          reason: "CWD is within repo scope",
        });
      }
    }

    // Rule 4: env-allowlist (priority 85)
    if (deniedReasons.length === 0 && context.envKeys.length > 0) {
      const configAllowlist = new Set(runtimeConfig.envAllowlist);
      const disallowed = context.envKeys.filter((k) => !configAllowlist.has(k));
      if (disallowed.length > 0) {
        evidence.push({
          type: "env-keys-not-allowed",
          value: { disallowed, allowed: runtimeConfig.envAllowlist },
          reason: `Environment variables not in allowlist: [${disallowed.join(", ")}]`,
        });
        deniedReasons.push(
          `Environment variables not in allowlist: [${disallowed.join(", ")}]`,
        );
      } else {
        evidence.push({
          type: "env-allowlist-check",
          value: { envKeys: context.envKeys },
          reason: "All requested env keys are in allowlist",
        });
      }
    }

    // Rule 5: timeout-cap (priority 80)
    if (deniedReasons.length === 0) {
      if (context.timeoutMs > runtimeConfig.maxDurationMs) {
        evidence.push({
          type: "timeout-exceeded",
          value: {
            requested: context.timeoutMs,
            limit: runtimeConfig.maxDurationMs,
          },
          reason: `Requested timeout (${context.timeoutMs}ms) exceeds maximum (${runtimeConfig.maxDurationMs}ms)`,
        });
        deniedReasons.push(
          `Requested timeout (${context.timeoutMs}ms) exceeds maximum (${runtimeConfig.maxDurationMs}ms)`,
        );
      } else {
        evidence.push({
          type: "timeout-cap-check",
          value: {
            timeoutMs: context.timeoutMs,
            maxDurationMs: runtimeConfig.maxDurationMs,
          },
          reason: "Timeout within limits",
        });
      }
    }

    // Rule 6: concurrency-cap (priority 70)
    if (deniedReasons.length === 0 && concurrencyTracker) {
      if (concurrencyTracker.activeCount >= runtimeConfig.maxConcurrentJobs) {
        evidence.push({
          type: "concurrency-limit-reached",
          value: {
            active: concurrencyTracker.activeCount,
            limit: runtimeConfig.maxConcurrentJobs,
          },
          reason: `Concurrency limit reached (${concurrencyTracker.activeCount}/${runtimeConfig.maxConcurrentJobs} active jobs)`,
        });
        deniedReasons.push(
          `Concurrency limit reached (${concurrencyTracker.activeCount}/${runtimeConfig.maxConcurrentJobs} active jobs)`,
        );
      } else {
        evidence.push({
          type: "concurrency-cap-check",
          value: {
            active: concurrencyTracker.activeCount,
            limit: runtimeConfig.maxConcurrentJobs,
          },
          reason: "Within concurrency limits",
        });
      }
    }

    const decision: "approve" | "deny" =
      deniedReasons.length > 0 ? "deny" : "approve";

    const auditHash = generateAuditHash(decision, evidence, {
      requestType: "runtimeExecute",
      repoId: context.repoId,
    } as PolicyRequestContext);

    return {
      decision,
      evidenceUsed: evidence,
      auditHash,
      deniedReasons: deniedReasons.length > 0 ? deniedReasons : undefined,
    };
  }

  updateConfig(config: Partial<PolicyConfig>): void {
    this.config = { ...this.config, ...config };
  }

  getConfig(): PolicyConfig {
    return { ...this.config };
  }
}
