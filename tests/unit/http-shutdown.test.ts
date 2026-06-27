import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { setupHttpTransport } from "../../dist/cli/transport/http.js";
import { SessionManager } from "../../dist/mcp/session-manager.js";

describe("HTTP shutdown wiring", () => {
  it("closes Streamable HTTP session transports during server shutdown", () => {
    const source = readFileSync(
      join(process.cwd(), "src", "cli", "transport", "http.ts"),
      "utf8",
    );

    assert.match(
      source,
      /for \(const sid of \[\.\.\.transports\.keys\(\)\]\) \{\s*cleanupSession\(sid, \{ closeTransport: true \}\);\s*\}/s,
      "HTTP shutdown must close session transports so long-lived streams cannot keep sockets alive",
    );
  });

  it("calls transport.close() for active Streamable HTTP sessions", async () => {
    const originalClose = StreamableHTTPServerTransport.prototype.close;
    let closeCalls = 0;
    StreamableHTTPServerTransport.prototype.close = async function closeSpy() {
      closeCalls++;
      return originalClose.call(this);
    };

    const sessionManager = new SessionManager(2);
    const httpHandle = await setupHttpTransport(
      "127.0.0.1",
      0,
      "unused-test-db.lbug",
      { sessionManager },
      { enabled: false },
      { allowRemote: false },
    );

    try {
      const url = `http://127.0.0.1:${httpHandle.port}/mcp`;
      const initializeResponse = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: LATEST_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "sdl-mcp-shutdown-test", version: "1.0.0" },
          },
        }),
      });
      const initializeBody = await initializeResponse.text();
      assert.strictEqual(initializeResponse.status, 200, initializeBody);

      const sessionId = initializeResponse.headers.get("mcp-session-id");
      assert.ok(sessionId, "initialize response should include a session id");
      assert.strictEqual(sessionManager.getStats().activeSessions, 1);

      await httpHandle.close();

      assert.ok(closeCalls > 0, "shutdown should close active transports");
      assert.strictEqual(sessionManager.getStats().activeSessions, 0);
    } finally {
      StreamableHTTPServerTransport.prototype.close = originalClose;
      await httpHandle.close().catch(() => {});
    }
  });

  it("registers HTTP server cleanup before final DB cleanup", () => {
    const source = readFileSync(
      join(process.cwd(), "src", "cli", "commands", "serve.ts"),
      "utf8",
    );
    const httpCleanupIndex = source.indexOf(
      'shutdownMgr.addCleanup("httpServer"',
    );
    const persistUsageIndex = source.indexOf(
      'shutdownMgr.addCleanup("persistUsage"',
    );
    const dbCleanupIndex = source.indexOf('shutdownMgr.addCleanup("db"');
    const loggerCleanupIndex = source.indexOf(
      'shutdownMgr.addCleanup("logger"',
    );

    assert.ok(httpCleanupIndex >= 0, "HTTP cleanup should be registered");
    assert.ok(
      persistUsageIndex >= 0,
      "usage persistence cleanup should be registered",
    );
    assert.ok(dbCleanupIndex >= 0, "DB cleanup should be registered");
    assert.ok(loggerCleanupIndex >= 0, "logger cleanup should be registered");
    assert.ok(
      httpCleanupIndex < persistUsageIndex &&
        persistUsageIndex < dbCleanupIndex &&
        dbCleanupIndex < loggerCleanupIndex,
      "HTTP transport cleanup must run before usage persistence and final DB/logger cleanup",
    );
  });
});
