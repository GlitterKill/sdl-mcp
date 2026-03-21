/**
 * savings-meter.ts — Visual token savings meter and summary formatters.
 *
 * Renders portable Unicode meters (█/░) for token savings display.
 * No ANSI escape codes — works in all MCP clients (Claude Code, Codex,
 * Gemini CLI, OpenCode, etc.).
 */

import type {
  SessionUsageSnapshot,
  ToolUsageEntry,
} from "./token-accumulator.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FILLED = "\u2588"; // █ FULL BLOCK
const EMPTY = "\u2591"; // ░ LIGHT SHADE
const SECTIONS = 10;
const BORDER = "\u2500"; // ─ BOX DRAWINGS LIGHT HORIZONTAL
const PIPE = "\u2502"; // │ BOX DRAWINGS LIGHT VERTICAL

// ---------------------------------------------------------------------------
// Aggregate usage shape (mirrors getAggregateUsage return)
// ---------------------------------------------------------------------------

export interface AggregateUsage {
  totalSdlTokens: number;
  totalRawEquivalent: number;
  totalSavedTokens: number;
  overallSavingsPercent: number;
  totalCalls: number;
  sessionCount: number;
}

// ---------------------------------------------------------------------------
// Core formatters
// ---------------------------------------------------------------------------

/**
 * Render a 10-section meter bar from a savings percentage.
 *
 * Fill rule: if percent >= 10, drop the ones digit to get fill count.
 * If percent < 10, fill 0.  Clamps to [0, 10].
 */
export function renderMeter(savingsPercent: number): string {
  const clamped = Math.max(0, Math.min(100, savingsPercent));
  const filled = clamped >= 100 ? SECTIONS : Math.floor(clamped / 10);
  return FILLED.repeat(filled) + EMPTY.repeat(SECTIONS - filled);
}

/**
 * Format a token count for human readability.
 * - < 1000: raw number ("999")
 * - >= 1000 and < 1M: one decimal + "k" ("1.2k", "65.0k")
 * - >= 1M: two decimals + "M" ("1.08M")
 */
export function formatTokenCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/**
 * Render the per-operation meter string: bar + percentage.
 * Example: "█████████░ 98%"
 */
export function renderOperationMeter(savingsPercent: number): string {
  const clamped = Math.max(0, Math.min(100, savingsPercent));
  return `${renderMeter(clamped)} ${clamped}%`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip the "sdl." prefix from tool names for compact display. */
function shortToolName(tool: string): string {
  return tool.startsWith("sdl.") ? tool.slice(4) : tool;
}

/** Compute per-tool savings percent from a ToolUsageEntry. */
function toolSavingsPercent(entry: ToolUsageEntry): number {
  if (entry.rawEquivalent <= 0 || entry.savedTokens <= 0) return 0;
  return Math.round((entry.savedTokens / entry.rawEquivalent) * 100);
}

/** Render a tool breakdown table (shared by task and session summaries). */
function renderToolRows(
  entries: ToolUsageEntry[],
  maxNameLen: number,
): string[] {
  const sorted = [...entries].sort((a, b) => b.savedTokens - a.savedTokens);
  const lines: string[] = [];
  for (const entry of sorted) {
    const name = shortToolName(entry.tool).padEnd(maxNameLen);
    const pct = toolSavingsPercent(entry);
    const meter = renderMeter(pct);
    const pctStr = String(pct).padStart(2) + "%";
    const calls = String(entry.callCount).padStart(3) + " calls";
    const saved = formatTokenCount(entry.savedTokens).padStart(6) + " saved";
    lines.push(`  ${name}  ${meter} ${pctStr} ${PIPE} ${calls} ${PIPE} ${saved}`);
  }
  return lines;
}

/** Compute max tool name width across one or more entry arrays. */
function maxToolNameWidth(...arrays: ToolUsageEntry[][]): number {
  let max = 0;
  for (const arr of arrays) {
    for (const e of arr) {
      max = Math.max(max, shortToolName(e.tool).length);
    }
  }
  return max;
}

// ---------------------------------------------------------------------------
// Summary renderers
// ---------------------------------------------------------------------------

/**
 * Render the end-of-session summary with both session and lifetime sections.
 */
export function renderSessionSummary(
  session: SessionUsageSnapshot,
  lifetime: AggregateUsage,
  lifetimeToolBreakdown: ToolUsageEntry[],
): string {
  const headerLine = `${BORDER.repeat(2)} Token Savings ${BORDER.repeat(30)}`;
  const footerLine = BORDER.repeat(47);

  const overallMeter = renderMeter(session.overallSavingsPercent);
  const savedStr = formatTokenCount(session.totalSavedTokens);

  const nameWidth = maxToolNameWidth(
    session.toolBreakdown,
    lifetimeToolBreakdown,
  );

  const lines: string[] = [
    headerLine,
    `Session: ${session.callCount} calls ${PIPE} ${savedStr} saved ${PIPE} ${overallMeter} ${session.overallSavingsPercent}%`,
    "",
  ];

  lines.push(...renderToolRows(session.toolBreakdown, nameWidth));

  // --- Lifetime section (skip when no data, e.g. DB unavailable) ---
  if (lifetime.totalCalls > 0 || lifetime.sessionCount > 0) {
    const ltMeter = renderMeter(lifetime.overallSavingsPercent);
    const ltSaved = formatTokenCount(lifetime.totalSavedTokens);

    lines.push("");
    lines.push(
      `Lifetime: ${lifetime.totalCalls} calls ${PIPE} ${lifetime.sessionCount} sessions ${PIPE} ${ltSaved} saved ${PIPE} ${ltMeter} ${lifetime.overallSavingsPercent}%`,
    );

    if (lifetimeToolBreakdown.length > 0) {
      lines.push("");
      lines.push(...renderToolRows(lifetimeToolBreakdown, nameWidth));
    }
  }

  lines.push(footerLine);
  return lines.join("\n");
}

/**
 * Render a lifetime-only summary (history scope, no current session).
 */
export function renderLifetimeSummary(
  lifetime: AggregateUsage,
  lifetimeToolBreakdown: ToolUsageEntry[],
): string {
  const headerLine = `${BORDER.repeat(2)} Token Savings ${BORDER.repeat(18)}`;
  const footerLine = BORDER.repeat(35);

  const ltMeter = renderMeter(lifetime.overallSavingsPercent);
  const ltSaved = formatTokenCount(lifetime.totalSavedTokens);

  const lines: string[] = [
    headerLine,
    `Lifetime: ${lifetime.totalCalls} calls ${PIPE} ${lifetime.sessionCount} sessions ${PIPE} ${ltSaved} saved ${PIPE} ${ltMeter} ${lifetime.overallSavingsPercent}%`,
    "",
  ];

  if (lifetimeToolBreakdown.length > 0) {
    const nameWidth = maxToolNameWidth(lifetimeToolBreakdown);
    lines.push(...renderToolRows(lifetimeToolBreakdown, nameWidth));
  }

  lines.push(footerLine);
  return lines.join("\n");
}

/**
 * Render a compact savings meter for a single tool call notification.
 * Example: "████████░░ 84%"
 */
export function renderUserNotificationLine(
  totalSdlTokens: number,
  totalRawEquivalent: number,
): string {
  const saved = Math.max(0, totalRawEquivalent - totalSdlTokens);
  const pct = totalRawEquivalent > 0
    ? Math.round((saved / totalRawEquivalent) * 100)
    : 0;
  return `${renderMeter(pct)} ${pct}%`;
}
