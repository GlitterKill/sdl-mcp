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
    const effectiveArgs = this.prepareToolArgs(name, args);
    const start = Date.now();
    let success = false;
    let responseSize = 0;
    let error: string | undefined;
    let result: unknown;

    try {
      const response = await this.client.callTool({
        name,
        arguments: effectiveArgs,
      });
      result = response;
      responseSize = JSON.stringify(response).length;
      success = true;

      // Check if the tool itself reported an error.
      const content = (
        response as {
          content?: Array<{ type: string; text: string }>;
          isError?: boolean;
        }
      )?.content;
      const firstText = content?.[0]?.text;
      const responseIsError = (
        response as { isError?: boolean } | undefined
      )?.isError;
      if (responseIsError) {
        success = false;
        error = firstText?.trim() || "Tool call returned isError=true";
      } else if (firstText) {
        // Back-compat: some handlers encode errors in JSON payloads.
        try {
          const parsed = JSON.parse(firstText);
          if (parsed?.error) {
            success = false;
            error =
              typeof parsed.error === "string"
                ? parsed.error
                : (parsed.error.message ?? JSON.stringify(parsed.error));
          }
        } catch {
          // Non-JSON success payload is allowed.
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
    const effectiveArgs = this.prepareToolArgs(name, args);
    const response = await this.callTool(name, effectiveArgs);
    const content = (
      response as { content?: Array<{ type: string; text: string }> }
    )?.content;
    const firstText = content?.[0]?.text;
    let parsed: Record<string, unknown>;
    if (firstText) {
      try {
        parsed = JSON.parse(firstText) as Record<string, unknown>;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Tool call ${name} returned non-JSON text payload: ${msg}; text="${firstText.slice(0, 200)}"`,
        );
      }
    } else {
      parsed = (response ?? {}) as Record<string, unknown>;
    }

    // Run result validators — fires for every known tool, no-op for unknown
    const checks = validateToolResult(name, effectiveArgs, parsed);
    if (checks.length > 0) {
      this.collector.recordResultChecks(checks);
    }
    const samples = extractSampleValues(name, parsed);
    if (Object.keys(samples).length > 0) {
      this.collector.recordSampleValues(name, samples);
    }
    this.collector.recordToolTimingDiagnostics(name, parsed.diagnostics);

    return parsed;
  }

  isConnected(): boolean {
    return this.connected;
  }

  private prepareToolArgs(
    name: string,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    if (name === "sdl.index.refresh" && args.includeDiagnostics !== true) {
      return {
        ...args,
        includeDiagnostics: true,
      };
    }
    if (name === "sdl.symbol.search" && args.wireFormat === undefined) {
      return { ...args, wireFormat: "json" };
    }
    if (name === "sdl.slice.build" && args.wireFormat === undefined) {
      return { ...args, wireFormat: "compact" };
    }
    return args;
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
