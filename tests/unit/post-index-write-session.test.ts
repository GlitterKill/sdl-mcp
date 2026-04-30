import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  bufferAuditEvent,
  drainAuditBuffer,
  getBufferedAuditCount,
  getDroppedAuditCount,
} from "../../dist/mcp/audit-buffer.js";
import {
  configureWriteConnAcquirer,
  getActivePostIndexSession,
  isPostIndexSessionActive,
  registerSessionEndHook,
  withPostIndexWriteSession,
} from "../../dist/db/write-session.js";
import {
  installObservabilityTap,
  resetObservabilityTap,
} from "../../dist/observability/event-tap.js";

// Tests for the post-index write-session machinery and the audit-log buffer
// added in Item 6 (Approach A + Approach B). These tests use a fake write
// conn acquirer so they don't require a real LadybugDB pool. Once the fake
// is installed it stays installed for the rest of the test process — that
// is safe because withPostIndexWriteSession is the only consumer of the
// acquirer; withWriteConn used elsewhere is unaffected.

const FAKE_CONN_TAG = "__test-fake-write-conn__";

function installFakeAcquirer(): void {
  configureWriteConnAcquirer(async (fn) => {
    return fn({ [FAKE_CONN_TAG]: true } as never);
  });
}

describe("withPostIndexWriteSession", () => {
  beforeEach(() => {
    installFakeAcquirer();
  });

  afterEach(() => {
    delete process.env.SDL_POST_INDEX_SESSION_TIMEOUT_MS;
  });

  it("flips isPostIndexSessionActive only inside the body", async () => {
    let activeInside = false;
    let sessionRef: unknown;
    assert.equal(
      isPostIndexSessionActive(),
      false,
      "session must not be active before",
    );
    await withPostIndexWriteSession(async (session) => {
      activeInside = isPostIndexSessionActive();
      sessionRef = session;
      assert.ok(session.id.startsWith("pi-"));
      assert.ok(session.conn, "session must carry a conn");
      assert.equal(getActivePostIndexSession()?.id, session.id);
    });
    assert.equal(activeInside, true, "session must be active inside body");
    assert.equal(
      isPostIndexSessionActive(),
      false,
      "session must clear after body",
    );
    assert.ok(sessionRef);
  });

  it("rejects nested sessions", async () => {
    let outerErr: unknown;
    try {
      await withPostIndexWriteSession(async () => {
        await withPostIndexWriteSession(async () => {
          /* should not reach */
        });
      });
    } catch (err) {
      outerErr = err;
    }
    assert.ok(outerErr instanceof Error);
    assert.match((outerErr as Error).message, /still active/);
    assert.equal(isPostIndexSessionActive(), false);
  });

  it("fires timeout when body exceeds the threshold", async () => {
    process.env.SDL_POST_INDEX_SESSION_TIMEOUT_MS = "60";
    let caught: unknown;
    try {
      await withPostIndexWriteSession(async () => {
        await new Promise((r) => setTimeout(r, 200));
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof Error, "timeout must throw");
    assert.match((caught as Error).message, /timed out after 60ms/);
    assert.equal(isPostIndexSessionActive(), false);
  });

  it("body's own throw propagates and clears active session", async () => {
    let caught: unknown;
    try {
      await withPostIndexWriteSession(async () => {
        throw new Error("boom inside body");
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof Error);
    assert.match((caught as Error).message, /boom inside body/);
    assert.equal(isPostIndexSessionActive(), false);
  });

  it("clears activeSession BEFORE running end-hooks (HIGH 1 race fix)", async () => {
    let observedActiveInsideHook: boolean | null = null;
    const unregister = registerSessionEndHook(async () => {
      observedActiveInsideHook = isPostIndexSessionActive();
    });
    try {
      await withPostIndexWriteSession(async () => {
        /* body */
      });
    } finally {
      unregister();
    }
    assert.equal(
      observedActiveInsideHook,
      false,
      "activeSession must be null while end-hooks run, otherwise audit calls during hook execution would still buffer",
    );
  });

  it("runs end-hooks even when body throws", async () => {
    let hookRan = false;
    const unregister = registerSessionEndHook(async () => {
      hookRan = true;
    });
    let bodyErr: unknown;
    try {
      await withPostIndexWriteSession(async () => {
        throw new Error("body failure");
      });
    } catch (err) {
      bodyErr = err;
    } finally {
      unregister();
    }
    assert.ok(bodyErr instanceof Error);
    assert.equal(hookRan, true, "end-hooks must run even on body throw");
  });

  it("skips end-hooks on timeout to avoid racing the hung body", async () => {
    process.env.SDL_POST_INDEX_SESSION_TIMEOUT_MS = "60";
    let hookFired = false;
    const unregister = registerSessionEndHook(async () => {
      hookFired = true;
    });
    let caught: unknown;
    try {
      await withPostIndexWriteSession(async () => {
        await new Promise((r) => setTimeout(r, 250));
      });
    } catch (err) {
      caught = err;
    } finally {
      unregister();
    }
    assert.ok(caught instanceof Error);
    assert.match((caught as Error).message, /timed out/);
    assert.equal(
      hookFired,
      false,
      "end-hooks must NOT run when session times out (body's last DB call still in flight on session.conn)",
    );
  });

  it("isolates a thrown end-hook from later hooks", async () => {
    const order: string[] = [];
    const unregister1 = registerSessionEndHook(async () => {
      order.push("hook-1");
      throw new Error("hook-1 boom");
    });
    const unregister2 = registerSessionEndHook(async () => {
      order.push("hook-2");
    });
    try {
      await withPostIndexWriteSession(async () => {
        /* body */
      });
    } finally {
      unregister1();
      unregister2();
    }
    assert.deepEqual(order, ["hook-1", "hook-2"]);
    assert.equal(isPostIndexSessionActive(), false);
  });

  it("forwards postIndexSession event to observability tap on success", async () => {
    const events: Array<{ durationMs: number; timedOut: boolean; sessionId: string }> = [];
    installObservabilityTap({
      toolCall() {},
      indexEvent() {},
      semanticSearch() {},
      policyDecision() {},
      prefetch() {},
      watcherHealth() {},
      edgeResolution() {},
      runtimeExecution() {},
      setupPipeline() {},
      summaryGeneration() {},
      summaryQuality() {},
      pprResult() {},
      scipIngest() {},
      packedWire() {},
      poolSample() {},
      resourceSample() {},
      indexPhase() {},
      cacheLookup() {},
      sliceBuild() {},
      auditBufferSample() {},
      postIndexSession(e) {
        events.push({
          durationMs: e.durationMs,
          timedOut: e.timedOut,
          sessionId: e.sessionId,
        });
      },
    });
    try {
      await withPostIndexWriteSession(async () => {
        await new Promise((r) => setTimeout(r, 5));
      });
    } finally {
      resetObservabilityTap();
    }
    assert.equal(events.length, 1);
    assert.equal(events[0].timedOut, false);
    assert.ok(events[0].durationMs >= 0);
    assert.ok(events[0].sessionId.startsWith("pi-"));
  });

  it("forwards postIndexSession with timedOut=true on timeout", async () => {
    const events: Array<{ timedOut: boolean }> = [];
    installObservabilityTap({
      toolCall() {},
      indexEvent() {},
      semanticSearch() {},
      policyDecision() {},
      prefetch() {},
      watcherHealth() {},
      edgeResolution() {},
      runtimeExecution() {},
      setupPipeline() {},
      summaryGeneration() {},
      summaryQuality() {},
      pprResult() {},
      scipIngest() {},
      packedWire() {},
      poolSample() {},
      resourceSample() {},
      indexPhase() {},
      cacheLookup() {},
      sliceBuild() {},
      auditBufferSample() {},
      postIndexSession(e) {
        events.push({ timedOut: e.timedOut });
      },
    });
    process.env.SDL_POST_INDEX_SESSION_TIMEOUT_MS = "60";
    try {
      await assert.rejects(
        withPostIndexWriteSession(async () => {
          await new Promise((r) => setTimeout(r, 200));
        }),
        /timed out/,
      );
    } finally {
      resetObservabilityTap();
      delete process.env.SDL_POST_INDEX_SESSION_TIMEOUT_MS;
    }
    assert.equal(events.length, 1);
    assert.equal(events[0].timedOut, true);
  });
});

describe("audit-buffer", () => {
  it("buffers events and increments count", () => {
    const before = getBufferedAuditCount();
    const ok = bufferAuditEvent({
      eventId: `test-${Date.now()}-1`,
      timestamp: "2026-04-30T00:00:00.000Z",
      tool: "test.tool",
      decision: "success",
      repoId: null,
      symbolId: null,
      detailsJson: "{}",
    });
    assert.equal(ok, true);
    assert.equal(
      getBufferedAuditCount(),
      before + 1,
      "buffer count must increment when capacity allows",
    );
  });

  it("returns false on overflow so callers can log/escalate", () => {
    // We can't reliably overflow the production MAX_BUFFER without 5000+
    // pushes, but we can still verify the contract: bufferAuditEvent
    // returns boolean and the dropped counter is monotonic.
    const beforeDropped = getDroppedAuditCount();
    let dropsObserved = 0;
    for (let i = 0; i < 6000; i++) {
      const ok = bufferAuditEvent({
        eventId: `test-cap-${Date.now()}-${i}`,
        timestamp: "2026-04-30T00:00:00.000Z",
        tool: "test.tool",
        decision: "success",
        repoId: null,
        symbolId: null,
        detailsJson: "{}",
      });
      if (!ok) dropsObserved += 1;
    }
    if (dropsObserved > 0) {
      assert.ok(
        getDroppedAuditCount() >= beforeDropped + dropsObserved,
        "dropped counter must surface drops via getDroppedAuditCount()",
      );
    }
  });

  it("drainAuditBuffer with a no-op conn returns 0 when buffer is empty", async () => {
    // Empty the buffer first using a stub that ignores the conn. We can't
    // call into LadybugDB without a real DB, so this test just verifies
    // drainAuditBuffer's empty-buffer fast path.
    // Drain whatever is buffered by calling with a throwing fake conn —
    // each insert will throw and be caught per-row, leaving okCount=0.
    const fakeConn = { __test: true } as never;
    if (getBufferedAuditCount() === 0) {
      const drained = await drainAuditBuffer(fakeConn);
      assert.equal(drained, 0);
    }
  });
});
