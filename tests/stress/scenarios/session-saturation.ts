/**
 * Scenario 4: Session Saturation
 *
 * Tests session limit enforcement: fill to maxSessions, verify 503 rejection,
 * disconnect one, verify recovery.
 *
 * Server must be configured with maxSessions: 4 for this scenario.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { MetricsCollector } from "../infra/metrics-collector.js";
import {
  createStressClient,
  createStressClients,
  disconnectAll,
} from "../infra/client-factory.js";
import type { ScenarioContext, ScenarioResult } from "../infra/types.js";
import { stressLog } from "../infra/types.js";

const MAX_SESSIONS_FOR_TEST = 4;

export async function runSessionSaturation(
  ctx: ScenarioContext,
): Promise<ScenarioResult> {
  const { config, serverPort, log } = ctx;
  const collector = new MetricsCollector();
  const warnings: string[] = [];
  const start = Date.now();
  let passed = true;

  collector.recordMemorySnapshot();

  // Setup: register and index fixture repo (this scenario uses its own server)
  log("Setup: Registering and indexing fixture repo");
  const setupCollector = new MetricsCollector();
  const setupClient = await createStressClient(
    serverPort,
    "sat-setup",
    setupCollector,
    config.verbose,
  );
  try {
    await setupClient.callToolParsed("sdl.repo.register", {
      repoId: "stress-fixtures",
      rootPath: config.fixturePath,
    });
    await setupClient.callToolParsed("sdl.index.refresh", {
      repoId: "stress-fixtures",
      mode: "full",
    });
  } finally {
    await disconnectAll([setupClient]);
  }

  const connectedClients: import("../infra/client-factory.js").StressClient[] =
    [];

  try {
    // 1. Connect clients 1-4 — all should succeed
    log(
      `Step 1: Connecting ${MAX_SESSIONS_FOR_TEST} clients (should all succeed)`,
    );
    for (let i = 0; i < MAX_SESSIONS_FOR_TEST; i++) {
      try {
        const client = await createStressClient(
          serverPort,
          `sat-${i}`,
          collector,
          config.verbose,
        );
        connectedClients.push(client);
        log(`  Client sat-${i} connected`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        stressLog("error", `Client sat-${i} failed to connect: ${msg}`);
        passed = false;
        warnings.push(`Client sat-${i} should have connected but got: ${msg}`);
      }
    }

    if (connectedClients.length !== MAX_SESSIONS_FOR_TEST) {
      passed = false;
      warnings.push(
        `Expected ${MAX_SESSIONS_FOR_TEST} connected, got ${connectedClients.length}`,
      );
    }

    // 2. Attempt client 5 — should get 503 rejection
    log("Step 2: Attempting client 5 (should be rejected with 503)");
    let rejectionOk = false;
    try {
      const transport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${serverPort}/mcp`),
      );
      const client5 = new Client({
        name: "stress-client-sat-overflow",
        version: "1.0.0",
      });
      await client5.connect(transport);

      // If we got here, the session wasn't rejected — that's a failure
      warnings.push(
        "Client 5 connected successfully but should have been rejected (503)",
      );
      // Clean up
      try {
        await transport.terminateSession();
        await transport.close();
      } catch {
        /* best effort */
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes("503") ||
        msg.includes("session limit") ||
        msg.includes("Service unavailable")
      ) {
        rejectionOk = true;
        log("  Client 5 correctly rejected (503)");
      } else {
        warnings.push(`Client 5 rejected with unexpected error: ${msg}`);
      }
    }

    if (!rejectionOk) {
      passed = false;
      warnings.push(
        "Session limit enforcement failed: 5th client was not rejected",
      );
    }

    // 3. Disconnect client 1
    log("Step 3: Disconnecting client sat-0 to free a slot");
    if (connectedClients.length > 0) {
      await connectedClients[0].disconnect();
    }

    // 4. Wait for session cleanup
    log("Step 4: Waiting 500ms for session cleanup");
    await new Promise((r) => setTimeout(r, 500));

    // 5. Connect client 5 again — should now succeed
    log("Step 5: Reconnecting new client (should succeed after slot freed)");
    let recoveryOk = false;
    try {
      const recoveredClient = await createStressClient(
        serverPort,
        "sat-recovery",
        collector,
        config.verbose,
      );
      connectedClients.push(recoveredClient);
      recoveryOk = true;
      log("  Recovery client connected successfully");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`Recovery client failed: ${msg}`);
    }

    if (!recoveryOk) {
      passed = false;
      warnings.push(
        "Session recovery failed: new client could not connect after slot was freed",
      );
    }

    // 6. Check session stats via REST API
    log("Step 6: Checking session stats via /api/sessions");
    try {
      const response = await fetch(
        `http://127.0.0.1:${serverPort}/api/sessions`,
      );
      const stats = (await response.json()) as {
        activeSessions?: number;
        maxSessions?: number;
      };
      log(
        `  Sessions: active=${stats?.activeSessions}, max=${stats?.maxSessions}`,
      );

      if (stats?.maxSessions !== MAX_SESSIONS_FOR_TEST) {
        warnings.push(
          `Expected maxSessions=${MAX_SESSIONS_FOR_TEST}, got ${stats?.maxSessions}`,
        );
      }
    } catch (err) {
      warnings.push(
        `Failed to fetch session stats: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // 7. All remaining clients perform one search
    log("Step 7: All connected clients perform sdl.symbol.search");
    const activeClients = connectedClients.filter((c) => c.isConnected());
    const searchResults = await Promise.allSettled(
      activeClients.map((c) =>
        c.callToolParsed("sdl.symbol.search", {
          repoId: "stress-fixtures",
          query: "User",
          limit: 5,
        }),
      ),
    );

    const searchFailures = searchResults.filter((r) => r.status === "rejected");
    if (searchFailures.length > 0) {
      passed = false;
      warnings.push(
        `${searchFailures.length}/${activeClients.length} clients failed symbol search after recovery`,
      );
    } else {
      log(
        `  All ${activeClients.length} clients completed search successfully`,
      );
    }

    collector.recordMemorySnapshot();
  } finally {
    // 8. Disconnect all
    log("Step 8: Disconnecting all clients");
    await disconnectAll(connectedClients);
  }

  return {
    name: "session-saturation",
    passed,
    clients: MAX_SESSIONS_FOR_TEST + 1,
    durationMs: Date.now() - start,
    toolMetrics: collector.getAllToolMetrics(),
    errors: collector.getErrors(),
    memoryPeakMB: collector.getMemoryPeakMB(),
    warnings,
    toolResultStats: collector.getResultStats(),
  };
}
