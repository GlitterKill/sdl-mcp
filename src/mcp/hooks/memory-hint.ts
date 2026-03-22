/**
 * memory-hint.ts - Post-dispatch hook that detects patterns worth remembering
 * and appends _memoryHint to tool responses.
 */
import type { PostDispatchHook, ToolContext } from "../../server.js";

interface ToolCallRecord {
  tool: string;
  timestamp: number;
}

interface SessionTracker {
  calls: ToolCallRecord[];
  hintsSent: Set<string>;
}

const sessions = new Map<string, SessionTracker>();

const MAX_TRACKED_SESSIONS = 64;

function getSession(sessionId: string): SessionTracker {
  // Evict oldest session if at capacity before creating new ones
  if (!sessions.has(sessionId) && sessions.size >= MAX_TRACKED_SESSIONS) {
    const oldest = sessions.keys().next().value;
    if (oldest) sessions.delete(oldest);
  }
  let session = sessions.get(sessionId);
  if (!session) {
    session = { calls: [], hintsSent: new Set() };
    sessions.set(sessionId, session);
  }
  return session;
}

interface MemoryHint {
  suggestedType: "decision" | "bugfix" | "task_context";
  message: string;
  pattern: string;
}

function detectPatterns(session: SessionTracker, toolName: string, args: unknown): MemoryHint | null {
  const recentCalls = session.calls.filter(
    (c) => Date.now() - c.timestamp < 30 * 60 * 1000, // last 30 minutes
  );

  // Pattern: 3+ code.needWindow calls -> deep debugging session
  const needWindowCount = recentCalls.filter(
    (c) => c.tool === "sdl.code.needWindow",
  ).length;
  if (needWindowCount >= 3 && !session.hintsSent.has("deep_debugging")) {
    session.hintsSent.add("deep_debugging");
    return {
      suggestedType: "bugfix",
      message:
        "Deep debugging session detected (3+ code window requests). Consider storing findings via sdl.memory.store — capture root cause, investigation path, and resolution.",
      pattern: "deep_debugging",
    };
  }

  // Pattern: delta.get or pr.risk.analyze -> code review
  if (
    (toolName === "sdl.delta.get" || toolName === "sdl.pr.risk.analyze") &&
    !session.hintsSent.has("code_review")
  ) {
    session.hintsSent.add("code_review");
    return {
      suggestedType: "task_context",
      message:
        "Code review activity detected. Consider capturing noteworthy findings, deferred work, or TODOs via sdl.memory.store.",
      pattern: "code_review",
    };
  }

  // Pattern: agent.orchestrate with implement task completes
  if (toolName === "sdl.agent.orchestrate" && !session.hintsSent.has("feature_complete")) {
    const orchestrateArgs = args as Record<string, unknown> | null;
    if (orchestrateArgs?.taskType === "implement") {
      session.hintsSent.add("feature_complete");
      return {
        suggestedType: "decision",
        message:
          "Feature implementation completed via orchestrate. Consider capturing architectural decisions and design trade-offs via sdl.memory.store.",
        pattern: "feature_complete",
      };
    }
  }

  // Pattern: agent.feedback with missingSymbols
  if (toolName === "sdl.agent.feedback" && !session.hintsSent.has("missing_symbols")) {
    const feedbackArgs = args as Record<string, unknown> | null;
    if (feedbackArgs?.missingSymbols && Array.isArray(feedbackArgs.missingSymbols) && feedbackArgs.missingSymbols.length > 0) {
      session.hintsSent.add("missing_symbols");
      return {
        suggestedType: "bugfix",
        message:
          "Missing symbols reported in agent feedback. Consider storing context about what was needed and why via sdl.memory.store.",
        pattern: "missing_symbols",
      };
    }
  }

  return null;
}

/**
 * Creates the memory hint post-dispatch hook.
 */
export function createMemoryHintHook(): PostDispatchHook {
  return async (
    toolName: string,
    args: unknown,
    result: unknown,
    context: ToolContext,
  ): Promise<void> => {
    const sessionId = context.sessionId ?? "stdio";
    const session = getSession(sessionId);

    // Record this call first
    session.calls.push({ tool: toolName, timestamp: Date.now() });

    // Prune entries older than 30 minutes
    const cutoff = Date.now() - 30 * 60 * 1000;
    session.calls = session.calls.filter((c) => c.timestamp >= cutoff);

    // Evict stale sessions with no recent calls
    if (session.calls.length === 0) {
      sessions.delete(sessionId);
      return;
    }

    // Check for index.refresh with large changes (uses result, not args)
    if (
      toolName === "sdl.index.refresh" &&
      !session.hintsSent.has("large_change") &&
      result &&
      typeof result === "object"
    ) {
      const r = result as Record<string, unknown>;
      if (typeof r.changedFiles === "number" && r.changedFiles > 10) {
        session.hintsSent.add("large_change");
        (r)._memoryHint = {
          suggestedType: "task_context",
          message: `Large code change indexed (${r.changedFiles} files). Consider storing context about the changes via sdl.memory.store.`,
          pattern: "large_change",
        };
        return;
      }
    }

    // Detect patterns from call history
    const hint = detectPatterns(session, toolName, args);
    if (hint && result && typeof result === "object") {
      (result as Record<string, unknown>)._memoryHint = hint;
    }
  };
}
