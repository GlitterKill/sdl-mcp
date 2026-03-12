import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { setupHttpTransport } from "../../src/cli/transport/http.js";

async function captureUncaughtException(
  action: () => Promise<Response>,
): Promise<{ response?: Response; requestError?: unknown; uncaughtError: Error | null }> {
  let cleanup = () => {};
  const uncaughtPromise = new Promise<Error | null>((resolve) => {
    const timer = setTimeout(() => {
      process.removeListener("uncaughtException", onUncaughtException);
      resolve(null);
    }, 200);

    function onUncaughtException(error: Error): void {
      clearTimeout(timer);
      resolve(error);
    }

    process.once("uncaughtException", onUncaughtException);
    cleanup = () => {
      clearTimeout(timer);
      process.removeListener("uncaughtException", onUncaughtException);
    };
  });

  try {
    const response = await action();
    const uncaughtError = await uncaughtPromise;
    return { response, uncaughtError };
  } catch (requestError) {
    const uncaughtError = await uncaughtPromise;
    return { requestError, uncaughtError };
  } finally {
    cleanup();
  }
}

test("GET /ui/graph returns 500 instead of crashing when the asset stream cannot open", async () => {
  const graphHtmlPath = fileURLToPath(
    new URL("../../src/ui/graph.html", import.meta.url),
  );
  const graphUiDir = dirname(graphHtmlPath);
  const tempDir = await mkdtemp(join(tmpdir(), "sdl-mcp-http-ui-"));
  const backupPath = join(graphUiDir, "graph.html.test-backup");
  const graphDbPath = join(tempDir, "graph.lbug");

  await rename(graphHtmlPath, backupPath);
  await mkdir(graphHtmlPath);

  let server;
  try {
    server = await setupHttpTransport("127.0.0.1", 0, graphDbPath, {});
    const result = await captureUncaughtException(() =>
      fetch(`http://127.0.0.1:${server.port}/ui/graph`, {
        signal: AbortSignal.timeout(5_000),
      }),
    );

    assert.equal(result.uncaughtError, null);
    assert.equal(result.requestError, undefined);
    assert.ok(result.response);
    assert.equal(result.response.status, 500);

    const payload = (await result.response.json()) as { error?: unknown };
    assert.match(String(payload.error ?? ""), /ui asset/i);
  } finally {
    await server?.close();
    await rm(graphHtmlPath, { recursive: true, force: true });
    await rename(backupPath, join(graphUiDir, "graph.html"));
    await rm(tempDir, { recursive: true, force: true });
  }
});
