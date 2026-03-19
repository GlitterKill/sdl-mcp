import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { setupHttpTransport } from "../../src/cli/transport/http.js";

async function rmWithRetry(path: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code ?? "")
          : "";
      if (!["ENOTEMPTY", "EPERM", "EBUSY"].includes(code)) throw error;
      if (attempt === 9) return; // best-effort on final attempt
      await delay(100 * (attempt + 1));
    }
  }
}

test("OPTIONS /message returns CORS headers for the deprecated SSE transport", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "sdl-mcp-http-message-cors-"));
  const graphDbPath = join(tempDir, "graph.lbug");
  const server = await setupHttpTransport("127.0.0.1", 0, graphDbPath, {});
  const origin = "http://localhost:3000";

  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/message`, {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
      signal: AbortSignal.timeout(5000),
    });

    assert.strictEqual(response.status, 204);
    assert.strictEqual(response.headers.get("access-control-allow-origin"), origin);
    assert.match(response.headers.get("vary") ?? "", /Origin/);
  } finally {
    await server.close();
    await rmWithRetry(tempDir);
  }
});
