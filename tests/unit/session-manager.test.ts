import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";

import { SessionManager } from "../../dist/mcp/session-manager.js";

describe("SessionManager", () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager(2);
  });

  afterEach(() => {
    // Ensure per-test isolation for session state.
    for (const session of manager.getStats().sessions) {
      manager.unregisterSession(session.sessionId);
    }
  });

  it("validates maxSessions range in constructor", () => {
    assert.throws(
      () => new SessionManager(0),
      /maxSessions must be between 1 and 16, got 0/,
    );
    assert.throws(
      () => new SessionManager(17),
      /maxSessions must be between 1 and 16, got 17/,
    );

    assert.doesNotThrow(() => new SessionManager(1));
    assert.doesNotThrow(() => new SessionManager(16));
  });

  it("canAcceptSession returns true when under limit", () => {
    assert.strictEqual(manager.canAcceptSession(), true);
    manager.registerSession("s-1", "sse");
    assert.strictEqual(manager.canAcceptSession(), true);
  });

  it("canAcceptSession returns false when at limit", () => {
    manager.registerSession("s-1", "sse");
    manager.registerSession("s-2", "streamable-http");
    assert.strictEqual(manager.canAcceptSession(), false);
  });

  it("registerSession adds a session", () => {
    manager.registerSession("s-1", "sse");

    const session = manager.getSession("s-1");
    assert.ok(session);
    assert.strictEqual(session.sessionId, "s-1");
    assert.strictEqual(session.transportType, "sse");
    assert.strictEqual(session.requestsInFlight, 0);
    assert.strictEqual(session.totalRequests, 0);
  });

  it("registerSession throws when at capacity", () => {
    manager.registerSession("s-1", "sse");
    manager.registerSession("s-2", "streamable-http");

    assert.throws(
      () => manager.registerSession("s-3", "sse"),
      /Maximum session limit \(2\) reached/,
    );
  });

  it("registerSession ignores duplicate session IDs", () => {
    manager.registerSession("s-1", "sse");
    const first = manager.getSession("s-1");

    manager.registerSession("s-1", "streamable-http");
    const afterDuplicate = manager.getSession("s-1");

    assert.ok(first);
    assert.ok(afterDuplicate);
    assert.strictEqual(manager.getStats().activeSessions, 1);
    assert.strictEqual(afterDuplicate.transportType, "sse");
    assert.strictEqual(afterDuplicate.connectedAt, first.connectedAt);
  });

  it("unregisterSession removes a session", () => {
    manager.registerSession("s-1", "sse");
    manager.unregisterSession("s-1");

    assert.strictEqual(manager.getSession("s-1"), undefined);
    assert.strictEqual(manager.getStats().activeSessions, 0);
  });

  it("unregisterSession is idempotent for unknown sessions", () => {
    assert.doesNotThrow(() => manager.unregisterSession("missing"));
  });

  it("trackRequest increments requestsInFlight and totalRequests", () => {
    manager.registerSession("s-1", "sse");

    const done = manager.trackRequest("s-1");
    const session = manager.getSession("s-1");

    assert.ok(session);
    assert.strictEqual(session.requestsInFlight, 1);
    assert.strictEqual(session.totalRequests, 1);

    done();
  });

  it("trackRequest completion function decrements requestsInFlight", () => {
    manager.registerSession("s-1", "sse");

    const done = manager.trackRequest("s-1");
    done();

    const session = manager.getSession("s-1");
    assert.ok(session);
    assert.strictEqual(session.requestsInFlight, 0);
    assert.strictEqual(session.totalRequests, 1);
  });

  it("getStats returns expected shape", () => {
    manager.registerSession("s-1", "sse");

    const stats = manager.getStats();
    assert.deepStrictEqual(Object.keys(stats).sort(), [
      "activeSessions",
      "maxSessions",
      "sessions",
    ]);
    assert.strictEqual(stats.activeSessions, 1);
    assert.strictEqual(stats.maxSessions, 2);
    assert.strictEqual(stats.sessions.length, 1);
  });

  it("getSession returns a copy, not a mutable reference", () => {
    manager.registerSession("s-1", "sse");

    const session = manager.getSession("s-1");
    assert.ok(session);

    session.requestsInFlight = 999;

    const reread = manager.getSession("s-1");
    assert.ok(reread);
    assert.strictEqual(reread.requestsInFlight, 0);
  });
});
