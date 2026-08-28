import assert from "node:assert/strict";
import { test } from "node:test";

import { OverlayEmbeddingCache } from "../../dist/live-index/overlay-embedding-cache.js";
import { EMBEDDING_MODELS } from "../../dist/retrieval/model-mapping.js";

test("overlay cache initializes providers and skips vectors from mid-embed fallback", async () => {
  let embedCalls = 0;
  const resolveProvider = () => {
    let initialized = false;
    let degraded = false;
    return {
      initialize: async () => {
        initialized = true;
      },
      embed: async () => {
        assert.strictEqual(initialized, true);
        embedCalls += 1;
        degraded = true;
        return [[42]];
      },
      getDimension: () => 1,
      isMockFallback: () => {
        assert.strictEqual(
          initialized,
          true,
          "fallback state must not be read before initialization",
        );
        return degraded;
      },
    };
  };
  const cache = new OverlayEmbeddingCache(resolveProvider);

  assert.strictEqual(Reflect.get(cache, "resolveProvider"), resolveProvider);
  await cache.computeAndCache("symbol-1", "function target() {}");

  assert.strictEqual(embedCalls, Object.keys(EMBEDDING_MODELS).length);
  assert.strictEqual(cache.size, 0);
});
