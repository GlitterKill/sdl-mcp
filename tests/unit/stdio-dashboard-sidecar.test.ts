import assert from "node:assert/strict";
import test from "node:test";

import { setupObservabilityDashboardSidecar } from "../../dist/cli/transport/http.js";

async function withCapturedStdout<T>(action: () => Promise<T>): Promise<{
  result: T;
  stdout: string[];
}> {
  const stdout: string[] = [];
  const originalWrite = process.stdout.write;

  process.stdout.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    stdout.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
    const callback = args.find((arg): arg is () => void => typeof arg === "function");
    callback?.();
    return true;
  }) as typeof process.stdout.write;

  try {
    return { result: await action(), stdout };
  } finally {
    process.stdout.write = originalWrite;
  }
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

test("stdio observability dashboard sidecar serves only observability routes", async () => {
  const snapshotCalls: string[] = [];
  const observabilityService = {
    getSnapshot(repoId: string) {
      snapshotCalls.push(repoId);
      return { schemaVersion: 1, repoId, source: "test" };
    },
    getTimeseries(repoId: string, window: string) {
      return { schemaVersion: 1, repoId, window, points: [] };
    },
    getBeamExplain(repoId: string, sliceHandle: string, symbolId?: string) {
      return { repoId, sliceHandle, symbolId: symbolId ?? null };
    },
    onSnapshot() {
      return () => {};
    },
  } as unknown as NonNullable<
    NonNullable<Parameters<typeof setupObservabilityDashboardSidecar>[1]>["observabilityService"]
  >;

  const { result: server, stdout } = await withCapturedStdout(() =>
    setupObservabilityDashboardSidecar(
      0,
      { observabilityService },
      { enabled: true, token: "test-token" },
      async () => true,
    ),
  );

  try {
    const baseUrl = `http://127.0.0.1:${server.port}`;

    const html = await fetch(`${baseUrl}/ui/observability`, {
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(html.status, 200);
    assert.match(html.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await html.text(), /observability/i);

    const js = await fetch(`${baseUrl}/ui/observability.js`, {
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(js.status, 200);
    assert.match(js.headers.get("content-type") ?? "", /javascript/);

    const css = await fetch(`${baseUrl}/ui/observability.css`, {
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type") ?? "", /text\/css/);

    const health = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(health.status, 200);
    assert.equal((await readJson(health)).status, "ok");

    const unauthorized = await fetch(
      `${baseUrl}/api/observability/snapshot?repoId=test-repo`,
      { signal: AbortSignal.timeout(5_000) },
    );
    assert.equal(unauthorized.status, 401);

    const snapshot = await fetch(
      `${baseUrl}/api/observability/snapshot?repoId=test-repo`,
      {
        headers: { Authorization: "Bearer test-token" },
        signal: AbortSignal.timeout(5_000),
      },
    );
    assert.equal(snapshot.status, 200);
    assert.equal((await readJson(snapshot)).repoId, "test-repo");
    assert.deepEqual(snapshotCalls, ["test-repo"]);

    // The SDL Galaxy viewer is served on the dashboard surface too.
    const viewerHtml = await fetch(`${baseUrl}/ui/viewer`, {
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(viewerHtml.status, 200);
    assert.match(viewerHtml.headers.get("content-type") ?? "", /text\/html/);

    // /api/graph/* shares the dashboard bearer gate.
    const graphUnauthorized = await fetch(`${baseUrl}/api/graph/skins`, {
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(graphUnauthorized.status, 401);

    const graphSkins = await fetch(`${baseUrl}/api/graph/skins`, {
      headers: { Authorization: "Bearer test-token" },
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(graphSkins.status, 200);
    assert.deepEqual(Object.keys(await readJson(graphSkins)), ["skins"]);

    for (const path of [
      "/mcp",
      "/sse",
      "/message",
      "/api/config",
      "/api/sessions",
    ]) {
      const response = await fetch(`${baseUrl}${path}`, {
        signal: AbortSignal.timeout(5_000),
      });
      assert.equal(response.status, 404, path);
    }
  } finally {
    const closed = server.serverClosed.then(() => true);
    await server.close();
    assert.equal(await closed, true);
  }

  assert.deepEqual(stdout, []);
});

test("stdio observability dashboard sidecar keeps static UI available when observability is disabled", async () => {
  const server = await setupObservabilityDashboardSidecar(
    0,
    {},
    { enabled: true, token: "test-token" },
    async () => true,
  );

  try {
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const html = await fetch(`${baseUrl}/ui/observability`, {
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(html.status, 200);

    const snapshot = await fetch(
      `${baseUrl}/api/observability/snapshot?repoId=test-repo`,
      {
        headers: { Authorization: "Bearer test-token" },
        signal: AbortSignal.timeout(5_000),
      },
    );
    assert.equal(snapshot.status, 503);
    assert.equal((await readJson(snapshot)).error, "observability_disabled");
  } finally {
    await server.close();
  }
});
