# Token Savings Meter Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a visual token savings meter to SDL-MCP tool responses, with per-operation inline meters, end-of-task summaries, and end-of-session summaries including lifetime totals — all using portable Unicode rendering compatible with Claude Code CLI, Claude app, Codex CLI/app, Gemini CLI/Antigravity, and OpenCode CLI/app.

**Architecture:** Pure formatting/presentation layer built on top of existing `TokenAccumulator`, `_tokenUsage` metadata, and `ladybug-usage.ts` persistence. New `savings-meter.ts` module provides all rendering functions. Meter data is added to existing `_tokenUsage` fields and `sdl.usage.stats` responses. No ANSI escape codes — Unicode block characters only for maximum cross-client compatibility.

**Tech Stack:** TypeScript, Node.js `node:test`, Unicode block characters (U+2588 `█`, U+2591 `░`)

---

## Design Decisions

### Meter Rendering

10-section horizontal bar. Each section = 10% savings.

**Fill rule** (per user spec):
- If `savingsPercent` is 2 digits (10–99): drop the second digit → that's the fill count
- If `savingsPercent` < 10: fill 0 sections
- If `savingsPercent` = 100: fill all 10 sections

Examples:
- `94%` → drop `4` → `9` filled: `█████████░`
- `7%` → `< 10` → `0` filled: `░░░░░░░░░░`
- `50%` → drop `0` → `5` filled: `█████░░░░░`
- `100%` → `10` filled: `██████████`
- `0%` → `0` filled: `░░░░░░░░░░`

**Characters:**
- Filled: `█` (U+2588 FULL BLOCK) — renders in terminal default font color
- Empty: `░` (U+2591 LIGHT SHADE) — naturally appears as dark grey in all terminals

No ANSI escape codes. Pure Unicode ensures compatibility across Claude Code CLI, Claude app (web), Codex CLI/app, Gemini CLI/Antigravity, OpenCode CLI/app, and any future MCP client.

### Where Meters Appear

1. **Per-operation**: Added as `meter` string field inside `_tokenUsage` on every tool response
2. **End-of-task summary**: Formatted text in `sdl.usage.stats` response (`scope: "session"`)
3. **End-of-session summary**: Formatted text in `sdl.usage.stats` response (`scope: "both"`) with lifetime breakdown

### Sample Outputs for Approval

#### Per-Operation Meter (inline with every tool response)

Appears as a new `meter` field inside the existing `_tokenUsage` JSON:

```json
"_tokenUsage": {
  "sdlTokens": 329,
  "rawEquivalent": 15453,
  "savingsPercent": 98,
  "meter": "██████████ 98%"
}
```

Low-savings example:
```json
"_tokenUsage": {
  "sdlTokens": 705,
  "rawEquivalent": 643,
  "savingsPercent": 0,
  "meter": "░░░░░░░░░░ 0%"
}
```

#### End-of-Task Summary (`sdl.usage.stats` with `scope: "session"`)

```
── Token Savings ──────────────────
Session: 47 calls │ 76.7k saved │ ████████░░ 86%

  symbol.search     ██████████ 98% │ 18 calls │   1.2k saved
  symbol.getCard    █████░░░░░ 51% │  9 calls │   2.4k saved
  slice.build       ██████████ 95% │  8 calls │  65.0k saved
  code.getSkeleton  ███░░░░░░░ 30% │  6 calls │   3.1k saved
  code.getHotPath   ████████░░ 81% │  4 calls │   4.5k saved
  code.needWindow   ██░░░░░░░░ 20% │  2 calls │   0.5k saved
───────────────────────────────────
```

#### End-of-Session Summary (`sdl.usage.stats` with `scope: "both"`)

```
── Token Savings ─────────────────────────────
Session: 47 calls │ 76.7k saved │ ████████░░ 86%

  symbol.search     ██████████ 98% │ 18 calls │   1.2k saved
  symbol.getCard    █████░░░░░ 51% │  9 calls │   2.4k saved
  slice.build       ██████████ 95% │  8 calls │  65.0k saved
  code.getSkeleton  ███░░░░░░░ 30% │  6 calls │   3.1k saved
  code.getHotPath   ████████░░ 81% │  4 calls │   4.5k saved
  code.needWindow   ██░░░░░░░░ 20% │  2 calls │   0.5k saved

Lifetime: 342 calls │ 28 sessions │ 1.08M saved │ █████████░ 87%

  slice.build       ██████████ 96% │  52 calls │ 820.0k saved
  code.getHotPath   ████████░░ 80% │  20 calls │  36.0k saved
  code.getSkeleton  ███░░░░░░░ 32% │  30 calls │  24.0k saved
  symbol.getCard    ██████░░░░ 55% │  48 calls │  18.0k saved
  symbol.search     ██████████ 98% │ 180 calls │  12.0k saved
  code.needWindow   ██░░░░░░░░ 15% │  12 calls │   4.0k saved
──────────────────────────────────────────────
```

Notes on summary formatting:
- Tool names drop the `sdl.` prefix for compactness
- Tools are sorted by saved tokens descending (most impactful first) in lifetime section
- Token counts use human-readable suffixes: `1.2k`, `65.0k`, `1.08M`
- Columns are right-aligned for readability
- Box-drawing line chars (`─`) for top/bottom borders

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `src/mcp/savings-meter.ts` | All formatting: meter bar, operation meter, task summary, session summary, token count formatting |
| `tests/unit/savings-meter.test.ts` | Tests for all formatting functions |

### Modified Files
| File | Change |
|------|--------|
| `src/mcp/token-usage.ts` | Add `meter` field to `TokenUsageMetadata` interface |
| `src/server.ts` | Attach `meter` string to `_tokenUsage` after computing savings |
| `src/mcp/tools/usage.ts` | Add `formattedSummary` to `handleUsageStats` response |
| `src/mcp/tools.ts` | Update `UsageStatsResponseSchema` + `TokenUsageMetadata` schema to include `meter`/`formattedSummary` |
| `src/db/ladybug-usage.ts` | Add `getLifetimeToolBreakdown()` function for per-tool lifetime aggregation |
| `tests/unit/token-usage.test.ts` | Add test for `meter` field presence |

---

## Chunk 1: Core Formatting Module

### Task 1: Create `savings-meter.ts` with `renderMeter()`

**Files:**
- Create: `src/mcp/savings-meter.ts`
- Test: `tests/unit/savings-meter.test.ts`

- [ ] **Step 1: Write the failing test for `renderMeter`**

```typescript
// tests/unit/savings-meter.test.ts
import { describe, it } from "node:test";
import assert from "node:assert";
import { renderMeter } from "../../src/mcp/savings-meter.js";

describe("savings-meter", () => {
  describe("renderMeter", () => {
    it("fills 9 sections for 94%", () => {
      assert.strictEqual(renderMeter(94), "█████████░");
    });

    it("fills 0 sections for 7% (less than 10)", () => {
      assert.strictEqual(renderMeter(7), "░░░░░░░░░░");
    });

    it("fills 5 sections for 50%", () => {
      assert.strictEqual(renderMeter(50), "█████░░░░░");
    });

    it("fills all 10 sections for 100%", () => {
      assert.strictEqual(renderMeter(100), "██████████");
    });

    it("fills 0 sections for 0%", () => {
      assert.strictEqual(renderMeter(0), "░░░░░░░░░░");
    });

    it("fills 1 section for 10%", () => {
      assert.strictEqual(renderMeter(10), "█░░░░░░░░░");
    });

    it("fills 9 sections for 99%", () => {
      assert.strictEqual(renderMeter(99), "█████████░");
    });

    it("fills 0 sections for 9%", () => {
      assert.strictEqual(renderMeter(9), "░░░░░░░░░░");
    });

    it("clamps negative to 0", () => {
      assert.strictEqual(renderMeter(-5), "░░░░░░░░░░");
    });

    it("clamps above 100 to 10", () => {
      assert.strictEqual(renderMeter(105), "██████████");
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test tests/unit/savings-meter.test.ts`
Expected: FAIL — module `../../src/mcp/savings-meter.js` not found

- [ ] **Step 3: Write minimal implementation of `renderMeter`**

```typescript
// src/mcp/savings-meter.ts

/**
 * savings-meter.ts — Visual token savings meter and summary formatters.
 *
 * Renders portable Unicode meters (█/░) for token savings display.
 * No ANSI escape codes — works in all MCP clients.
 */

const FILLED = "\u2588"; // █ FULL BLOCK
const EMPTY = "\u2591";  // ░ LIGHT SHADE
const SECTIONS = 10;

/**
 * Render a 10-section meter bar from a savings percentage.
 *
 * Fill rule: if percent >= 10, drop the ones digit to get fill count.
 * If percent < 10, fill 0. Clamps to [0, 10].
 */
export function renderMeter(savingsPercent: number): string {
  const clamped = Math.max(0, Math.min(100, savingsPercent));
  const filled = clamped >= 100 ? SECTIONS : Math.floor(clamped / 10);
  return FILLED.repeat(filled) + EMPTY.repeat(SECTIONS - filled);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test tests/unit/savings-meter.test.ts`
Expected: PASS — all `renderMeter` tests green

- [ ] **Step 5: Commit**

```bash
git add src/mcp/savings-meter.ts tests/unit/savings-meter.test.ts
git commit -m "feat: add renderMeter for token savings visualization"
```

---

### Task 2: Add `formatTokenCount()` helper

**Files:**
- Modify: `src/mcp/savings-meter.ts`
- Modify: `tests/unit/savings-meter.test.ts`

- [ ] **Step 1: Write the failing tests for `formatTokenCount`**

Add to `tests/unit/savings-meter.test.ts`:

```typescript
import { renderMeter, formatTokenCount } from "../../src/mcp/savings-meter.js";

// ... existing tests ...

describe("formatTokenCount", () => {
  it("formats small numbers as-is", () => {
    assert.strictEqual(formatTokenCount(0), "0");
    assert.strictEqual(formatTokenCount(999), "999");
  });

  it("formats thousands with k suffix", () => {
    assert.strictEqual(formatTokenCount(1000), "1.0k");
    assert.strictEqual(formatTokenCount(1200), "1.2k");
    assert.strictEqual(formatTokenCount(65000), "65.0k");
    assert.strictEqual(formatTokenCount(76750), "76.7k");
  });

  it("formats millions with M suffix", () => {
    assert.strictEqual(formatTokenCount(1000000), "1.00M");
    assert.strictEqual(formatTokenCount(1084000), "1.08M");
    assert.strictEqual(formatTokenCount(1240000), "1.24M");
  });

  it("formats hundreds of thousands with k", () => {
    assert.strictEqual(formatTokenCount(820000), "820.0k");
    assert.strictEqual(formatTokenCount(156000), "156.0k");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test tests/unit/savings-meter.test.ts`
Expected: FAIL — `formatTokenCount` is not exported

- [ ] **Step 3: Implement `formatTokenCount`**

Add to `src/mcp/savings-meter.ts`:

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test tests/unit/savings-meter.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp/savings-meter.ts tests/unit/savings-meter.test.ts
git commit -m "feat: add formatTokenCount human-readable token formatter"
```

---

### Task 3: Add `renderOperationMeter()`

**Files:**
- Modify: `src/mcp/savings-meter.ts`
- Modify: `tests/unit/savings-meter.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/savings-meter.test.ts`:

```typescript
import {
  renderMeter,
  formatTokenCount,
  renderOperationMeter,
} from "../../src/mcp/savings-meter.js";

// ... existing tests ...

describe("renderOperationMeter", () => {
  it("renders meter with percentage for high savings", () => {
    assert.strictEqual(
      renderOperationMeter(98),
      "██████████ 98%",
    );
  });

  it("renders meter with percentage for zero savings", () => {
    assert.strictEqual(
      renderOperationMeter(0),
      "░░░░░░░░░░ 0%",
    );
  });

  it("renders meter with percentage for mid savings", () => {
    assert.strictEqual(
      renderOperationMeter(51),
      "█████░░░░░ 51%",
    );
  });

  it("renders meter for sub-10 savings", () => {
    assert.strictEqual(
      renderOperationMeter(7),
      "░░░░░░░░░░ 7%",
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test tests/unit/savings-meter.test.ts`
Expected: FAIL — `renderOperationMeter` is not exported

- [ ] **Step 3: Implement `renderOperationMeter`**

Add to `src/mcp/savings-meter.ts`:

```typescript
/**
 * Render the per-operation meter string: bar + percentage.
 * Example: "██████████ 98%"
 */
export function renderOperationMeter(savingsPercent: number): string {
  return `${renderMeter(savingsPercent)} ${savingsPercent}%`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test tests/unit/savings-meter.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp/savings-meter.ts tests/unit/savings-meter.test.ts
git commit -m "feat: add renderOperationMeter for per-tool-call display"
```

---

### Task 4: Add `renderTaskSummary()` (end-of-task)

**Files:**
- Modify: `src/mcp/savings-meter.ts`
- Modify: `tests/unit/savings-meter.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/savings-meter.test.ts`:

```typescript
import {
  renderMeter,
  formatTokenCount,
  renderOperationMeter,
  renderTaskSummary,
} from "../../src/mcp/savings-meter.js";
import type { SessionUsageSnapshot } from "../../src/mcp/token-accumulator.js";

// ... existing tests ...

describe("renderTaskSummary", () => {
  it("renders session summary with tool breakdown", () => {
    const snapshot: SessionUsageSnapshot = {
      sessionId: "test-session",
      startedAt: "2026-03-20T00:00:00Z",
      totalSdlTokens: 12450,
      totalRawEquivalent: 89200,
      totalSavedTokens: 76750,
      overallSavingsPercent: 86,
      callCount: 47,
      toolBreakdown: [
        { tool: "sdl.symbol.search", sdlTokens: 200, rawEquivalent: 1400, savedTokens: 1200, callCount: 18 },
        { tool: "sdl.slice.build", sdlTokens: 3000, rawEquivalent: 68000, savedTokens: 65000, callCount: 8 },
      ],
    };

    const result = renderTaskSummary(snapshot);

    // Should contain the header line
    assert.ok(result.includes("Token Savings"));
    // Should contain session totals
    assert.ok(result.includes("47 calls"));
    assert.ok(result.includes("76.7k saved"));
    // Should contain the overall meter
    assert.ok(result.includes("████████░░"));
    assert.ok(result.includes("86%"));
    // Should contain tool breakdown (without sdl. prefix)
    assert.ok(result.includes("symbol.search"));
    assert.ok(result.includes("slice.build"));
    // Should contain tool meters
    assert.ok(result.includes("1.2k saved"));
    assert.ok(result.includes("65.0k saved"));
  });

  it("renders empty summary when no calls", () => {
    const snapshot: SessionUsageSnapshot = {
      sessionId: "empty",
      startedAt: "2026-03-20T00:00:00Z",
      totalSdlTokens: 0,
      totalRawEquivalent: 0,
      totalSavedTokens: 0,
      overallSavingsPercent: 0,
      callCount: 0,
      toolBreakdown: [],
    };

    const result = renderTaskSummary(snapshot);
    assert.ok(result.includes("0 calls"));
    assert.ok(result.includes("░░░░░░░░░░"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test tests/unit/savings-meter.test.ts`
Expected: FAIL — `renderTaskSummary` is not exported

- [ ] **Step 3: Implement `renderTaskSummary`**

Add to `src/mcp/savings-meter.ts`:

```typescript
import type { SessionUsageSnapshot, ToolUsageEntry } from "./token-accumulator.js";

const BORDER_CHAR = "\u2500"; // ─ BOX DRAWINGS LIGHT HORIZONTAL

/**
 * Strip the "sdl." prefix from tool names for compact display.
 */
function shortToolName(tool: string): string {
  return tool.startsWith("sdl.") ? tool.slice(4) : tool;
}

/**
 * Compute per-tool savings percent from a ToolUsageEntry.
 */
function toolSavingsPercent(entry: ToolUsageEntry): number {
  if (entry.rawEquivalent <= 0 || entry.savedTokens <= 0) return 0;
  return Math.round((entry.savedTokens / entry.rawEquivalent) * 100);
}

/**
 * Render the end-of-task summary (session scope).
 */
export function renderTaskSummary(snapshot: SessionUsageSnapshot): string {
  const headerLine = `${BORDER_CHAR.repeat(2)} Token Savings ${BORDER_CHAR.repeat(18)}`;
  const footerLine = BORDER_CHAR.repeat(35);

  const overallMeter = renderMeter(snapshot.overallSavingsPercent);
  const savedStr = formatTokenCount(snapshot.totalSavedTokens);

  const lines: string[] = [
    headerLine,
    `Session: ${snapshot.callCount} calls \u2502 ${savedStr} saved \u2502 ${overallMeter} ${snapshot.overallSavingsPercent}%`,
    "",
  ];

  // Sort tools by saved tokens descending
  const sorted = [...snapshot.toolBreakdown].sort(
    (a, b) => b.savedTokens - a.savedTokens,
  );

  // Find max tool name width for alignment
  const maxNameLen = sorted.reduce(
    (max, e) => Math.max(max, shortToolName(e.tool).length),
    0,
  );

  for (const entry of sorted) {
    const name = shortToolName(entry.tool).padEnd(maxNameLen);
    const pct = toolSavingsPercent(entry);
    const meter = renderMeter(pct);
    const pctStr = String(pct).padStart(2) + "%";
    const calls = String(entry.callCount).padStart(3) + " calls";
    const saved = formatTokenCount(entry.savedTokens).padStart(6) + " saved";
    lines.push(`  ${name}  ${meter} ${pctStr} \u2502 ${calls} \u2502 ${saved}`);
  }

  lines.push(footerLine);
  return lines.join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test tests/unit/savings-meter.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp/savings-meter.ts tests/unit/savings-meter.test.ts
git commit -m "feat: add renderTaskSummary for end-of-task savings display"
```

---

### Task 5: Add `renderSessionSummary()` (end-of-session with lifetime)

**Files:**
- Modify: `src/mcp/savings-meter.ts`
- Modify: `tests/unit/savings-meter.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/savings-meter.test.ts`:

```typescript
import {
  renderMeter,
  formatTokenCount,
  renderOperationMeter,
  renderTaskSummary,
  renderSessionSummary,
} from "../../src/mcp/savings-meter.js";

// ... existing tests ...

describe("renderSessionSummary", () => {
  const session: SessionUsageSnapshot = {
    sessionId: "test",
    startedAt: "2026-03-20T00:00:00Z",
    totalSdlTokens: 12450,
    totalRawEquivalent: 89200,
    totalSavedTokens: 76750,
    overallSavingsPercent: 86,
    callCount: 47,
    toolBreakdown: [
      { tool: "sdl.symbol.search", sdlTokens: 200, rawEquivalent: 1400, savedTokens: 1200, callCount: 18 },
    ],
  };

  const lifetime = {
    totalSdlTokens: 156000,
    totalRawEquivalent: 1240000,
    totalSavedTokens: 1084000,
    overallSavingsPercent: 87,
    totalCalls: 342,
    sessionCount: 28,
  };

  const lifetimeTools: ToolUsageEntry[] = [
    { tool: "sdl.slice.build", sdlTokens: 30000, rawEquivalent: 850000, savedTokens: 820000, callCount: 52 },
    { tool: "sdl.symbol.search", sdlTokens: 2000, rawEquivalent: 14000, savedTokens: 12000, callCount: 180 },
  ];

  it("renders both session and lifetime sections", () => {
    const result = renderSessionSummary(session, lifetime, lifetimeTools);

    // Session section
    assert.ok(result.includes("Session:"));
    assert.ok(result.includes("47 calls"));

    // Lifetime section
    assert.ok(result.includes("Lifetime:"));
    assert.ok(result.includes("342 calls"));
    assert.ok(result.includes("28 sessions"));
    assert.ok(result.includes("1.08M saved"));
    assert.ok(result.includes("87%"));

    // Lifetime tool breakdown
    assert.ok(result.includes("slice.build"));
    assert.ok(result.includes("820.0k saved"));
  });

  it("renders without lifetime tools when empty", () => {
    const result = renderSessionSummary(session, lifetime, []);
    assert.ok(result.includes("Lifetime:"));
    assert.ok(!result.includes("slice.build"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test tests/unit/savings-meter.test.ts`
Expected: FAIL — `renderSessionSummary` is not exported

- [ ] **Step 3: Implement `renderSessionSummary`**

Add to `src/mcp/savings-meter.ts`:

```typescript
export interface AggregateUsage {
  totalSdlTokens: number;
  totalRawEquivalent: number;
  totalSavedTokens: number;
  overallSavingsPercent: number;
  totalCalls: number;
  sessionCount: number;
}

/**
 * Render the end-of-session summary with both session and lifetime sections.
 */
export function renderSessionSummary(
  session: SessionUsageSnapshot,
  lifetime: AggregateUsage,
  lifetimeToolBreakdown: ToolUsageEntry[],
): string {
  const headerLine = `${BORDER_CHAR.repeat(2)} Token Savings ${BORDER_CHAR.repeat(30)}`;
  const footerLine = BORDER_CHAR.repeat(47);

  // --- Session section (reuse task summary logic) ---
  const overallMeter = renderMeter(session.overallSavingsPercent);
  const savedStr = formatTokenCount(session.totalSavedTokens);

  const lines: string[] = [
    headerLine,
    `Session: ${session.callCount} calls \u2502 ${savedStr} saved \u2502 ${overallMeter} ${session.overallSavingsPercent}%`,
    "",
  ];

  const sessionSorted = [...session.toolBreakdown].sort(
    (a, b) => b.savedTokens - a.savedTokens,
  );

  const allTools = [...sessionSorted, ...lifetimeToolBreakdown];
  const maxNameLen = allTools.reduce(
    (max, e) => Math.max(max, shortToolName(e.tool).length),
    0,
  );

  for (const entry of sessionSorted) {
    const name = shortToolName(entry.tool).padEnd(maxNameLen);
    const pct = toolSavingsPercent(entry);
    const meter = renderMeter(pct);
    const pctStr = String(pct).padStart(2) + "%";
    const calls = String(entry.callCount).padStart(3) + " calls";
    const saved = formatTokenCount(entry.savedTokens).padStart(6) + " saved";
    lines.push(`  ${name}  ${meter} ${pctStr} \u2502 ${calls} \u2502 ${saved}`);
  }

  // --- Lifetime section ---
  const ltMeter = renderMeter(lifetime.overallSavingsPercent);
  const ltSaved = formatTokenCount(lifetime.totalSavedTokens);

  lines.push("");
  lines.push(
    `Lifetime: ${lifetime.totalCalls} calls \u2502 ${lifetime.sessionCount} sessions \u2502 ${ltSaved} saved \u2502 ${ltMeter} ${lifetime.overallSavingsPercent}%`,
  );

  if (lifetimeToolBreakdown.length > 0) {
    lines.push("");
    const ltSorted = [...lifetimeToolBreakdown].sort(
      (a, b) => b.savedTokens - a.savedTokens,
    );
    for (const entry of ltSorted) {
      const name = shortToolName(entry.tool).padEnd(maxNameLen);
      const pct = toolSavingsPercent(entry);
      const meter = renderMeter(pct);
      const pctStr = String(pct).padStart(2) + "%";
      const calls = String(entry.callCount).padStart(3) + " calls";
      const saved = formatTokenCount(entry.savedTokens).padStart(6) + " saved";
      lines.push(`  ${name}  ${meter} ${pctStr} \u2502 ${calls} \u2502 ${saved}`);
    }
  }

  lines.push(footerLine);
  return lines.join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test tests/unit/savings-meter.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp/savings-meter.ts tests/unit/savings-meter.test.ts
git commit -m "feat: add renderSessionSummary with lifetime breakdown"
```

---

## Chunk 2: Wire Meter Into Existing Infrastructure

### Task 6: Add `meter` field to `TokenUsageMetadata`

**Files:**
- Modify: `src/mcp/token-usage.ts:5-9` (TokenUsageMetadata interface)

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/token-usage.test.ts`:

```typescript
describe("computeTokenUsage includes meter", () => {
  it("includes meter string in result", async () => {
    const result = {
      data: "some content",
      _rawContext: { rawTokens: 5000 },
    };
    const usage = await computeTokenUsage(result as Record<string, unknown>);
    assert.ok(typeof usage.meter === "string");
    assert.ok(usage.meter.length > 0);
    // meter should be "bar percent%" format
    assert.match(usage.meter, /^[█░]{10} \d+%$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test tests/unit/token-usage.test.ts`
Expected: FAIL — `meter` property does not exist on result

- [ ] **Step 3: Update `TokenUsageMetadata` and `computeSavings`**

In `src/mcp/token-usage.ts`:

1. Add import at top:
```typescript
import { renderOperationMeter } from "./savings-meter.js";
```

2. Update the `TokenUsageMetadata` interface:
```typescript
export interface TokenUsageMetadata {
  sdlTokens: number;
  rawEquivalent: number;
  savingsPercent: number;
  meter: string;
}
```

3. Update `computeSavings` return to include meter:
```typescript
export function computeSavings(
  sdlTokens: number,
  rawEquivalent: number,
): TokenUsageMetadata {
  if (rawEquivalent <= 0 || sdlTokens >= rawEquivalent) {
    return {
      sdlTokens,
      rawEquivalent,
      savingsPercent: 0,
      meter: renderOperationMeter(0),
    };
  }
  const savingsPercent = Math.round(
    ((rawEquivalent - sdlTokens) / rawEquivalent) * 100,
  );
  return {
    sdlTokens,
    rawEquivalent,
    savingsPercent,
    meter: renderOperationMeter(savingsPercent),
  };
}
```

4. Update zero-return in `computeTokenUsage`:
```typescript
if (!hint) {
  return { sdlTokens: 0, rawEquivalent: 0, savingsPercent: 0, meter: renderOperationMeter(0) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test tests/unit/token-usage.test.ts`
Expected: PASS (all existing tests still pass since they don't assert absence of `meter`)

- [ ] **Step 5: Commit**

```bash
git add src/mcp/token-usage.ts tests/unit/token-usage.test.ts
git commit -m "feat: add meter field to TokenUsageMetadata"
```

---

### Task 7: Add `getLifetimeToolBreakdown()` to ladybug-usage

**Files:**
- Modify: `src/db/ladybug-usage.ts`
- Create: `tests/unit/ladybug-usage.test.ts` (or add to existing)

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/ladybug-usage-format.test.ts
import { describe, it } from "node:test";
import assert from "node:assert";
import { aggregateToolBreakdowns } from "../../src/db/ladybug-usage.js";

describe("aggregateToolBreakdowns", () => {
  it("aggregates tool entries from multiple snapshots", () => {
    const snapshots = [
      {
        toolBreakdownJson: JSON.stringify([
          { tool: "sdl.symbol.search", sdlTokens: 100, rawEquivalent: 700, savedTokens: 600, callCount: 5 },
          { tool: "sdl.slice.build", sdlTokens: 500, rawEquivalent: 10000, savedTokens: 9500, callCount: 3 },
        ]),
      },
      {
        toolBreakdownJson: JSON.stringify([
          { tool: "sdl.symbol.search", sdlTokens: 200, rawEquivalent: 1400, savedTokens: 1200, callCount: 10 },
        ]),
      },
    ];

    const result = aggregateToolBreakdowns(
      snapshots.map((s) => s.toolBreakdownJson),
    );

    assert.strictEqual(result.length, 2);

    const search = result.find((e) => e.tool === "sdl.symbol.search");
    assert.ok(search);
    assert.strictEqual(search.sdlTokens, 300);
    assert.strictEqual(search.rawEquivalent, 2100);
    assert.strictEqual(search.savedTokens, 1800);
    assert.strictEqual(search.callCount, 15);

    const slice = result.find((e) => e.tool === "sdl.slice.build");
    assert.ok(slice);
    assert.strictEqual(slice.savedTokens, 9500);
  });

  it("returns empty array for empty input", () => {
    assert.deepStrictEqual(aggregateToolBreakdowns([]), []);
  });

  it("handles malformed JSON gracefully", () => {
    const result = aggregateToolBreakdowns(["not-json", "[]"]);
    assert.deepStrictEqual(result, []);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test tests/unit/ladybug-usage-format.test.ts`
Expected: FAIL — `aggregateToolBreakdowns` is not exported

- [ ] **Step 3: Implement `aggregateToolBreakdowns`**

Add to `src/db/ladybug-usage.ts`:

```typescript
import { safeJsonParse } from "../util/safeJson.js";
import type { ToolUsageEntry } from "../mcp/token-accumulator.js";

/**
 * Aggregate tool breakdown entries from multiple snapshot JSON strings.
 * Returns a single array of ToolUsageEntry with totals per tool.
 * Pure function — no DB access.
 */
export function aggregateToolBreakdowns(
  toolBreakdownJsons: string[],
): ToolUsageEntry[] {
  const map = new Map<
    string,
    { sdl: number; raw: number; saved: number; calls: number }
  >();

  for (const json of toolBreakdownJsons) {
    const parsed = safeJsonParse<ToolUsageEntry[]>(json);
    if (!Array.isArray(parsed)) continue;

    for (const entry of parsed) {
      const existing = map.get(entry.tool);
      if (existing) {
        existing.sdl += entry.sdlTokens;
        existing.raw += entry.rawEquivalent;
        existing.saved += entry.savedTokens;
        existing.calls += entry.callCount;
      } else {
        map.set(entry.tool, {
          sdl: entry.sdlTokens,
          raw: entry.rawEquivalent,
          saved: entry.savedTokens,
          calls: entry.callCount,
        });
      }
    }
  }

  return Array.from(map.entries()).map(([tool, v]) => ({
    tool,
    sdlTokens: v.sdl,
    rawEquivalent: v.raw,
    savedTokens: v.saved,
    callCount: v.calls,
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test tests/unit/ladybug-usage-format.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/db/ladybug-usage.ts tests/unit/ladybug-usage-format.test.ts
git commit -m "feat: add aggregateToolBreakdowns for lifetime per-tool stats"
```

---

### Task 8: Add `formattedSummary` to `sdl.usage.stats` response

**Files:**
- Modify: `src/mcp/tools.ts:1964-1980` (UsageStatsResponseSchema)
- Modify: `src/mcp/tools/usage.ts`

- [ ] **Step 1: Update `UsageStatsResponseSchema`**

In `src/mcp/tools.ts`, add `formattedSummary` to the response schema:

```typescript
export const UsageStatsResponseSchema = z.object({
  session: SessionUsageSnapshotSchema.optional(),
  history: z
    .object({
      // ... existing fields ...
    })
    .optional(),
  formattedSummary: z.string().optional(),
});
```

- [ ] **Step 2: Write the failing test**

```typescript
// tests/unit/usage-stats-formatted.test.ts
import { describe, it } from "node:test";
import assert from "node:assert";

// This test validates that the formatted summary is wired correctly.
// Since handleUsageStats requires a running LadybugDB, we test the
// formatting integration at a higher level via the formatting functions.
import { renderTaskSummary, renderSessionSummary } from "../../src/mcp/savings-meter.js";
import type { SessionUsageSnapshot } from "../../src/mcp/token-accumulator.js";

describe("usage stats formatted summary integration", () => {
  it("renderTaskSummary produces valid multi-line output", () => {
    const snapshot: SessionUsageSnapshot = {
      sessionId: "s1",
      startedAt: "2026-01-01T00:00:00Z",
      totalSdlTokens: 500,
      totalRawEquivalent: 5000,
      totalSavedTokens: 4500,
      overallSavingsPercent: 90,
      callCount: 10,
      toolBreakdown: [
        { tool: "sdl.symbol.search", sdlTokens: 100, rawEquivalent: 1000, savedTokens: 900, callCount: 5 },
      ],
    };

    const summary = renderTaskSummary(snapshot);
    const lines = summary.split("\n");

    // Should have header, totals, blank, at least one tool, footer
    assert.ok(lines.length >= 5);
    // First line is header
    assert.ok(lines[0].includes("Token Savings"));
    // Last line is footer (all ─)
    assert.match(lines[lines.length - 1], /^─+$/);
  });
});
```

- [ ] **Step 3: Run test to verify it passes** (this tests existing formatter)

Run: `node --import tsx --test tests/unit/usage-stats-formatted.test.ts`
Expected: PASS (the formatter already exists from Task 4)

- [ ] **Step 4: Wire `formattedSummary` into `handleUsageStats`**

In `src/mcp/tools/usage.ts`, add imports and wiring:

```typescript
import {
  renderTaskSummary,
  renderSessionSummary,
  type AggregateUsage,
} from "../savings-meter.js";
import { aggregateToolBreakdowns } from "../../db/ladybug-usage.js";
```

At the end of `handleUsageStats`, before `return response`:

```typescript
  // Build formatted summary
  if (request.scope === "session" && response.session) {
    response.formattedSummary = renderTaskSummary(response.session);
  } else if (
    (request.scope === "history" || request.scope === "both") &&
    response.session &&
    response.history
  ) {
    const ltAggregate: AggregateUsage = {
      totalSdlTokens: response.history.totalSdlTokens,
      totalRawEquivalent: response.history.totalRawEquivalent,
      totalSavedTokens: response.history.totalSavedTokens,
      overallSavingsPercent: response.history.overallSavingsPercent,
      totalCalls: response.history.totalCalls,
      sessionCount: response.history.sessionCount,
    };

    // Aggregate per-tool lifetime breakdown from snapshots
    const conn = getLadybugConn();
    const snapshots = await getUsageSnapshots(conn, {
      repoId: request.repoId,
      limit: 1000,
    });
    const ltTools = aggregateToolBreakdowns(
      snapshots.map((s) => s.toolBreakdownJson),
    );

    response.formattedSummary = renderSessionSummary(
      response.session,
      ltAggregate,
      ltTools,
    );
  } else if (request.scope === "session" && response.session) {
    response.formattedSummary = renderTaskSummary(response.session);
  }
```

- [ ] **Step 5: Run all tests to verify nothing is broken**

Run: `node --import tsx --test tests/unit/token-usage.test.ts tests/unit/savings-meter.test.ts tests/unit/ladybug-usage-format.test.ts tests/unit/usage-stats-formatted.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools.ts src/mcp/tools/usage.ts tests/unit/usage-stats-formatted.test.ts
git commit -m "feat: wire formattedSummary into sdl.usage.stats responses"
```

---

## Chunk 3: Final Integration & Snapshot Tests

### Task 9: Run full test suite

**Files:** None modified — validation only.

- [ ] **Step 1: Build**

Run: `npm run build:all`
Expected: Clean build, no type errors

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: No errors

- [ ] **Step 3: Run all unit tests**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 4: Fix any issues found**

If any tests fail due to the new `meter` field in `TokenUsageMetadata`, update those tests to account for it. Common fixes:
- Tests that deep-equal `_tokenUsage` objects will need `meter` added
- Tests that snapshot JSON responses will need updating

### Task 10: Add golden snapshot test for meter output

**Files:**
- Create: `tests/unit/savings-meter-golden.test.ts`

- [ ] **Step 1: Write golden snapshot test**

```typescript
// tests/unit/savings-meter-golden.test.ts
import { describe, it } from "node:test";
import assert from "node:assert";
import {
  renderMeter,
  renderOperationMeter,
  renderTaskSummary,
  renderSessionSummary,
  formatTokenCount,
  type AggregateUsage,
} from "../../src/mcp/savings-meter.js";
import type { SessionUsageSnapshot } from "../../src/mcp/token-accumulator.js";

describe("savings-meter golden snapshots", () => {
  it("renderOperationMeter matches expected format exactly", () => {
    // High savings
    assert.strictEqual(renderOperationMeter(98), "██████████ 98%");
    // Zero savings
    assert.strictEqual(renderOperationMeter(0), "░░░░░░░░░░ 0%");
    // Mid savings
    assert.strictEqual(renderOperationMeter(51), "█████░░░░░ 51%");
  });

  it("renderTaskSummary golden output", () => {
    const snapshot: SessionUsageSnapshot = {
      sessionId: "golden-test",
      startedAt: "2026-03-20T00:00:00Z",
      totalSdlTokens: 500,
      totalRawEquivalent: 5000,
      totalSavedTokens: 4500,
      overallSavingsPercent: 90,
      callCount: 10,
      toolBreakdown: [
        { tool: "sdl.symbol.search", sdlTokens: 50, rawEquivalent: 500, savedTokens: 450, callCount: 5 },
        { tool: "sdl.slice.build", sdlTokens: 200, rawEquivalent: 4000, savedTokens: 3800, callCount: 3 },
        { tool: "sdl.code.getSkeleton", sdlTokens: 250, rawEquivalent: 500, savedTokens: 250, callCount: 2 },
      ],
    };

    const result = renderTaskSummary(snapshot);

    // Verify structure — header, session line, blank, 3 tools, footer = 7 lines
    const lines = result.split("\n");
    assert.strictEqual(lines.length, 7);

    // Header
    assert.ok(lines[0].startsWith("──"));
    assert.ok(lines[0].includes("Token Savings"));

    // Session summary
    assert.ok(lines[1].includes("10 calls"));
    assert.ok(lines[1].includes("4.5k saved"));
    assert.ok(lines[1].includes("█████████░"));
    assert.ok(lines[1].includes("90%"));

    // Blank line
    assert.strictEqual(lines[2], "");

    // Tools sorted by savedTokens desc: slice.build (3800), symbol.search (450), code.getSkeleton (250)
    assert.ok(lines[3].includes("slice.build"));
    assert.ok(lines[4].includes("symbol.search"));
    assert.ok(lines[5].includes("code.getSkeleton"));

    // Footer
    assert.match(lines[6], /^─+$/);
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `node --import tsx --test tests/unit/savings-meter-golden.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add tests/unit/savings-meter-golden.test.ts
git commit -m "test: add golden snapshot tests for savings meter output"
```

---

### Task 11: Final integration commit

- [ ] **Step 1: Run full build + test suite**

```bash
npm run build:all && npm test
```
Expected: All green

- [ ] **Step 2: Verify meter appears in live tool responses**

```bash
# Start the server and call a tool to verify meter field in _tokenUsage
npm run dev -- tool sdl.usage.stats '{"scope":"session"}'
```
Expected: Response includes `formattedSummary` with meter visualization

- [ ] **Step 3: Create final commit if any cleanup needed**

```bash
git add -A
git commit -m "feat: complete token savings meter with per-op, task, and session summaries"
```

---

## Summary of All New/Modified Files

| File | Action | Purpose |
|------|--------|---------|
| `src/mcp/savings-meter.ts` | **Create** | All formatting: `renderMeter`, `formatTokenCount`, `renderOperationMeter`, `renderTaskSummary`, `renderSessionSummary` |
| `src/mcp/token-usage.ts` | **Modify** | Add `meter: string` to `TokenUsageMetadata`, attach via `computeSavings` |
| `src/mcp/tools.ts` | **Modify** | Add `formattedSummary` to `UsageStatsResponseSchema` |
| `src/mcp/tools/usage.ts` | **Modify** | Wire `renderTaskSummary`/`renderSessionSummary` into response |
| `src/db/ladybug-usage.ts` | **Modify** | Add `aggregateToolBreakdowns()` pure function |
| `tests/unit/savings-meter.test.ts` | **Create** | Unit tests for all meter formatting functions |
| `tests/unit/ladybug-usage-format.test.ts` | **Create** | Unit tests for `aggregateToolBreakdowns` |
| `tests/unit/usage-stats-formatted.test.ts` | **Create** | Integration test for formatted summary wiring |
| `tests/unit/savings-meter-golden.test.ts` | **Create** | Golden snapshot tests for exact output format |
