import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { setupHttpTransport } from "../../dist/cli/transport/http.js";
import {
  _resetViewerRuntimeConfigForTesting,
  setViewerRuntimeConfig,
} from "../../dist/viewer/viewer-config.js";

const AUTH = { Authorization: "Bearer viewer-test-token" };

test("viewer API: auth gating, skins listing, traversal rejection, graph SSE", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "sdl-mcp-viewer-api-"));
  const skinsDir = join(tempDir, "skins");
  await mkdir(skinsDir, { recursive: true });
  setViewerRuntimeConfig({ skinsDir }, null);

  const recentEvents = [
    { type: "graph.index.completed", repoId: "repo-a", mode: "refresh", symbolCount: 3 },
  ];
  const observabilityService = {
    getRecentGraphEvents: () => recentEvents,
    onGraphEvent: () => () => {},
  } as unknown as NonNullable<
    Parameters<typeof setupHttpTransport>[3]
  >["observabilityService"];

  let server;
  try {
    server = await setupHttpTransport(
      "127.0.0.1",
      0,
      join(tempDir, "graph.lbug"),
      { observabilityService },
      { enabled: true, token: "viewer-test-token" },
    );
    const base = `http://127.0.0.1:${server.port}`;

    // Bearer auth required on /api/graph/*.
    const unauthorized = await fetch(`${base}/api/graph/skins`, {
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(unauthorized.status, 401);

    // Empty skins dir lists as [].
    const empty = await fetch(`${base}/api/graph/skins`, {
      headers: AUTH,
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(empty.status, 200);
    assert.deepEqual(await empty.json(), { skins: [] });

    // Listing is deterministic and byte-identical across calls.
    await writeFile(join(skinsDir, "starlight.zip"), Buffer.from("PKstub"));
    const first = await (
      await fetch(`${base}/api/graph/skins`, { headers: AUTH, signal: AbortSignal.timeout(5_000) })
    ).text();
    const second = await (
      await fetch(`${base}/api/graph/skins`, { headers: AUTH, signal: AbortSignal.timeout(5_000) })
    ).text();
    assert.equal(first, second);
    assert.match(first, /"id":"starlight"/);

    // Path traversal style ids are rejected before touching the filesystem.
    const traversal = await fetch(`${base}/api/graph/skins/..%2Fevil`, {
      headers: AUTH,
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(traversal.status, 400);

    // Recent graph events endpoint returns the ring buffer contents.
    const recent = await fetch(`${base}/api/graph/events/recent`, {
      headers: AUTH,
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(recent.status, 200);
    assert.deepEqual(await recent.json(), { events: recentEvents });

    // Graph SSE rides the observability stream via ?types=graph and
    // backfills buffered events on connect.
    const controller = new AbortController();
    const stream = await fetch(`${base}/api/observability/stream?types=graph`, {
      headers: { ...AUTH, Accept: "text/event-stream" },
      signal: controller.signal,
    });
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/);
    assert(stream.body, "SSE stream body expected");
    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes("\n\n")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    controller.abort();
    assert.match(text, /event: graph/);
    assert.match(text, /graph\.index\.completed/);

    // Without ?types=graph the stream keeps its legacy repoId contract.
    const missingRepo = await fetch(`${base}/api/observability/stream`, {
      headers: AUTH,
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(missingRepo.status, 400);
  } finally {
    _resetViewerRuntimeConfigForTesting();
    await server?.close();
    await delay(100);
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});
