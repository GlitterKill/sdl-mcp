import { describe, it } from "node:test";
import assert from "node:assert";

const { createHttpAuthRateLimiter } = await import(
  "../../dist/cli/transport/http.js"
);

describe("HTTP auth rate limiter", () => {
  it("rejects requests after bucket exhaustion and refills over time", () => {
    let now = 0;
    const limiter = createHttpAuthRateLimiter(
      { bucketSize: 2, refillPerSec: 1 },
      () => now,
    );

    assert.deepStrictEqual(limiter.consume("127.0.0.1"), { allowed: true });
    assert.deepStrictEqual(limiter.consume("127.0.0.1"), { allowed: true });
    assert.deepStrictEqual(limiter.consume("127.0.0.1"), {
      allowed: false,
      retryAfterSeconds: 1,
    });

    now = 1000;
    assert.deepStrictEqual(limiter.consume("127.0.0.1"), { allowed: true });
  });
});
