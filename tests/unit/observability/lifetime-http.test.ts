import assert from "node:assert/strict";
import test from "node:test";

import {
  setupObservabilityDashboardSidecar,
  type HttpTransportServices,
} from "../../../dist/cli/transport/http.js";
import { ObservabilityConfigSchema } from "../../../dist/config/types.js";
import { emptyLifetimeSections } from "../../../dist/observability/lifetime-accumulator.js";
import type { LifetimeStore } from "../../../dist/observability/lifetime-store.js";
import { ObservabilityService } from "../../../dist/observability/service.js";
import {
  SECTION_IDS,
  type LifetimeEnvelopeV1,
  type LifetimeFreshness,
  type LifetimeReadyV1,
} from "../../../dist/observability/lifetime-types.js";
import type { ObservabilitySnapshot } from "../../../dist/observability/types.js";

const AUTH = { Authorization: "Bearer test-token" };
const NOW = "2026-08-20T12:00:00.000Z";

function ready(repoId: string, state: LifetimeReadyV1["persistenceState"] = "ready"):
LifetimeReadyV1 {
  return {
    schemaVersion: 1,
    sampleIntervalMs: 2_000,
    generatedAt: NOW,
    repoId,
    epoch: 0,
    resetAt: null,
    lastCheckpointAt: null,
    persistenceState: state,
    sessionCount: 0,
    saturated: false,
    sections: emptyLifetimeSections(),
    freshness: Object.fromEntries(SECTION_IDS.map((section) => [section, null])) as LifetimeFreshness,
    processPeaks: null,
  };
}

function withEvent(value: LifetimeReadyV1): LifetimeReadyV1 {
  return {
    ...value,
    sections: {
      ...value.sections,
      cache: {
        hits: 1,
        misses: 0,
        lookupMs: { count: 1, sum: 1, max: 1 },
        perSource: {},
      },
    },
  };
}

type SnapshotSubscriber = (snapshot: ObservabilitySnapshot) => void;

function serviceDouble(overrides: {
  getLifetime?: (repoId: string) => Promise<LifetimeEnvelopeV1>;
  resetLifetime?: (repoId: string) => Promise<LifetimeReadyV1>;
  onSubscribe?: (subscriber: SnapshotSubscriber) => void;
} = {}): NonNullable<HttpTransportServices["observabilityService"]> {
  return {
    getSnapshot(repoId: string) {
      return { schemaVersion: 1, generatedAt: NOW, repoId } as ObservabilitySnapshot;
    },
    async getLifetime(repoId: string) {
      return overrides.getLifetime?.(repoId) ?? ready(repoId);
    },
    async resetLifetime(repoId: string) {
      return overrides.resetLifetime?.(repoId) ?? {
        ...withEvent(ready(repoId)),
        epoch: 1,
        resetAt: NOW,
        lastCheckpointAt: NOW,
      };
    },
    onSnapshot(subscriber: SnapshotSubscriber) {
      overrides.onSubscribe?.(subscriber);
      return () => {};
    },
  } as unknown as NonNullable<HttpTransportServices["observabilityService"]>;
}

async function start(
  observabilityService: NonNullable<HttpTransportServices["observabilityService"]>,
  registered = new Set(["repo-a"]),
) {
  return setupObservabilityDashboardSidecar(
    0,
    {
      observabilityService,
      isRegisteredRepoId: (repoId: string) => registered.has(repoId),
      observabilitySseHeartbeatMs: 60_000,
      observabilitySseMaxStreamMs: 60_000,
    },
    { enabled: true, token: "test-token" },
    async () => true,
  );
}

async function request(server: Awaited<ReturnType<typeof start>>, path: string, init?: RequestInit) {
  return fetch(`http://127.0.0.1:${server.port}${path}`, {
    signal: AbortSignal.timeout(5_000),
    ...init,
    headers: { ...AUTH, ...init?.headers },
  });
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

function assertRouteError(
  value: Record<string, unknown>,
  code: string,
  message: string,
  retryable = false,
): void {
  assert.deepEqual(Object.keys(value), ["schemaVersion", "error"]);
  assert.deepEqual(Object.keys(value.error as object), ["code", "message", "retryable"]);
  assert.deepEqual(value, {
    schemaVersion: 1,
    error: { code, message, retryable },
  });
}

test("lifetime routes authenticate before query and reset body processing", async () => {
  let calls = 0;
  const server = await start(serviceDouble({
    getLifetime: async (repoId) => {
      calls += 1;
      return ready(repoId);
    },
  }));
  try {
    const get = await fetch(
      `http://127.0.0.1:${server.port}/api/observability/lifetime?repoId=%`,
      { signal: AbortSignal.timeout(5_000) },
    );
    assert.equal(get.status, 401);
    assert.deepEqual(await body(get), { error: "Unauthorized: Bearer token required" });

    const reset = await fetch(
      `http://127.0.0.1:${server.port}/api/observability/lifetime/reset`,
      {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "not-json",
        signal: AbortSignal.timeout(5_000),
      },
    );
    assert.equal(reset.status, 401);
    assert.deepEqual(await body(reset), { error: "Unauthorized: Bearer token required" });
    assert.equal(calls, 0);
  } finally {
    await server.close();
  }
});

test("lifetime routes preserve the shared unauthorized rate-limit body", async () => {
  const server = await setupObservabilityDashboardSidecar(
    0,
    {
      observabilityService: serviceDouble(),
      isRegisteredRepoId: (repoId) => repoId === "repo-a",
    },
    {
      enabled: true,
      token: "test-token",
      rateLimit: { bucketSize: 1, refillPerSec: 0.001 },
    },
    async () => true,
  );
  try {
    const url = `http://127.0.0.1:${server.port}/api/observability/lifetime?repoId=%`;
    const unauthorized = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    assert.equal(unauthorized.status, 401);
    assert.deepEqual(await body(unauthorized), { error: "Unauthorized: Bearer token required" });
    const limited = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    assert.equal(limited.status, 429);
    assert.deepEqual(await body(limited), { code: "rate_limited" });
  } finally {
    await server.close();
  }
});

test("lifetime GET validates one registered repoId and awaits a closed envelope", async () => {
  let resolveLifetime!: (value: LifetimeEnvelopeV1) => void;
  const pending = new Promise<LifetimeEnvelopeV1>((resolve) => {
    resolveLifetime = resolve;
  });
  let calls = 0;
  const server = await start(serviceDouble({
    getLifetime: async (repoId) => {
      calls += 1;
      return repoId === "repo-a" ? pending : ready(repoId);
    },
  }));
  try {
    for (const path of [
      "/api/observability/lifetime",
      "/api/observability/lifetime?repoId=",
      "/api/observability/lifetime?repoId=%20",
      "/api/observability/lifetime?repoId=%",
      `/api/observability/lifetime?repoId=${"x".repeat(257)}`,
      "/api/observability/lifetime?repoId=repo-a&repoId=repo-a",
    ]) {
      const response = await request(server, path);
      assert.equal(response.status, 400, path);
      assertRouteError(
        await body(response),
        "invalid_query",
        "The repoId query parameter is invalid.",
      );
    }

    const unknown = await request(server, "/api/observability/lifetime?repoId=unknown");
    assert.equal(unknown.status, 404);
    assertRouteError(
      await body(unknown),
      "repository_not_found",
      "The repository was not found.",
    );
    assert.equal(calls, 0);

    let settled = false;
    const responsePromise = request(server, "/api/observability/lifetime?repoId=repo-a")
      .then((response) => {
        settled = true;
        return response;
      });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    const expected = ready("repo-a");
    resolveLifetime(expected);
    const response = await responsePromise;
    assert.equal(response.status, 200);
    const responseBody = await body(response);
    assert.deepEqual(Object.keys(responseBody), [
      "schemaVersion", "sampleIntervalMs", "generatedAt", "repoId", "epoch",
      "resetAt", "lastCheckpointAt", "persistenceState", "sessionCount",
      "saturated", "sections", "freshness", "processPeaks",
    ]);
    assert.deepEqual(responseBody, expected);
    assert.equal(calls, 1);
  } finally {
    await server.close();
  }
});

test("disabled lifetime routes return the closed approved persistence error", async () => {
  const server = await setupObservabilityDashboardSidecar(
    0,
    { isRegisteredRepoId: (repoId) => repoId === "repo-a" },
    { enabled: true, token: "test-token" },
    async () => true,
  );
  try {
    const get = await request(server, "/api/observability/lifetime?repoId=repo-a");
    assert.equal(get.status, 503);
    assertRouteError(
      await body(get),
      "persistence_failed",
      "Repository lifetime persistence failed.",
      true,
    );

    const reset = await request(server, "/api/observability/lifetime/reset", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "not-json",
    });
    assert.equal(reset.status, 503);
    assertRouteError(
      await body(reset),
      "persistence_failed",
      "Repository lifetime persistence failed.",
      true,
    );
  } finally {
    await server.close();
  }
});

test("lifetime GET returns recovery without inventing ready fields", async () => {
  const recovery = {
    schemaVersion: 1,
    sampleIntervalMs: 2_000,
    generatedAt: NOW,
    repoId: "repo-a",
    persistenceState: "recoveryRequired",
    recoveryReason: "corruptCandidates",
  } satisfies LifetimeEnvelopeV1;
  const server = await start(serviceDouble({ getLifetime: async () => recovery }));
  try {
    const response = await request(server, "/api/observability/lifetime?repoId=repo-a");
    assert.equal(response.status, 200);
    const value = await body(response);
    assert.deepEqual(Object.keys(value), [
      "schemaVersion", "sampleIntervalMs", "generatedAt", "repoId",
      "persistenceState", "recoveryReason",
    ]);
    assert.deepEqual(value, recovery);
  } finally {
    await server.close();
  }
});

test("lifetime reset enforces bounded closed JSON and exact confirmation", async () => {
  const server = await start(serviceDouble());
  try {
    const cases: Array<{
      init: RequestInit;
      status: number;
      code: string;
      message: string;
    }> = [
      {
        init: { method: "POST", body: "{}" },
        status: 415,
        code: "unsupported_media_type",
        message: "Content-Type must be application/json.",
      },
      {
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: `{"padding":"${"x".repeat(4_096)}"}`,
        },
        status: 413,
        code: "body_too_large",
        message: "The request body exceeds 4096 bytes.",
      },
      {
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{",
        },
        status: 400,
        code: "invalid_json",
        message: "The request body must contain valid JSON.",
      },
      {
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repoId: "repo-a", confirmation: "x", extra: true }),
        },
        status: 400,
        code: "invalid_body",
        message: "The request body is invalid.",
      },
      {
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repoId: "repo-a" }),
        },
        status: 400,
        code: "invalid_body",
        message: "The request body is invalid.",
      },
      {
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repoId: 1, confirmation: true }),
        },
        status: 400,
        code: "invalid_body",
        message: "The request body is invalid.",
      },
      {
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repoId: "repo-a", confirmation: "reset repo-a" }),
        },
        status: 422,
        code: "confirmation_mismatch",
        message: "The reset confirmation does not match.",
      },
    ];

    for (const expected of cases) {
      const response = await request(
        server,
        "/api/observability/lifetime/reset",
        expected.init,
      );
      assert.equal(response.status, expected.status);
      assertRouteError(await body(response), expected.code, expected.message);
    }

    const resetJson = JSON.stringify({
      repoId: "repo-a",
      confirmation: "RESET REPOSITORY LIFETIME: repo-a",
    });
    const boundary = await request(server, "/api/observability/lifetime/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: resetJson.padEnd(4_096, " "),
    });
    assert.equal(boundary.status, 404);
    assertRouteError(
      await body(boundary),
      "repository_not_found",
      "The repository was not found.",
    );
  } finally {
    await server.close();
  }
});

test("lifetime reset maps repository and persistence outcomes without uncertain writes", async () => {
  const modes = new Map<string, LifetimeEnvelopeV1>([
    ["empty", ready("empty")],
    ["read-only", withEvent(ready("read-only", "readOnly"))],
    ["capacity", ready("capacity", "capacityExceeded")],
    ["recovery", {
      schemaVersion: 1,
      sampleIntervalMs: 2_000,
      generatedAt: NOW,
      repoId: "recovery",
      persistenceState: "recoveryRequired",
      recoveryReason: "indeterminatePublication",
    }],
  ]);
  const resetCalls: string[] = [];
  const service = serviceDouble({
    getLifetime: async (repoId) => modes.get(repoId) ?? withEvent(ready(repoId)),
    resetLifetime: async (repoId) => {
      resetCalls.push(repoId);
      if (repoId === "not-published") return withEvent(ready(repoId, "degraded"));
      if (repoId === "indeterminate") {
        modes.set(repoId, {
          schemaVersion: 1,
          sampleIntervalMs: 2_000,
          generatedAt: NOW,
          repoId,
          persistenceState: "recoveryRequired",
          recoveryReason: "indeterminatePublication",
        });
        throw new Error("publication state unavailable");
      }
      if (repoId === "failed") throw new Error("disk unavailable");
      if (repoId === "read-only-filesystem") throw new Error("read-only filesystem");
      return {
        ...withEvent(ready(repoId)),
        epoch: 1,
        resetAt: NOW,
        lastCheckpointAt: NOW,
      };
    },
  });
  const registered = new Set([
    "empty", "read-only", "capacity", "recovery", "ok",
    "not-published", "indeterminate", "failed",
    "read-only-filesystem",
  ]);
  const server = await start(service, registered);
  const reset = (repoId: string) => request(
    server,
    "/api/observability/lifetime/reset",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repoId,
        confirmation: `RESET REPOSITORY LIFETIME: ${repoId}`,
      }),
    },
  );
  try {
    const expectations = [
      ["unknown", 404, "repository_not_found", "The repository was not found.", false],
      ["empty", 404, "repository_not_found", "The repository was not found.", false],
      ["read-only", 409, "read_only", "Repository lifetime is read-only.", false],
      ["capacity", 409, "lifetime_capacity_exceeded", "Repository lifetime capacity is exceeded.", false],
      ["recovery", 409, "recovery_required", "Repository lifetime recovery is required.", false],
      ["not-published", 503, "persistence_failed", "Repository lifetime persistence failed.", true],
      ["indeterminate", 503, "persistence_indeterminate", "Repository lifetime persistence is indeterminate.", false],
      ["failed", 503, "persistence_failed", "Repository lifetime persistence failed.", true],
      ["read-only-filesystem", 503, "persistence_failed", "Repository lifetime persistence failed.", true],
    ] as const;
    for (const [repoId, status, code, message, retryable] of expectations) {
      const response = await reset(repoId);
      assert.equal(response.status, status, repoId);
      assertRouteError(await body(response), code, message, retryable);
    }
    assert.equal(resetCalls.includes("recovery"), false);
    assert.equal(resetCalls.includes("empty"), false);

    const success = await reset("ok");
    assert.equal(success.status, 200);
    const successBody = await body(success);
    assert.deepEqual(Object.keys(successBody), [
      "schemaVersion", "repoId", "epoch", "resetAt", "lastCheckpointAt",
      "persistenceState",
    ]);
    assert.deepEqual(successBody, {
      schemaVersion: 1,
      repoId: "ok",
      epoch: 1,
      resetAt: NOW,
      lastCheckpointAt: NOW,
      persistenceState: "ready",
    });
  } finally {
    await server.close();
  }
});

test("recovery reset performs zero store file operations", async () => {
  let fileOperations = 0;
  const store: LifetimeStore = {
    state: () => ({
      mode: "recoveryRequired",
      reason: "corruptCandidates",
      root: null,
      generation: null,
    }),
    checkpoint: async () => {
      fileOperations += 1;
      return { status: "notPublished", reason: "ioFailure" };
    },
    reset: async () => {
      fileOperations += 1;
      return { status: "notPublished", reason: "ioFailure" };
    },
    refreshReadOnly: async () => {
      fileOperations += 1;
      return { status: "ioFailure" };
    },
    close: async () => {
      fileOperations += 1;
    },
  };
  const service = new ObservabilityService(
    ObservabilityConfigSchema.parse({ sampleIntervalMs: 2_000 }),
    {
      lifetimeDirectory: "unused",
      openLifetimeStore: async () => store,
      isRegisteredRepoId: (repoId) => repoId === "repo-a",
      scheduleInterval: () => ({ unref() {} }),
      clearScheduledInterval: () => {},
    },
  );
  await service.start();
  const server = await start(service, new Set(["repo-a"]));
  try {
    const response = await request(server, "/api/observability/lifetime/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repoId: "repo-a",
        confirmation: "RESET REPOSITORY LIFETIME: repo-a",
      }),
    });
    assert.equal(response.status, 409);
    assertRouteError(
      await body(response),
      "recovery_required",
      "Repository lifetime recovery is required.",
    );
    assert.equal(fileOperations, 0);
  } finally {
    await server.close();
    await service.stop();
  }
});

async function readSseEvents(response: Response, count: number): Promise<Array<{
  event: string;
  data: Record<string, unknown>;
}>> {
  assert.ok(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  let buffered = "";
  while (events.length < count) {
    const next = await reader.read();
    assert.equal(next.done, false);
    buffered += decoder.decode(next.value, { stream: true });
    let boundary = buffered.indexOf("\n\n");
    while (boundary >= 0) {
      const frame = buffered.slice(0, boundary);
      buffered = buffered.slice(boundary + 2);
      const event = frame.match(/^event: (.+)$/m)?.[1];
      const rawData = frame.match(/^data: (.+)$/m)?.[1];
      if (event && rawData) events.push({ event, data: JSON.parse(rawData) as Record<string, unknown> });
      boundary = buffered.indexOf("\n\n");
    }
  }
  await reader.cancel();
  return events;
}

test("observability SSE emits an awaited lifetime event after each snapshot for its repo", async () => {
  let subscriber: SnapshotSubscriber | null = null;
  const lifetimeCalls: string[] = [];
  const service = serviceDouble({
    getLifetime: async (repoId) => {
      lifetimeCalls.push(repoId);
      await new Promise<void>((resolve) => setImmediate(resolve));
      return ready(repoId);
    },
    onSubscribe: (value) => {
      subscriber = value;
    },
  });
  const server = await start(service);
  try {
    const response = await request(server, "/api/observability/stream?repoId=repo-a");
    assert.equal(response.status, 200);
    const eventsPromise = readSseEvents(response, 4);
    while (subscriber === null) await new Promise<void>((resolve) => setImmediate(resolve));
    subscriber({ schemaVersion: 1, generatedAt: NOW, repoId: "other" } as ObservabilitySnapshot);
    subscriber({ schemaVersion: 1, generatedAt: NOW, repoId: "repo-a" } as ObservabilitySnapshot);
    const events = await eventsPromise;
    assert.deepEqual(events.map((entry) => entry.event), [
      "snapshot", "lifetime", "snapshot", "lifetime",
    ]);
    assert.deepEqual(events.map((entry) => entry.data.repoId), [
      "repo-a", "repo-a", "repo-a", "repo-a",
    ]);
    assert.deepEqual(lifetimeCalls, ["repo-a", "repo-a"]);
  } finally {
    await server.close();
  }
});
