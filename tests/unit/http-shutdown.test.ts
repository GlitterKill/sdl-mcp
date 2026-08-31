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

  it("stops HTTP producers before draining work and persisting usage", () => {
    const source = readFileSync(
      join(process.cwd(), "src", "cli", "commands", "serve.ts"),
      "utf8",
    );
    const serveSource = source.slice(
      source.indexOf("export async function serveCommand"),
    );
    const httpCleanupIndex = serveSource.indexOf(
      'shutdownMgr.addCleanup("httpServer"',
    );
    const earlyPersistUsageIndex = serveSource.indexOf(
      'shutdownMgr.addCleanup("persistUsage"',
    );
    const watcherCleanupIndex = serveSource.indexOf(
      'shutdownMgr.addCleanup("watchers"',
    );
    const verifierCleanupIndex = serveSource.indexOf(
      'shutdownMgr.addCleanup("graphIntegrityVerifier"',
    );
    const finalCleanupIndex = serveSource.indexOf(
      "registerServeFinalCleanups(shutdownMgr",
    );
    const loggerCleanupIndex = serveSource.indexOf(
      'shutdownMgr.addCleanup("logger"',
    );

    assert.ok(httpCleanupIndex >= 0, "HTTP cleanup should be registered");
    assert.equal(
      earlyPersistUsageIndex,
      -1,
      "usage persistence must not run before producer shutdown and work drain",
    );
    assert.ok(watcherCleanupIndex >= 0, "watcher cleanup should be registered");
    assert.ok(verifierCleanupIndex >= 0, "verifier cleanup should be registered");
    assert.ok(finalCleanupIndex >= 0, "final cleanup should be registered");
    assert.ok(loggerCleanupIndex >= 0, "logger cleanup should be registered");
    assert.ok(
      httpCleanupIndex < watcherCleanupIndex &&
        watcherCleanupIndex < verifierCleanupIndex &&
        verifierCleanupIndex < finalCleanupIndex &&
        finalCleanupIndex < loggerCleanupIndex,
      "HTTP transport and producers must stop before final drain/usage/DB cleanup",
    );
    assert.match(
      serveSource,
      /registerServeFinalCleanups\(shutdownMgr,\s*\{[\s\S]*?persistUsage:\s*async\s*\(\)\s*=>/,
      "serve cleanup must persist usage through the post-drain final cleanup path",
    );
  });

  it("starts durable observability before taps and transports with one live registry", () => {
    const source = readFileSync(
      join(process.cwd(), "src", "cli", "commands", "serve.ts"),
      "utf8",
    );
    const bootstrapIndex = source.indexOf("await ensureConfiguredReposRegistered");
    const seedIndex = source.indexOf("replaceRegisteredRepoIds(");
    const createIndex = source.indexOf("createObservabilityService(observabilityConfig");
    const startIndex = source.indexOf(
      "activateObservabilityAfterStart(",
      createIndex,
    );
    const sidecarIndex = source.indexOf("await setupObservabilityDashboardSidecar(");
    const httpIndex = source.indexOf("await setupHttpTransport(");

    assert.ok(bootstrapIndex >= 0 && seedIndex > bootstrapIndex);
    assert.match(
      source.slice(bootstrapIndex, seedIndex),
      /await listAllRepoIds\(await getLadybugConn\(\)\)/,
    );
    assert.ok(createIndex > seedIndex && startIndex > createIndex);
    assert.ok(sidecarIndex > startIndex && httpIndex > startIndex);
    assert.match(
      source,
      /createObservabilityService\(observabilityConfig,\s*\{\s*lifetimeDirectory: dirname\(graphDbPath\),\s*isRegisteredRepoId,\s*\}\s*\)/s,
    );
    assert.equal(
      source.slice(createIndex).match(/\bisRegisteredRepoId,/g)?.length,
      3,
      "the same exported predicate must feed the service and both HTTP surfaces",
    );
  });

  it("releases lifetime persistence before fatal startup closes the database", () => {
    const source = readFileSync(
      join(process.cwd(), "src", "cli", "commands", "serve.ts"),
      "utf8",
    );
    const fatalCatchIndex = source.lastIndexOf("} catch (error) {");
    const shutdownIndex = source.indexOf(
      'await shutdownMgr.shutdown("startup failure", 1)',
      fatalCatchIndex,
    );

    assert.ok(fatalCatchIndex >= 0);
    assert.ok(
      shutdownIndex > fatalCatchIndex,
      "fatal setup failure must use the managed producer-drain, checkpoint, and DB cleanup path",
    );
  });
});
