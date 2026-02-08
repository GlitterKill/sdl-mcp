#!/usr/bin/env node

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFile, writeFile, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface E2EStep {
  name: string;
  tool: string;
  request: unknown;
  response: unknown;
  duration: number;
  error?: string;
  schemaValid: boolean;
}

interface E2EResult {
  timestamp: string;
  repoId: string;
  repoPath: string;
  steps: E2EStep[];
  totalDuration: number;
  success: boolean;
}

interface GoldenE2EFixture {
  name: string;
  description: string;
  steps: Array<{
    name: string;
    tool: string;
    expectedSchema: unknown;
  }>;
}

class GoldenE2ERunner {
  private client: Client;
  private results: E2EStep[] = [];

  constructor() {
    this.client = new Client({
      name: "golden-e2e-runner",
      version: "1.0.0",
    });
  }

  async startServer(configPath?: string): Promise<void> {
    const env: Record<string, string> = {
      ...process.env,
      NODE_ENV: "test",
    };

    if (configPath) {
      env.SDL_CONFIG = configPath;
    }

    const transport = new StdioClientTransport({
      command: "node",
      args: ["dist/main.js"],
      env,
    });

    await this.client.connect(transport);
  }

  async runFullE2EFlow(
    repoPath: string,
    repoId: string,
    fixtureName?: string,
  ): Promise<E2EResult> {
    const startTime = Date.now();
    this.results = [];

    console.log("=".repeat(60));
    console.log("SDL-MCP v0.5 Golden E2E Test");
    console.log("=".repeat(60));
    console.log(`Repo: ${repoPath}`);
    console.log(`Repo ID: ${repoId}`);
    console.log("=".repeat(60));

    try {
      await this.step_registerRepo(repoPath, repoId);
      await this.step_indexRepo(repoId);
      const sliceHandle = await this.step_buildSlice(repoId);
      await this.step_refreshSlice(repoId, sliceHandle);
      await this.step_getCardWithETag(repoId);
      await this.step_getSkeletonWithIR(repoId);
      await this.step_getHotPath(repoId);
      await this.step_requestWindowWithPolicy(repoId);

      const success = this.results.every((r) => r.schemaValid && !r.error);
      const totalDuration = Date.now() - startTime;

      const result: E2EResult = {
        timestamp: new Date().toISOString(),
        repoId,
        repoPath,
        steps: this.results,
        totalDuration,
        success,
      };

      if (fixtureName) {
        await this.saveGoldenFixture(fixtureName, result);
      }

      return result;
    } catch (error) {
      console.error(
        `\n❌ E2E flow failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  private async step_registerRepo(
    repoPath: string,
    repoId: string,
  ): Promise<void> {
    const name = "Register Repository";
    console.log(`\n[1/8] ${name}...`);

    const start = Date.now();
    try {
      const response = await this.client.request(
        {
          method: "tools/call",
          params: {
            name: "sdl.repo.register",
            arguments: {
              repoId,
              rootPath: repoPath,
            },
          },
        },
        CallToolRequestSchema,
      );

      const duration = Date.now() - start;
      const schemaValid = this.validateSchema(response, {
        registered: "boolean",
        repoId: "string",
      });

      this.results.push({
        name,
        tool: "sdl.repo.register",
        request: { repoId, rootPath: repoPath },
        response: this.redactSensitiveFields(response),
        duration,
        schemaValid,
      });

      console.log(`   ✅ ${name} (${duration}ms)`);
    } catch (error) {
      const duration = Date.now() - start;
      this.results.push({
        name,
        tool: "sdl.repo.register",
        request: { repoId, rootPath: repoPath },
        response: {},
        duration,
        schemaValid: false,
        error: error instanceof Error ? error.message : String(error),
      });
      console.error(
        `   ❌ ${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  private async step_indexRepo(repoId: string): Promise<void> {
    const name = "Index Repository";
    console.log(`\n[2/8] ${name}...`);

    const start = Date.now();
    try {
      const response = await this.client.request(
        {
          method: "tools/call",
          params: {
            name: "sdl.index.refresh",
            arguments: {
              repoId,
              mode: "full",
            },
          },
        },
        CallToolRequestSchema,
      );

      const duration = Date.now() - start;
      const schemaValid = this.validateSchema(response, {
        indexed: "boolean",
        fileCount: "number",
        symbolCount: "number",
      });

      this.results.push({
        name,
        tool: "sdl.index.refresh",
        request: { repoId, mode: "full" },
        response: this.redactSensitiveFields(response),
        duration,
        schemaValid,
      });

      console.log(`   ✅ ${name} (${duration}ms)`);
    } catch (error) {
      const duration = Date.now() - start;
      this.results.push({
        name,
        tool: "sdl.index.refresh",
        request: { repoId, mode: "full" },
        response: {},
        duration,
        schemaValid: false,
        error: error instanceof Error ? error.message : String(error),
      });
      console.error(
        `   ❌ ${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  private async step_buildSlice(repoId: string): Promise<string> {
    const name = "Build Slice (with Handle + Lease)";
    console.log(`\n[3/8] ${name}...`);

    const start = Date.now();
    try {
      const response = await this.client.request(
        {
          method: "tools/call",
          params: {
            name: "sdl.slice.build",
            arguments: {
              repoId,
              taskText: "golden e2e test flow",
            },
          },
        },
        CallToolRequestSchema,
      );

      const duration = Date.now() - start;
      const schemaValid = this.validateSchema(response, {
        sliceHandle: "string",
        ledgerVersion: "string",
        lease: "object",
        slice: "object",
      });

      const sliceHandle =
        (response as { sliceHandle?: string }).sliceHandle || "";

      this.results.push({
        name,
        tool: "sdl.slice.build",
        request: { repoId, taskText: "golden e2e test flow" },
        response: this.redactSensitiveFields(response),
        duration,
        schemaValid,
      });

      console.log(`   ✅ ${name} (${duration}ms) - Handle: ${sliceHandle}`);
      return sliceHandle;
    } catch (error) {
      const duration = Date.now() - start;
      this.results.push({
        name,
        tool: "sdl.slice.build",
        request: { repoId, taskText: "golden e2e test flow" },
        response: {},
        duration,
        schemaValid: false,
        error: error instanceof Error ? error.message : String(error),
      });
      console.error(
        `   ❌ ${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  private async step_refreshSlice(
    repoId: string,
    sliceHandle: string,
  ): Promise<void> {
    const name = "Refresh Slice (Delta-only)";
    console.log(`\n[4/8] ${name}...`);

    const start = Date.now();
    try {
      const response = await this.client.request(
        {
          method: "tools/call",
          params: {
            name: "sdl.slice.refresh",
            arguments: {
              sliceHandle,
              knownVersion: "initial",
            },
          },
        },
        CallToolRequestSchema,
      );

      const duration = Date.now() - start;
      const schemaValid = this.validateSchema(response, {
        sliceHandle: "string",
        notModified: "boolean",
      });

      this.results.push({
        name,
        tool: "sdl.slice.refresh",
        request: { sliceHandle, knownVersion: "initial" },
        response: this.redactSensitiveFields(response),
        duration,
        schemaValid,
      });

      console.log(`   ✅ ${name} (${duration}ms)`);
    } catch (error) {
      const duration = Date.now() - start;
      this.results.push({
        name,
        tool: "sdl.slice.refresh",
        request: { sliceHandle, knownVersion: "initial" },
        response: {},
        duration,
        schemaValid: false,
        error: error instanceof Error ? error.message : String(error),
      });
      console.error(
        `   ❌ ${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  private async step_getCardWithETag(repoId: string): Promise<void> {
    const name = "Get Card (with ETag support)";
    console.log(`\n[5/8] ${name}...`);

    const start = Date.now();
    try {
      const searchResponse = await this.client.request(
        {
          method: "tools/call",
          params: {
            name: "sdl.symbol.search",
            arguments: {
              repoId,
              query: "test",
              limit: 1,
            },
          },
        },
        CallToolRequestSchema,
      );

      const searchData = searchResponse as unknown as { results?: unknown[] };
      const results = searchData.results || [];

      if (results.length === 0) {
        console.log(`   ⚠️  ${name} - No symbols found, skipping`);
        return;
      }

      const firstSymbol = results[0] as { symbolId?: string };
      const symbolId = firstSymbol.symbolId;

      if (!symbolId) {
        console.log(`   ⚠️  ${name} - Invalid symbolId, skipping`);
        return;
      }

      const response = await this.client.request(
        {
          method: "tools/call",
          params: {
            name: "sdl.symbol.getCard",
            arguments: {
              repoId,
              symbolId,
            },
          },
        },
        CallToolRequestSchema,
      );

      const duration = Date.now() - start;
      const schemaValid = this.validateSchema(response, {
        symbolId: "string",
        kind: "string",
        name: "string",
        etag: "string",
      });

      this.results.push({
        name,
        tool: "sdl.symbol.getCard",
        request: { repoId, symbolId },
        response: this.redactSensitiveFields(response),
        duration,
        schemaValid,
      });

      console.log(`   ✅ ${name} (${duration}ms)`);
    } catch (error) {
      const duration = Date.now() - start;
      this.results.push({
        name,
        tool: "sdl.symbol.getCard",
        request: { repoId, symbolId: "unknown" },
        response: {},
        duration,
        schemaValid: false,
        error: error instanceof Error ? error.message : String(error),
      });
      console.warn(
        `   ⚠️  ${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async step_getSkeletonWithIR(repoId: string): Promise<void> {
    const name = "Get Skeleton (with IR)";
    console.log(`\n[6/8] ${name}...`);

    const start = Date.now();
    try {
      const searchResponse = await this.client.request(
        {
          method: "tools/call",
          params: {
            name: "sdl.symbol.search",
            arguments: {
              repoId,
              query: "test",
              limit: 1,
            },
          },
        },
        CallToolRequestSchema,
      );

      const searchData = searchResponse as unknown as { results?: unknown[] };
      const results = searchData.results || [];

      if (results.length === 0) {
        console.log(`   ⚠️  ${name} - No symbols found, skipping`);
        return;
      }

      const firstSymbol = results[0] as { symbolId?: string };
      const symbolId = firstSymbol.symbolId;

      if (!symbolId) {
        console.log(`   ⚠️  ${name} - Invalid symbolId, skipping`);
        return;
      }

      const response = await this.client.request(
        {
          method: "tools/call",
          params: {
            name: "sdl.code.getSkeleton",
            arguments: {
              repoId,
              symbolId,
            },
          },
        },
        CallToolRequestSchema,
      );

      const duration = Date.now() - start;
      const schemaValid = this.validateSchema(response, {
        symbolId: "string",
        skeletonText: "string",
        skeletonIR: "object",
      });

      this.results.push({
        name,
        tool: "sdl.code.getSkeleton",
        request: { repoId, symbolId },
        response: this.redactSensitiveFields(response),
        duration,
        schemaValid,
      });

      console.log(`   ✅ ${name} (${duration}ms)`);
    } catch (error) {
      const duration = Date.now() - start;
      this.results.push({
        name,
        tool: "sdl.code.getSkeleton",
        request: { repoId, symbolId: "unknown" },
        response: {},
        duration,
        schemaValid: false,
        error: error instanceof Error ? error.message : String(error),
      });
      console.warn(
        `   ⚠️  ${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async step_getHotPath(repoId: string): Promise<void> {
    const name = "Get HotPath (placeholder)";
    console.log(`\n[7/8] ${name}...`);

    const start = Date.now();
    try {
      console.log(`   ⚠️  ${name} - HotPath not yet implemented, skipping`);

      this.results.push({
        name,
        tool: "sdl.code.getHotPath",
        request: { repoId, symbolId: "placeholder" },
        response: { skipped: true, reason: "Not yet implemented" },
        duration: Date.now() - start,
        schemaValid: true,
      });
    } catch (error) {
      const duration = Date.now() - start;
      this.results.push({
        name,
        tool: "sdl.code.getHotPath",
        request: {},
        response: {},
        duration,
        schemaValid: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async step_requestWindowWithPolicy(repoId: string): Promise<void> {
    const name = "Request Window (with Policy Enforcement)";
    console.log(`\n[8/8] ${name}...`);

    const start = Date.now();
    try {
      const searchResponse = await this.client.request(
        {
          method: "tools/call",
          params: {
            name: "sdl.symbol.search",
            arguments: {
              repoId,
              query: "test",
              limit: 1,
            },
          },
        },
        CallToolRequestSchema,
      );

      const searchData = searchResponse as unknown as { results?: unknown[] };
      const results = searchData.results || [];

      if (results.length === 0) {
        console.log(`   ⚠️  ${name} - No symbols found, skipping`);
        return;
      }

      const firstSymbol = results[0] as { symbolId?: string };
      const symbolId = firstSymbol.symbolId;

      if (!symbolId) {
        console.log(`   ⚠️  ${name} - Invalid symbolId, skipping`);
        return;
      }

      const response = await this.client.request(
        {
          method: "tools/call",
          params: {
            name: "sdl.code.needWindow",
            arguments: {
              repoId,
              symbolId,
              reason: "golden e2e test",
              expectedLines: 10,
              identifiersToFind: [],
            },
          },
        },
        CallToolRequestSchema,
      );

      const duration = Date.now() - start;
      const schemaValid = this.validateSchema(response, {
        approved: "boolean",
        auditHash: "string",
      });

      this.results.push({
        name,
        tool: "sdl.code.needWindow",
        request: {
          repoId,
          symbolId,
          reason: "golden e2e test",
          expectedLines: 10,
          identifiersToFind: [],
        },
        response: this.redactSensitiveFields(response),
        duration,
        schemaValid,
      });

      console.log(`   ✅ ${name} (${duration}ms)`);
    } catch (error) {
      const duration = Date.now() - start;
      this.results.push({
        name,
        tool: "sdl.code.needWindow",
        request: {},
        response: {},
        duration,
        schemaValid: false,
        error: error instanceof Error ? error.message : String(error),
      });
      console.warn(
        `   ⚠️  ${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private validateSchema(
    data: unknown,
    schema: Record<string, string>,
  ): boolean {
    if (!data || typeof data !== "object") {
      return false;
    }

    for (const [key, expectedType] of Object.entries(schema)) {
      if (!(key in data)) {
        return false;
      }

      const value = (data as Record<string, unknown>)[key];
      if (expectedType === "string" && typeof value !== "string") {
        return false;
      }
      if (expectedType === "number" && typeof value !== "number") {
        return false;
      }
      if (expectedType === "boolean" && typeof value !== "boolean") {
        return false;
      }
      if (expectedType === "object" && typeof value !== "object") {
        return false;
      }
    }

    return true;
  }

  private redactSensitiveFields(data: unknown): unknown {
    if (typeof data === "string") {
      return data;
    }

    if (Array.isArray(data)) {
      return data.map((item) => this.redactSensitiveFields(item));
    }

    if (data && typeof data === "object") {
      const redacted: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(data)) {
        if (
          key.includes("token") ||
          key.includes("secret") ||
          key.includes("password")
        ) {
          redacted[key] = "[REDACTED]";
        } else if (
          key === "code" &&
          typeof value === "string" &&
          value.length > 100
        ) {
          redacted[key] = value.substring(0, 100) + "... (truncated)";
        } else {
          redacted[key] = this.redactSensitiveFields(value);
        }
      }
      return redacted;
    }

    return data;
  }

  private async saveGoldenFixture(
    fixtureName: string,
    result: E2EResult,
  ): Promise<void> {
    const fixturesDir = join(__dirname, "../tests/golden");
    const fixturePath = join(fixturesDir, `${fixtureName}.json`);

    try {
      mkdirSync(fixturesDir, { recursive: true });

      const fixtureData = {
        name: fixtureName,
        description: `Golden E2E test fixture for ${fixtureName}`,
        timestamp: result.timestamp,
        repoId: result.repoId,
        repoPath: result.repoPath,
        success: result.success,
        steps: result.steps,
        totalDuration: result.totalDuration,
      };

      writeFile(
        fixturePath,
        JSON.stringify(fixtureData, null, 2),
        "utf-8",
        (err) => {
          if (err) {
            console.error(`❌ Failed to save golden fixture: ${err}`);
          } else {
            console.log(`\n✅ Golden fixture saved: ${fixtureName}.json`);
          }
        },
      );
    } catch (error) {
      console.error(
        `❌ Failed to save golden fixture: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async stop(): Promise<void> {
    await this.client.close();
  }

  printSummary(result: E2EResult): void {
    console.log("\n" + "=".repeat(60));
    console.log("E2E TEST SUMMARY");
    console.log("=".repeat(60));
    console.log(`Repo: ${result.repoPath}`);
    console.log(`Repo ID: ${result.repoId}`);
    console.log(`Total Duration: ${result.totalDuration}ms`);
    console.log(`Success: ${result.success ? "✅" : "❌"}`);
    console.log("\nSteps:");
    for (const step of result.steps) {
      const status = step.error ? "❌" : step.schemaValid ? "✅" : "⚠️";
      console.log(
        `  ${status} ${step.name} (${step.duration}ms) - ${step.tool}`,
      );
      if (step.error) {
        console.log(`     Error: ${step.error}`);
      }
    }
    console.log("=".repeat(60));
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const repoPath = args.find((a) => a.startsWith("--repo="))?.split("=")[1];
  const repoIdArg = args.find((a) => a.startsWith("--repo-id="))?.split("=")[1];
  const fixtureName = args
    .find((a) => a.startsWith("--fixture="))
    ?.split("=")[1];
  const configPath = args.find((a) => a.startsWith("--config="))?.split("=")[1];

  if (!repoPath) {
    console.error("❌ --repo=<path> is required");
    process.exit(1);
  }

  const repoId =
    repoIdArg ||
    crypto.createHash("sha256").update(repoPath).digest("hex").substring(0, 16);

  const runner = new GoldenE2ERunner();

  try {
    await runner.startServer(configPath);
    console.log("✅ Server started");

    const result = await runner.runFullE2EFlow(repoPath, repoId, fixtureName);
    runner.printSummary(result);

    await runner.stop();

    process.exit(result.success ? 0 : 1);
  } catch (error) {
    console.error(
      `\n❌ Fatal error: ${error instanceof Error ? error.message : String(error)}`,
    );
    await runner.stop();
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`Uncaught error: ${error}`);
  process.exit(1);
});
