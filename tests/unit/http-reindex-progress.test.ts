import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

describe("HTTP reindex progress serialization", () => {
  it("preserves embedding model metadata in SSE progress payloads", async () => {
    const { serializeReindexProgressEvent } = await import(
      "../../dist/cli/transport/http.js"
    );

    const payload = serializeReindexProgressEvent({
      stage: "embeddings",
      current: 17,
      total: 42,
      substage: "fileSummaryEmbeddings",
      model: "jina-embeddings-v2-base-code",
    });

    assert.deepStrictEqual(JSON.parse(JSON.stringify(payload)), {
      stage: "embeddings",
      current: 17,
      total: 42,
      substage: "fileSummaryEmbeddings",
      model: "jina-embeddings-v2-base-code",
    });
  });

  it("preserves provider-first substage metadata in SSE progress payloads", async () => {
    const { serializeReindexProgressEvent } = await import(
      "../../dist/cli/transport/http.js"
    );

    const payload = serializeReindexProgressEvent({
      stage: "providerFirst",
      current: 0,
      total: 0,
      substage: "providerCollection.sourceLines",
      stageCurrent: 12,
      stageTotal: 40,
      message: "loaded source lines for 12/40 provider document(s)",
    });

    assert.deepStrictEqual(JSON.parse(JSON.stringify(payload)), {
      stage: "providerFirst",
      current: 0,
      total: 0,
      substage: "providerCollection.sourceLines",
      stageCurrent: 12,
      stageTotal: 40,
      message: "loaded source lines for 12/40 provider document(s)",
    });
  });
});

it("keeps the reindex stream alive while generation emits no progress", () => {
  const result = spawnSync(process.execPath, [
    "--experimental-test-module-mocks", "--input-type=module", "-e",
    `
      import assert from "node:assert/strict";
      import { mock } from "node:test";
      import { pathToFileURL } from "node:url";
      import { resolve } from "node:path";
      const moduleUrl = pathToFileURL(resolve("dist/indexer/indexer.js"));
      const original = await import(moduleUrl.href);
      let release;
      const held = new Promise(resolve => { release = resolve; });
      mock.module(moduleUrl.href, { namedExports: {
        ...original,
        indexRepo: async () => { await held; throw new Error("test indexing failure"); },
      } });
      const { setupHttpTransport } = await import("./dist/cli/transport/http.js");
      const server = await setupHttpTransport("127.0.0.1", 0, "unused.lbug",
        { checkDatabaseHealth: async () => true }, { enabled: false });
      try {
        const response = await fetch("http://127.0.0.1:" + server.port + "/api/repo/test/reindex-stream",
          { method: "POST", body: "{}", signal: AbortSignal.timeout(4500) });
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const separator = String.fromCharCode(10, 10);
        let heartbeats = "";
        while (heartbeats.split(separator).length < 3) {
          const next = await reader.read();
          assert.equal(next.done, false);
          heartbeats += decoder.decode(next.value);
        }
        assert.ok(heartbeats.split(separator).filter(Boolean).every(block => block === ": heartbeat"));
        release();
        let tail = "";
        for (;;) { const next = await reader.read(); if (next.done) break; tail += decoder.decode(next.value); }
        assert.match(tail, /event: error/);
        assert.match(tail, /test indexing failure/);
      } finally {
        release();
        await server.close();
      }
    `,
  ], { cwd: process.cwd(), encoding: "utf8", timeout: 15000, windowsHide: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
