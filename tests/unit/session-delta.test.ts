import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildSessionDeltaKey,
  maybeBuildSessionDelta,
  SessionDeltaCache,
} from "../../dist/mcp/session-delta.js";

describe("session delta cache", () => {
  it("defaults deltaMode to off and does not seed the cache", () => {
    const cache = new SessionDeltaCache();
    const request = {
      sessionId: "s1",
      key: "sdl.code.needWindow|repo|file.ts|1-3",
      content: "alpha\nbeta",
    };

    const off = maybeBuildSessionDelta(request, cache);
    assert.equal(off.mode, "off");
    assert.equal(off.content, request.content);
    assert.equal(off.metadata.deltaApplied, false);

    const firstAuto = maybeBuildSessionDelta(
      { ...request, deltaMode: "auto" },
      cache,
    );
    assert.equal(firstAuto.mode, "miss");
    assert.equal(firstAuto.content, request.content);
    assert.equal(firstAuto.metadata.reason, "cache-miss");
  });

  it("returns a cache miss with full content on the first opted-in call", () => {
    const cache = new SessionDeltaCache();

    const result = maybeBuildSessionDelta(
      {
        sessionId: "s1",
        key: "window-a",
        content: "const value = 1;",
        deltaMode: "auto",
      },
      cache,
    );

    assert.equal(result.mode, "miss");
    assert.equal(result.content, "const value = 1;");
    assert.equal(result.metadata.cacheHit, false);
    assert.equal(result.metadata.estimatedTokensAvoided, 0);
  });

  it("bypasses caching when no session id is available", () => {
    const cache = new SessionDeltaCache();
    const request = {
      key: "window-a",
      content: "const value = 1;",
      deltaMode: "auto" as const,
    };

    const first = maybeBuildSessionDelta(request, cache);
    const second = maybeBuildSessionDelta(request, cache);

    assert.equal(first.mode, "miss");
    assert.equal(first.metadata.reason, "no-session");
    assert.equal(second.mode, "miss");
    assert.equal(second.content, request.content);
    assert.deepEqual(cache.getStats(), { sessions: 0, entries: 0 });
  });

  it("returns unchanged metadata and no content for repeated identical windows", () => {
    const cache = new SessionDeltaCache();
    const request = {
      sessionId: "s1",
      key: "window-a",
      content: "line 1\nline 2\nline 3",
      deltaMode: "auto" as const,
    };

    maybeBuildSessionDelta(request, cache);
    const result = maybeBuildSessionDelta(request, cache);

    assert.equal(result.mode, "unchanged");
    assert.equal(result.content, undefined);
    assert.equal(result.delta?.status, "unchanged");
    assert.equal(result.delta?.changedLineCount, 0);
    assert.equal(result.metadata.deltaApplied, true);
    assert.ok(result.metadata.estimatedTokensAvoided > 0);
  });

  it("returns a bounded append delta for a changed repeated window", () => {
    const cache = new SessionDeltaCache();

    maybeBuildSessionDelta(
      {
        sessionId: "s1",
        key: "window-a",
        content: "alpha\nbeta",
        deltaMode: "auto",
      },
      cache,
    );
    const result = maybeBuildSessionDelta(
      {
        sessionId: "s1",
        key: "window-a",
        content: "alpha\nbeta\ngamma",
        deltaMode: "auto",
        maxDeltaLines: 8,
      },
      cache,
    );

    assert.equal(result.mode, "changed");
    assert.equal(result.content, undefined);
    assert.equal(result.delta?.status, "changed");
    assert.match(result.delta?.excerpt ?? "", /^@@ -3,0 \+3,1 @@/);
    assert.match(result.delta?.excerpt ?? "", /\+gamma/);
    assert.equal(result.delta?.truncated, false);
  });

  it("returns a replace delta with removed and added lines", () => {
    const cache = new SessionDeltaCache();

    maybeBuildSessionDelta(
      {
        sessionId: "s1",
        key: "window-a",
        content: "before\nold value\nafter",
        deltaMode: "auto",
      },
      cache,
    );
    const result = maybeBuildSessionDelta(
      {
        sessionId: "s1",
        key: "window-a",
        content: "before\nnew value\nafter",
        deltaMode: "auto",
        maxDeltaLines: 8,
      },
      cache,
    );

    assert.equal(result.mode, "changed");
    assert.match(result.delta?.excerpt ?? "", /-old value/);
    assert.match(result.delta?.excerpt ?? "", /\+new value/);
    assert.equal(result.delta?.changedLineCount, 2);
  });

  it("treats different stable keys as independent cache misses", () => {
    const cache = new SessionDeltaCache();

    maybeBuildSessionDelta(
      {
        sessionId: "s1",
        key: "window-a",
        content: "same content",
        deltaMode: "auto",
      },
      cache,
    );
    const result = maybeBuildSessionDelta(
      {
        sessionId: "s1",
        key: "window-b",
        content: "same content",
        deltaMode: "auto",
      },
      cache,
    );

    assert.equal(result.mode, "miss");
    assert.equal(result.content, "same content");
  });

  it("expires old entries by TTL", () => {
    const cache = new SessionDeltaCache({ ttlMs: 10 });
    const request = {
      sessionId: "s1",
      key: "window-a",
      content: "ttl content",
      deltaMode: "auto" as const,
    };

    maybeBuildSessionDelta({ ...request, nowMs: 100 }, cache);
    const expired = maybeBuildSessionDelta({ ...request, nowMs: 111 }, cache);

    assert.equal(expired.mode, "miss");
    assert.equal(expired.content, "ttl content");
  });

  it("bounds per-session cache entries with LRU eviction", () => {
    const cache = new SessionDeltaCache({ maxEntriesPerSession: 1 });

    maybeBuildSessionDelta(
      {
        sessionId: "s1",
        key: "window-a",
        content: "first",
        deltaMode: "auto",
        nowMs: 100,
      },
      cache,
    );
    maybeBuildSessionDelta(
      {
        sessionId: "s1",
        key: "window-b",
        content: "second",
        deltaMode: "auto",
        nowMs: 101,
      },
      cache,
    );
    const evicted = maybeBuildSessionDelta(
      {
        sessionId: "s1",
        key: "window-a",
        content: "first",
        deltaMode: "auto",
        nowMs: 102,
      },
      cache,
    );

    assert.equal(evicted.mode, "miss");
    assert.deepEqual(cache.getStats(), { sessions: 1, entries: 1 });
  });

  it("bypasses caching for content above the entry byte cap", () => {
    const cache = new SessionDeltaCache({ maxEntryBytes: 4 });
    const result = maybeBuildSessionDelta(
      {
        sessionId: "s1",
        key: "window-a",
        content: "too large",
        deltaMode: "auto",
      },
      cache,
    );

    assert.equal(result.mode, "miss");
    assert.equal(result.content, "too large");
    assert.equal(result.metadata.reason, "content-too-large");
    assert.deepEqual(cache.getStats(), { sessions: 1, entries: 0 });
  });

  it("invalidates a stale same-key entry when a response is too large to cache", () => {
    const cache = new SessionDeltaCache({ maxEntryBytes: 8 });
    const key = "window-a";

    maybeBuildSessionDelta(
      {
        sessionId: "s1",
        key,
        content: "small",
        deltaMode: "auto",
      },
      cache,
    );
    const tooLarge = maybeBuildSessionDelta(
      {
        sessionId: "s1",
        key,
        content: "this response is too large",
        deltaMode: "auto",
      },
      cache,
    );
    const nextSmall = maybeBuildSessionDelta(
      {
        sessionId: "s1",
        key,
        content: "tiny",
        deltaMode: "auto",
      },
      cache,
    );

    assert.equal(tooLarge.mode, "miss");
    assert.equal(tooLarge.metadata.reason, "content-too-large");
    assert.equal(nextSmall.mode, "miss");
    assert.equal(nextSmall.content, "tiny");
    assert.equal(nextSmall.metadata.cacheHit, false);
  });

  it("returns full content instead of an incomplete truncated delta", () => {
    const cache = new SessionDeltaCache();

    maybeBuildSessionDelta(
      {
        sessionId: "s1",
        key: "window-a",
        content: "a\nb\nc\nd",
        deltaMode: "auto",
      },
      cache,
    );
    const result = maybeBuildSessionDelta(
      {
        sessionId: "s1",
        key: "window-a",
        content: "w\nx\ny\nz",
        deltaMode: "auto",
        maxDeltaLines: 2,
      },
      cache,
    );

    assert.equal(result.mode, "miss");
    assert.equal(result.content, "w\nx\ny\nz");
    assert.equal(result.delta, undefined);
    assert.equal(result.metadata.cacheHit, true);
    assert.equal(result.metadata.deltaApplied, false);
    assert.equal(result.metadata.reason, "delta-too-large");
  });

  it("estimates tokens avoided for changed deltas", () => {
    const cache = new SessionDeltaCache();
    const first = Array.from(
      { length: 40 },
      (_, index) => `line ${index}`,
    ).join("\n");
    const second = `${first}\nsmall append`;

    maybeBuildSessionDelta(
      {
        sessionId: "s1",
        key: "window-a",
        content: first,
        deltaMode: "auto",
      },
      cache,
    );
    const result = maybeBuildSessionDelta(
      {
        sessionId: "s1",
        key: "window-a",
        content: second,
        deltaMode: "auto",
        maxDeltaLines: 8,
      },
      cache,
    );

    assert.equal(result.mode, "changed");
    assert.ok(result.metadata.estimatedFullTokens > 0);
    assert.ok(result.metadata.estimatedDeltaTokens > 0);
    assert.ok(result.metadata.estimatedTokensAvoided > 0);
  });

  it("builds stable keys from window identity fields", () => {
    const key = buildSessionDeltaKey({
      toolName: "sdl.code.needWindow",
      repoId: "repo",
      filePath: "src/example.ts",
      symbolId: "symbol-1",
      range: { startLine: 10, endLine: 20 },
      extra: { maxLines: 80, omitted: undefined },
    });

    assert.equal(
      key,
      "tool=sdl.code.needWindow|repo=repo|file=src/example.ts|symbol=symbol-1|range=10-20|maxLines=80",
    );
  });
});
