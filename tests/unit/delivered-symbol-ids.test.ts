import assert from "node:assert";
import { describe, it, before } from "node:test";

import { extractDeliveredSymbolIdsFromToolResult } from "../../dist/server.js";
import { tokenAccumulator } from "../../dist/mcp/token-accumulator.js";
import { wasteLedger } from "../../dist/mcp/waste-ledger.js";

const FULL_ID_A = "a".repeat(64);
const FULL_ID_B = "b".repeat(64);

function packedSearchPayload(idsLine: string): string {
  return [
    "#PACKED/1 tool=symbol.search enc=ss2",
    idsLine,
    "",
    "query=example total=2 __tables=h:results:symbolId|file|line|kind|score|name:str|str|int|str|float|str",
    "h,s1,src/a.ts,0,function,0,exampleA",
  ].join("\n");
}

describe("extractDeliveredSymbolIdsFromToolResult", () => {
  it("parses full ids from packed search result strings", () => {
    const result = {
      results: packedSearchPayload(`@ids=s1:${FULL_ID_A},s2:${FULL_ID_B}`),
    };
    assert.deepEqual(extractDeliveredSymbolIdsFromToolResult(result), [
      FULL_ID_A,
      FULL_ID_B,
    ]);
  });

  it("ignores non-packed result strings", () => {
    assert.deepEqual(
      extractDeliveredSymbolIdsFromToolResult({ results: "plain text" }),
      [],
    );
  });

  it("parses packed context payloads from _packedPayload", () => {
    const result = {
      finalEvidence: [],
      _packedPayload: packedSearchPayload(`@ids=s4:${FULL_ID_A}`),
    };
    assert.deepEqual(extractDeliveredSymbolIdsFromToolResult(result), [
      FULL_ID_A,
    ]);
  });

  it("unwraps workflow step envelopes to find delivered cards", () => {
    const result = {
      results: [
        { fn: "symbolGetCard", result: { card: { symbolId: FULL_ID_A } } },
        {
          fn: "symbolSearch",
          result: { results: packedSearchPayload(`@ids=s3:${FULL_ID_B}`) },
        },
        { fn: "runtimeExecute", status: "error", error: "boom" },
      ],
    };
    assert.deepEqual(extractDeliveredSymbolIdsFromToolResult(result), [
      FULL_ID_A,
      FULL_ID_B,
    ]);
  });

  it("skips unchanged ref cards inside workflow envelopes", () => {
    const result = {
      results: [
        {
          fn: "symbolGetCard",
          result: { card: { symbolId: FULL_ID_A, unchanged: true } },
        },
      ],
    };
    assert.deepEqual(extractDeliveredSymbolIdsFromToolResult(result), []);
  });
});

describe("delivered-id extraction feeds usage.stats signal density", () => {
  let handleUsageStats: (args: unknown) => Promise<unknown>;
  let usageAvailable = true;

  before(async () => {
    try {
      const usageMod = await import("../../dist/mcp/tools/usage.js");
      handleUsageStats = usageMod.handleUsageStats;
    } catch {
      usageAvailable = false;
    }
  });

  it("reports signal density from extracted gateway deliveries", async (t) => {
    if (!usageAvailable) return t.skip("usage module not available");
    tokenAccumulator.reset();
    wasteLedger.clear();

    try {
      const delivered = extractDeliveredSymbolIdsFromToolResult({
        results: [
          {
            fn: "symbolSearch",
            result: {
              results: packedSearchPayload(
                `@ids=s1:${FULL_ID_A},s2:${FULL_ID_B}`,
              ),
            },
          },
        ],
      });
      wasteLedger.recordDelivered("sess", "sdl.workflow", delivered, 300);
      wasteLedger.recordReferenced("sess", [FULL_ID_A]);

      const result = (await handleUsageStats({
        scope: "session",
        detail: "full",
      })) as Record<string, unknown>;
      assert.ok(result.signalDensity, "should include signalDensity");
      assert.match(result.formattedSummary as string, /Signal density: 1\/2/);
    } finally {
      wasteLedger.clear();
    }
  });
});
