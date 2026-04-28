/**
 * token-accumulator.ts — In-memory session-level token usage accumulator
 *
 * Tracks cumulative SDL token usage vs raw-file equivalents across all tool
 * calls within a server session.  Singleton instance is created at module
 * load; the server dispatch loop calls `recordUsage()` after every tool
 * response that carries `_tokenUsage` metadata.
 */

import * as crypto from "crypto";
import { getCurrentTimestamp } from "../util/time.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolUsageEntry {
  tool: string;
  sdlTokens: number;
  rawEquivalent: number;
  savedTokens: number;
  callCount: number;
}

export interface PackedEncoderUsage {
  count: number;
  bytesSaved: number;
  avgRatio: number;
}

export interface SessionUsageSnapshot {
  sessionId: string;
  startedAt: string;
  totalSdlTokens: number;
  totalRawEquivalent: number;
  totalSavedTokens: number;
  overallSavingsPercent: number;
  toolBreakdown: ToolUsageEntry[];
  callCount: number;
  packedEncodings?: number;
  packedFallbacks?: number;
  packedBytesSaved?: number;
  packedByEncoder?: Record<string, PackedEncoderUsage>;
}

// ---------------------------------------------------------------------------
// Accumulator
// ---------------------------------------------------------------------------

export class TokenAccumulator {
  private readonly sessionId: string;
  private readonly startedAt: string;
  private readonly byTool = new Map<string, ToolUsageEntry>();
  private totalSdlTokens = 0;
  private totalRawEquivalent = 0;
  private totalCallCount = 0;
  private packedEncodings = 0;
  private packedFallbacks = 0;
  private packedBytesSaved = 0;
  private readonly packedByEncoder = new Map<string, PackedEncoderUsage>();

  constructor() {
    this.sessionId = `session_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
    this.startedAt = getCurrentTimestamp();
  }

  /**
   * Record a single tool call's token usage.
   */
  recordUsage(toolName: string, sdlTokens: number, rawEquivalent: number): void {
    const saved = Math.max(0, rawEquivalent - sdlTokens);

    this.totalSdlTokens += sdlTokens;
    this.totalRawEquivalent += rawEquivalent;
    this.totalCallCount += 1;

    const existing = this.byTool.get(toolName);
    if (existing) {
      existing.sdlTokens += sdlTokens;
      existing.rawEquivalent += rawEquivalent;
      existing.savedTokens += saved;
      existing.callCount += 1;
    } else {
      this.byTool.set(toolName, {
        tool: toolName,
        sdlTokens,
        rawEquivalent,
        savedTokens: saved,
        callCount: 1,
      });
    }
  }

  /**
   * Return a point-in-time snapshot of cumulative usage.
   */
  getSnapshot(): SessionUsageSnapshot {
    const totalSaved = Math.max(0, this.totalRawEquivalent - this.totalSdlTokens);
    const savingsPercent =
      this.totalRawEquivalent > 0
        ? Math.round((totalSaved / this.totalRawEquivalent) * 100)
        : 0;

    // Sort breakdown by savedTokens descending
    const toolBreakdown = [...this.byTool.values()].sort(
      (a, b) => b.savedTokens - a.savedTokens,
    );

    const packedByEncoder: Record<string, PackedEncoderUsage> = {};
    for (const [k, v] of this.packedByEncoder) {
      packedByEncoder[k] = { ...v };
    }

    return {
      sessionId: this.sessionId,
      startedAt: this.startedAt,
      totalSdlTokens: this.totalSdlTokens,
      totalRawEquivalent: this.totalRawEquivalent,
      totalSavedTokens: totalSaved,
      overallSavingsPercent: savingsPercent,
      toolBreakdown,
      callCount: this.totalCallCount,
      packedEncodings: this.packedEncodings,
      packedFallbacks: this.packedFallbacks,
      packedBytesSaved: this.packedBytesSaved,
      packedByEncoder,
    };
  }

  /**
   * Reset all counters (useful for testing).
   */
  /**
   * Record a packed-encoding event. `gateDecision` is "packed" when the
   * encoder won the gate, "fallback" when JSON was emitted instead.
   */
  recordPackedUsage(
    encoderId: string,
    jsonBytes: number,
    packedBytes: number,
    gateDecision: "packed" | "fallback",
  ): void {
    if (gateDecision === "packed") {
      this.packedEncodings += 1;
      const saved = Math.max(0, jsonBytes - packedBytes);
      this.packedBytesSaved += saved;
      const ratio = jsonBytes > 0 ? saved / jsonBytes : 0;
      const existing = this.packedByEncoder.get(encoderId);
      if (existing) {
        const totalCount = existing.count + 1;
        existing.bytesSaved += saved;
        existing.avgRatio =
          (existing.avgRatio * existing.count + ratio) / totalCount;
        existing.count = totalCount;
      } else {
        this.packedByEncoder.set(encoderId, {
          count: 1,
          bytesSaved: saved,
          avgRatio: ratio,
        });
      }
    } else {
      this.packedFallbacks += 1;
    }
  }

  reset(): void {
    this.byTool.clear();
    this.totalSdlTokens = 0;
    this.totalRawEquivalent = 0;
    this.totalCallCount = 0;
    this.packedEncodings = 0;
    this.packedFallbacks = 0;
    this.packedBytesSaved = 0;
    this.packedByEncoder.clear();
  }

  /**
   * Whether any usage has been recorded.
   */
  get hasUsage(): boolean {
    return this.totalCallCount > 0;
  }
}

/** Module-level singleton — one per server process. */
export const tokenAccumulator = new TokenAccumulator();
