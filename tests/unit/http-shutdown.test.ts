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

  it("starts durable observability before taps and transports with one live registry", () => {
    const source = readFileSync(
      join(process.cwd(), "src", "cli", "commands", "serve.ts"),
      "utf8",
    );
    const bootstrapIndex = source.indexOf("await ensureConfiguredReposRegistered");
    const seedIndex = source.indexOf("replaceRegisteredRepoIds(");
    const createIndex = source.indexOf("createObservabilityService(observabilityConfig");
    const startIndex = source.indexOf("await observabilityService.start()");
    const tapIndex = source.indexOf("installObservabilityTap(observabilityService)");
    const probeIndex = source.indexOf("startRuntimeProbes(observabilityConfig)");
    const sidecarIndex = source.indexOf("await setupObservabilityDashboardSidecar(");
    const httpIndex = source.indexOf("await setupHttpTransport(");

    assert.ok(bootstrapIndex >= 0 && seedIndex > bootstrapIndex);
    assert.match(
      source.slice(bootstrapIndex, seedIndex),
      /await listAllRepoIds\(await getLadybugConn\(\)\)/,
    );
    assert.ok(createIndex > seedIndex && startIndex > createIndex);
    assert.ok(tapIndex > startIndex && probeIndex > startIndex);
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

  it("awaits the final lifetime checkpoint before database and logger cleanup", () => {
    const source = readFileSync(
      join(process.cwd(), "src", "cli", "commands", "serve.ts"),
      "utf8",
    );
    assert.match(
      source,
      /shutdownMgr\.addCleanup\("observability", stopObservability\);/,
    );

    const serverIndex = source.indexOf('shutdownMgr.addCleanup("server"');
    const dashboardIndex = source.indexOf(
      'shutdownMgr.addCleanup("observabilityDashboard"',
    );
    const httpIndex = source.indexOf('shutdownMgr.addCleanup("httpServer"');
    const watchersIndex = source.indexOf('shutdownMgr.addCleanup("watchers"');
    const verifierIndex = source.indexOf(
      'shutdownMgr.addCleanup("graphIntegrityVerifier"',
    );
    const drainIndex = source.indexOf('shutdownMgr.addCleanup("workDrain"');
    const observabilityIndex = source.indexOf(
      'shutdownMgr.addCleanup("observability"',
    );
    const dbIndex = source.indexOf('shutdownMgr.addCleanup("db"');
    const loggerIndex = source.indexOf('shutdownMgr.addCleanup("logger"');
    assert.ok(
      serverIndex >= 0 &&
        dashboardIndex > serverIndex &&
        httpIndex > dashboardIndex &&
        watchersIndex > httpIndex &&
        verifierIndex > watchersIndex &&
        drainIndex > verifierIndex &&
        observabilityIndex > drainIndex &&
        dbIndex > observabilityIndex &&
        loggerIndex > dbIndex,
      "all event producers and transports must finish before the final checkpoint",
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
