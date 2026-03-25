/**
 * feedback-boost.test.ts
 *
 * Tests for the pure-function mergeFeedbackBoosts which computes
 * boost scores for symbols based on prior AgentFeedback retrieval.
 *
 * Uses dynamic import in feedback-boost.ts to avoid the OTel tracing
 * import chain. Imports from src/ via tsx.
 *
 * Run: node --import tsx --test tests/unit/feedback-boost.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  mergeFeedbackBoosts,
  type FeedbackBoostResult,
} from "../../src/retrieval/feedback-boost.js";

describe("mergeFeedbackBoosts", () => {
  it("boosts symbols mentioned as useful in matching feedback", () => {
    const feedbackHits: FeedbackBoostResult[] = [
      {
        feedbackId: "fb1",
        score: 0.9,
        usefulSymbols: ["sym-a", "sym-b"],
        missingSymbols: ["sym-c"],
        taskType: "debug",
      },
      {
        feedbackId: "fb2",
        score: 0.7,
        usefulSymbols: ["sym-b", "sym-d"],
        missingSymbols: [],
        taskType: "debug",
      },
    ];

    const boosts = mergeFeedbackBoosts(feedbackHits);

    // sym-a appears once with score 0.9: boost = 0.9 * 0.3 = 0.27
    assert.ok(boosts.has("sym-a"));
    assert.ok(Math.abs(boosts.get("sym-a")! - 0.27) < 0.001);

    // sym-b appears in both: boost = (0.9 * 0.3) + (0.7 * 0.3) = 0.48
    assert.ok(boosts.has("sym-b"));
    assert.ok(Math.abs(boosts.get("sym-b")! - 0.48) < 0.001);

    // sym-b has higher boost than sym-a (accumulated)
    assert.ok(boosts.get("sym-b")! > boosts.get("sym-a")!);

    // sym-d appears once with score 0.7: boost = 0.7 * 0.3 = 0.21
    assert.ok(boosts.has("sym-d"));
    assert.ok(Math.abs(boosts.get("sym-d")! - 0.21) < 0.001);

    // All boosts should be positive
    for (const [, boost] of boosts) {
      assert.ok(boost > 0);
    }
  });

  it("returns empty map for no feedback hits", () => {
    const boosts = mergeFeedbackBoosts([]);
    assert.equal(boosts.size, 0);
  });

  it("ignores missing symbols (no negative boost)", () => {
    const feedbackHits: FeedbackBoostResult[] = [
      {
        feedbackId: "fb1",
        score: 0.8,
        usefulSymbols: [],
        missingSymbols: ["sym-x"],
        taskType: "review",
      },
    ];
    const boosts = mergeFeedbackBoosts(feedbackHits);
    // missingSymbols are not boosted
    assert.ok(!boosts.has("sym-x"));
    assert.equal(boosts.size, 0);
  });

  it("caps accumulated boost at 1.0", () => {
    // Create many feedback hits that would accumulate beyond 1.0
    const feedbackHits: FeedbackBoostResult[] = Array.from(
      { length: 10 },
      (_, i) => ({
        feedbackId: `fb-${i}`,
        score: 1.0,
        usefulSymbols: ["sym-popular"],
        missingSymbols: [],
        taskType: "debug",
      }),
    );

    const boosts = mergeFeedbackBoosts(feedbackHits);

    // 10 * (1.0 * 0.3) = 3.0, but capped at 1.0
    assert.equal(boosts.get("sym-popular"), 1.0);
  });

  it("handles single feedback with multiple useful symbols", () => {
    const feedbackHits: FeedbackBoostResult[] = [
      {
        feedbackId: "fb1",
        score: 0.5,
        usefulSymbols: ["sym-1", "sym-2", "sym-3"],
        missingSymbols: [],
        taskType: null,
      },
    ];

    const boosts = mergeFeedbackBoosts(feedbackHits);

    assert.equal(boosts.size, 3);
    // Each gets 0.5 * 0.3 = 0.15
    for (const [, boost] of boosts) {
      assert.ok(Math.abs(boost - 0.15) < 0.001);
    }
  });
});
