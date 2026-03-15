/**
 * Client Factory — creates MCP SDK clients that connect via StreamableHTTP.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import type { MetricsCollector } from "./metrics-collector.js";
import { validateToolResult, extractSampleValues } from "./result-validator.js";
import { stressLog } from "./types.js";

export class StressClient {
  readonly clientId: string;
  private client: Client;
  private transport: StreamableHTTPClientTransport;
  private collector: MetricsCollector;
  private connected: boolean = false;
  private verbose: boolean;

  constructor(
    port: number,
    clientId: string,
    collector: MetricsCollector,
    verbose: boolean = false,
    authToken?: string,
  ) {
    this.clientId = clientId;
    this.collector = collector;
    this.verbose = verbose;

    this.transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`),
      authToken
        ? {
            requestInit: {
              headers: { Authorization: `Bearer ${authToken}` },
            },
          }
        : undefined,
    );

    this.client = new Client({
      name: `stress-client-${clientId}`,
      version: "1.0.0",
    });
  }

  async connect(): Promise<void> {
    await this.client.connect(this.transport);
    this.connected = true;
    if (this.verbose) {
      stressLog("debug", `Client ${this.clientId} connected`);
    }
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;
    try {
      // terminateSession sends DELETE /mcp to clean up server-side session
      await this.transport.terminateSession();
    } catch {
      // Best-effort session termination
    }
    try {
      await this.transport.close();
    } catch {
      // Best-effort close
    }
    this.connected = false;
    if (this.verbose) {
      stressLog("debug", `Client ${this.clientId} disconnected`);
    }
  }

  async callTool(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<unknown> {
    const start = Date.now();
    let success = false;
    let responseSize = 0;
    let error: string | undefined;
    let result: unknown;

    try {
      const response = await this.client.callTool({ name, arguments: args });
      result = response;
      responseSize = JSON.stringify(response).length;
      success = true;

      // Check if the tool itself reported an error
      const content = (
        response as { content?: Array<{ type: string; text: string }> }
      )?.content;
      if (content?.[0]?.text) {
        try {
          const parsed = JSON.parse(content[0].text);
          if (parsed?.error) {
            success = false;
            error =
              typeof parsed.error === "string"
                ? parsed.error
                : (parsed.error.message ?? JSON.stringify(parsed.error));
          }
        } catch {
          // Not JSON, that's fine
        }
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      success = false;
    }

    const durationMs = Date.now() - start;
    this.collector.recordToolCall(
      this.clientId,
      name,
      durationMs,
      success,
      responseSize,
      error,
    );

    if (this.verbose) {
      const status = success ? "ok" : "error";
      stressLog("info", `${name}`, {
        client: this.clientId,
        status,
        duration: `${durationMs}ms`,
        size: `${responseSize}b`,
        ...(error ? { error } : {}),
      });
    }

    if (!success && error) {
      throw new Error(`Tool call ${name} failed: ${error}`);
    }

    return result;
  }

  /**
   * Call a tool and return the parsed JSON from the first text content block.
   *
   * Automatically runs result validators from `result-validator.ts` and
   * records checks + sample values in the MetricsCollector.  This makes
   * every scenario a release smoke-test for tool correctness.
   */
  async callToolParsed(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const response = await this.callTool(name, args);
    const content = (
      response as { content?: Array<{ type: string; text: string }> }
    )?.content;
    const parsed: Record<string, unknown> = content?.[0]?.text
      ? (JSON.parse(content[0].text) as Record<string, unknown>)
      : ((response ?? {}) as Record<string, unknown>);

    // Run result validators — fires for every known tool, no-op for unknown
    const checks = validateToolResult(name, args, parsed);
    if (checks.length > 0) {
      this.collector.recordResultChecks(checks);
    }
    const samples = extractSampleValues(name, parsed);
    if (Object.keys(samples).length > 0) {
      this.collector.recordSampleValues(name, samples);
    }

    return parsed;
  }

  isConnected(): boolean {
    return this.connected;
  }
}

/**
 * Factory function to create and connect a stress client.
 */
export async function createStressClient(
  port: number,
  clientId: string,
  collector: MetricsCollector,
  verbose: boolean = false,
  authToken?: string,
): Promise<StressClient> {
  const client = new StressClient(
    port,
    clientId,
    collector,
    verbose,
    authToken,
  );
  await client.connect();
  return client;
}

/**
 * Create multiple stress clients in parallel.
 */
export async function createStressClients(
  port: number,
  count: number,
  collector: MetricsCollector,
  verbose: boolean = false,
  startIndex: number = 0,
  authToken?: string,
): Promise<StressClient[]> {
  const clients = await Promise.all(
    Array.from({ length: count }, (_, i) =>
      createStressClient(
        port,
        `stress-${startIndex + i}`,
        collector,
        verbose,
        authToken,
      ),
    ),
  );
  return clients;
}

/**
 * Disconnect all clients, swallowing errors.
 */
export async function disconnectAll(clients: StressClient[]): Promise<void> {
  await Promise.allSettled(clients.map((c) => c.disconnect()));
}
