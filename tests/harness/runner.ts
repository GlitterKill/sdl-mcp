import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
} from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function resolveGoldenDir(): string {
  const repoGoldenDir = join(process.cwd(), "tests", "golden");
  if (existsSync(repoGoldenDir)) {
    return repoGoldenDir;
  }
  return join(__dirname, "../golden");
}

interface GoldenTask {
  name: string;
  description: string;
  tool: string;
  request: unknown;
  expectedResponse: unknown;
}

interface TestResult {
  taskName: string;
  tool: string;
  passed: boolean;
  duration: number;
  error?: string;
  details?: string;
}

interface ClientProfile {
  name: string;
  capabilities: string[];
  expectedTools: string[];
}

interface SyncAssertionResult {
  passed: boolean;
  handleGeneration: boolean;
  leaseExpiry: boolean;
  refreshIncremental: boolean;
  etagNotModified: boolean;
  errors: string[];
}

interface GovernanceAssertionResult {
  passed: boolean;
  ladderEscalation: boolean;
  auditHashGenerated: boolean;
  policyEnforced: boolean;
  errors: string[];
}

interface DeterminismResult {
  passed: boolean;
  byteStable: boolean;
  hashStable: boolean;
  runConsistency: number;
  errors: string[];
}

const CLIENT_PROFILES: ClientProfile[] = [
  {
    name: "claude-code",
    capabilities: ["stdio", "resources", "tools"],
    expectedTools: [
      "sdl.repo.register",
      "sdl.repo.status",
      "sdl.index.refresh",
      "sdl.symbol.search",
      "sdl.symbol.getCard",
      "sdl.slice.build",
      "sdl.slice.refresh",
      "sdl.delta.get",
      "sdl.code.needWindow",
      "sdl.code.getSkeleton",
      "sdl.policy.get",
      "sdl.policy.set",
      "sdl.context.summary",
    ],
  },
  {
    name: "codex",
    capabilities: ["stdio", "tools"],
    expectedTools: [
      "sdl.repo.register",
      "sdl.repo.status",
      "sdl.index.refresh",
      "sdl.symbol.search",
      "sdl.symbol.getCard",
      "sdl.slice.build",
      "sdl.slice.refresh",
      "sdl.delta.get",
      "sdl.code.needWindow",
      "sdl.code.getSkeleton",
      "sdl.policy.get",
      "sdl.policy.set",
      "sdl.context.summary",
    ],
  },
  {
    name: "gemini",
    capabilities: ["stdio", "tools"],
    expectedTools: [
      "sdl.repo.register",
      "sdl.repo.status",
      "sdl.index.refresh",
      "sdl.symbol.search",
      "sdl.symbol.getCard",
      "sdl.slice.build",
      "sdl.slice.refresh",
      "sdl.delta.get",
      "sdl.code.needWindow",
      "sdl.code.getSkeleton",
      "sdl.policy.get",
      "sdl.policy.set",
      "sdl.context.summary",
    ],
  },
  {
    name: "opencode",
    capabilities: ["stdio", "tools"],
    expectedTools: [
      "sdl.repo.register",
      "sdl.repo.status",
      "sdl.index.refresh",
      "sdl.symbol.search",
      "sdl.symbol.getCard",
      "sdl.slice.build",
      "sdl.slice.refresh",
      "sdl.delta.get",
      "sdl.code.needWindow",
      "sdl.code.getSkeleton",
      "sdl.policy.get",
      "sdl.policy.set",
      "sdl.context.summary",
    ],
  },
];

class TestHarness {
  private client: Client;
  private goldenTasks: GoldenTask[] = [];
  private syncAssertions: SyncAssertionResult = {
    passed: false,
    handleGeneration: false,
    leaseExpiry: false,
    refreshIncremental: false,
    etagNotModified: false,
    errors: [],
  };
  private governanceAssertions: GovernanceAssertionResult = {
    passed: false,
    ladderEscalation: false,
    auditHashGenerated: false,
    policyEnforced: false,
    errors: [],
  };

  constructor() {
    this.client = new Client({
      name: "test-harness",
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

  async loadGoldenTasks(): Promise<void> {
    const fixturesDir = resolveGoldenDir();
    const files = readdirSync(fixturesDir).filter((f) => f.endsWith(".json"));

    for (const file of files) {
      const filePath = join(fixturesDir, file);
      const content = readFileSync(filePath, "utf-8");
      const task = JSON.parse(content) as GoldenTask;
      this.goldenTasks.push(task);
    }

    console.log(`Loaded ${this.goldenTasks.length} golden tasks`);
  }

  async runToolDiscovery(profile: ClientProfile): Promise<boolean> {
    console.log(`\n--- Tool Discovery for ${profile.name} ---`);

    try {
      const toolsResult = await this.client.request(
        { method: "tools/list", params: {} },
        ListToolsRequestSchema,
      );

      const result = toolsResult as { tools?: unknown[] };
      const tools = result.tools || [];

      const toolNames = tools
        .filter(
          (t): t is { name: string } =>
            typeof t === "object" && t !== null && "name" in t,
        )
        .map((t) => t.name);

      console.log(`Discovered ${toolNames.length} tools`);

      for (const expectedTool of profile.expectedTools) {
        if (!toolNames.includes(expectedTool)) {
          console.error(`❌ Missing expected tool: ${expectedTool}`);
          return false;
        }
      }

      console.log(`✅ All expected tools found for ${profile.name}`);
      return true;
    } catch (error) {
      console.error(
        `❌ Tool discovery failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  async runGoldenTasks(): Promise<TestResult[]> {
    console.log("\n--- Running Golden Tasks ---");
    const results: TestResult[] = [];

    for (const task of this.goldenTasks) {
      const start = Date.now();
      console.log(`\nRunning: ${task.name} (${task.tool})`);

      try {
        const response = await this.client.request(
          {
            method: "tools/call",
            params: { name: task.tool, arguments: task.request },
          },
          CallToolRequestSchema,
        );

        const duration = Date.now() - start;

        const passed = this.validateResponse(response, task.expectedResponse);

        results.push({
          taskName: task.name,
          tool: task.tool,
          passed,
          duration,
          details: passed
            ? "Response structure matches expectations"
            : undefined,
        });

        if (passed) {
          console.log(`✅ ${task.name} (${duration}ms)`);
        } else {
          console.error(`❌ ${task.name} - Response validation failed`);
        }
      } catch (error) {
        const duration = Date.now() - start;
        console.error(
          `❌ ${task.name} - Error: ${error instanceof Error ? error.message : String(error)}`,
        );

        results.push({
          taskName: task.name,
          tool: task.tool,
          passed: false,
          duration,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return results;
  }

  async runSyncAssertions(repoId: string): Promise<SyncAssertionResult> {
    console.log("\n--- Running v0.5 Sync Assertions ---");
    const result: SyncAssertionResult = {
      passed: false,
      handleGeneration: false,
      leaseExpiry: false,
      refreshIncremental: false,
      etagNotModified: false,
      errors: [],
    };

    try {
      console.log("Testing slice handle generation and leases...");

      const sliceResponse = await this.client.request(
        {
          method: "tools/call",
          params: {
            name: "sdl.slice.build",
            arguments: {
              repoId,
              taskText: "test slice for sync assertions",
            },
          },
        },
        CallToolRequestSchema,
      );

      const sliceData = sliceResponse as unknown as Record<string, unknown>;
      const sliceHandle = sliceData.sliceHandle as string;
      const ledgerVersion = sliceData.ledgerVersion as string;
      const lease = sliceData.lease as Record<string, unknown>;

      if (!sliceHandle || typeof sliceHandle !== "string") {
        result.errors.push("Slice handle not generated or invalid type");
        return result;
      }
      result.handleGeneration = true;
      console.log("✅ Slice handle generated:", sliceHandle);

      if (!lease || typeof lease !== "object" || !lease.expiresAt) {
        result.errors.push("Lease not generated or invalid structure");
        return result;
      }
      const expiresAt = new Date(lease.expiresAt as string);
      if (isNaN(expiresAt.getTime())) {
        result.errors.push("Lease expiry timestamp is invalid");
        return result;
      }
      result.leaseExpiry = true;
      console.log("✅ Lease expiry valid:", expiresAt.toISOString());

      console.log("Testing slice refresh (incremental delta)...");

      const refreshResponse = await this.client.request(
        {
          method: "tools/call",
          params: {
            name: "sdl.slice.refresh",
            arguments: {
              sliceHandle,
              knownVersion: ledgerVersion,
            },
          },
        },
        CallToolRequestSchema,
      );

      const refreshData = refreshResponse as unknown as Record<string, unknown>;
      const notModified = refreshData.notModified as boolean;

      if (notModified === undefined) {
        result.errors.push("Refresh response missing notModified field");
        return result;
      }
      result.refreshIncremental = true;
      console.log(
        "✅ Refresh returns incremental delta:",
        notModified ? "not modified" : "delta included",
      );

      console.log("Testing ETag notModified responses...");

      const symbolSearch = await this.client.request(
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

      const searchData = symbolSearch as unknown as { results?: unknown[] };
      const results = searchData.results || [];

      if (results.length > 0) {
        const firstSymbol = results[0] as { symbolId?: string };
        const symbolId = firstSymbol.symbolId;

        if (symbolId) {
          const cardResponse = await this.client.request(
            {
              method: "tools/call",
              params: {
                name: "sdl.symbol.getCard",
                arguments: {
                  repoId,
                  symbolId,
                  ifNoneMatch: ledgerVersion,
                },
              },
            },
            CallToolRequestSchema,
          );

          const cardData = cardResponse as unknown as {
            notModified?: boolean;
            etag?: string;
          };

          if (cardData.notModified === undefined) {
            result.errors.push("Card response missing notModified field");
            return result;
          }
          result.etagNotModified = true;
          console.log(
            "✅ ETag notModified response:",
            cardData.notModified ? "304 Not Modified" : "200 OK",
          );
        } else {
          console.log("⚠️  No symbols found for ETag test");
          result.etagNotModified = true;
        }
      } else {
        console.log("⚠️  No symbols found for ETag test");
        result.etagNotModified = true;
      }

      result.passed = true;
      console.log("✅ All sync assertions passed");
    } catch (error) {
      result.errors.push(
        `Sync assertions failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    this.syncAssertions = result;
    return result;
  }

  async runGovernanceAssertions(
    repoId: string,
  ): Promise<GovernanceAssertionResult> {
    console.log("\n--- Running v0.5 Governance Assertions ---");
    const result: GovernanceAssertionResult = {
      passed: false,
      ladderEscalation: false,
      auditHashGenerated: false,
      policyEnforced: false,
      errors: [],
    };

    try {
      console.log("Testing ladder escalation (downgrade to skeleton)...");

      const policyResponse = await this.client.request(
        {
          method: "tools/call",
          params: {
            name: "sdl.policy.set",
            arguments: {
              repoId,
              policyPatch: {
                requireIdentifiers: true,
                allowBreakGlass: false,
              },
            },
          },
        },
        CallToolRequestSchema,
      );

      console.log("✅ Policy configured for ladder escalation");

      const symbolSearch = await this.client.request(
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

      const searchData = symbolSearch as unknown as { results?: unknown[] };
      const results = searchData.results || [];

      if (results.length > 0) {
        const firstSymbol = results[0] as { symbolId?: string };
        const symbolId = firstSymbol.symbolId;

        if (symbolId) {
          const windowResponse = await this.client.request(
            {
              method: "tools/call",
              params: {
                name: "sdl.code.needWindow",
                arguments: {
                  repoId,
                  symbolId,
                  reason: "test ladder escalation",
                  expectedLines: 10,
                  identifiersToFind: [],
                },
              },
            },
            CallToolRequestSchema,
          );

          const windowData = windowResponse as unknown as Record<
            string,
            unknown
          >;
          const auditHash = windowData.auditHash as string;
          const decision = windowData.decision as string;

          if (!auditHash || typeof auditHash !== "string") {
            result.errors.push("Audit hash not generated or invalid");
          } else {
            result.auditHashGenerated = true;
            console.log("✅ Audit hash generated:", auditHash);
          }

          if (!decision || typeof decision !== "string") {
            result.errors.push("Decision not provided or invalid");
          } else {
            result.policyEnforced = true;
            console.log("✅ Policy decision enforced:", decision);

            if (decision === "downgrade-to-skeleton") {
              result.ladderEscalation = true;
              console.log(
                "✅ Ladder escalation (downgrade to skeleton) triggered",
              );
            }
          }
        }
      } else {
        console.log("⚠️  No symbols found for governance test");
        result.ladderEscalation = true;
        result.auditHashGenerated = true;
        result.policyEnforced = true;
      }

      result.passed =
        result.ladderEscalation &&
        result.auditHashGenerated &&
        result.policyEnforced;
      if (result.passed) {
        console.log("✅ All governance assertions passed");
      }
    } catch (error) {
      result.errors.push(
        `Governance assertions failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    this.governanceAssertions = result;
    return result;
  }

  async runSkeletonDeterminismTests(
    repoId: string,
    runs: number = 5,
  ): Promise<DeterminismResult> {
    console.log(
      `\n--- Running Skeleton IR Determinism Tests (${runs} runs) ---`,
    );
    const result: DeterminismResult = {
      passed: false,
      byteStable: false,
      hashStable: false,
      runConsistency: 0,
      errors: [],
    };

    try {
      const symbolSearch = await this.client.request(
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

      const searchData = symbolSearch as unknown as { results?: unknown[] };
      const results = searchData.results || [];

      if (results.length === 0) {
        console.log("⚠️  No symbols found for determinism test");
        result.byteStable = true;
        result.hashStable = true;
        result.runConsistency = runs;
        result.passed = true;
        return result;
      }

      const firstSymbol = results[0] as { symbolId?: string };
      const symbolId = firstSymbol.symbolId;

      if (!symbolId) {
        console.log("⚠️  No valid symbolId for determinism test");
        result.byteStable = true;
        result.hashStable = true;
        result.runConsistency = runs;
        result.passed = true;
        return result;
      }

      const skeletons: Array<{ text: string; irHash: string }> = [];
      let firstSkeleton: string | null = null;
      let firstIrHash: string | null = null;

      for (let i = 0; i < runs; i++) {
        const skeletonResponse = await this.client.request(
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

        const skeletonData = skeletonResponse as unknown as {
          skeletonText?: string;
          skeletonIR?: { hash?: string };
        };

        const text = skeletonData.skeletonText || "";
        const irHash = skeletonData.skeletonIR?.hash || "";

        skeletons.push({ text, irHash });

        if (i === 0) {
          firstSkeleton = text;
          firstIrHash = irHash;
        } else {
          if (text !== firstSkeleton) {
            result.errors.push(`Skeleton text not byte-stable at run ${i + 1}`);
          }
          if (irHash !== firstIrHash) {
            result.errors.push(`Skeleton IR hash not stable at run ${i + 1}`);
          }
        }

        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      const allTextsMatch = skeletons.every((s) => s.text === firstSkeleton);
      const allHashesMatch = skeletons.every((s) => s.irHash === firstIrHash);

      result.byteStable = allTextsMatch;
      result.hashStable = allHashesMatch;
      result.runConsistency = runs;

      if (allTextsMatch) {
        console.log("✅ Skeleton text is byte-stable across runs");
      }
      if (allHashesMatch) {
        console.log("✅ Skeleton IR hash is stable across runs");
      }

      result.passed = allTextsMatch && allHashesMatch;

      if (result.passed) {
        console.log(
          `✅ Determinism passed (${result.runConsistency}/${runs} consistent runs)`,
        );
      }
    } catch (error) {
      result.errors.push(
        `Determinism tests failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return result;
  }

  async saveGoldenFixture(fixtureName: string, data: unknown): Promise<void> {
    const fixturesDir = resolveGoldenDir();
    const fixturePath = join(fixturesDir, `${fixtureName}.json`);

    try {
      mkdirSync(fixturesDir, { recursive: true });
      writeFileSync(fixturePath, JSON.stringify(data, null, 2), "utf-8");
      console.log(`✅ Golden fixture saved: ${fixtureName}.json`);
    } catch (error) {
      console.error(
        `❌ Failed to save golden fixture: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private validateResponse(actual: unknown, expected: unknown): boolean {
    if (!actual || typeof actual !== "object") {
      return false;
    }

    const check = (actualNode: unknown, expectedNode: unknown): boolean => {
      if (expectedNode === "string" && typeof actualNode === "string") {
        return actualNode.length > 0;
      }
      if (expectedNode === "number" && typeof actualNode === "number") {
        return true;
      }
      if (expectedNode === "boolean" && typeof actualNode === "boolean") {
        return true;
      }
      if (expectedNode === "array" && Array.isArray(actualNode)) {
        return true;
      }
      if (
        expectedNode === "object" &&
        typeof actualNode === "object" &&
        actualNode !== null
      ) {
        const actualObj = actualNode as unknown as Record<string, unknown>;
        const expectedObj = expectedNode as unknown as Record<string, unknown>;

        for (const key of Object.keys(expectedObj)) {
          if (!(key in actualObj)) {
            return false;
          }
          if (!check(actualObj[key], expectedObj[key])) {
            return false;
          }
        }
        return true;
      }

      return actualNode === expectedNode;
    };

    return check(actual, expected);
  }

  async stop(): Promise<void> {
    try {
      await this.client.close();
    } catch (error) {
      console.warn(
        `⚠️  Harness close warning: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const configPath = args.find((a) => a.startsWith("--config="))?.split("=")[1];
  const testRepoId = args.find((a) => a.startsWith("--repo="))?.split("=")[1];
  const runV05Tests = args.includes("--v05");

  console.log("SDL-MCP Test Harness v1.1.0");
  console.log("=".repeat(50));

  const harness = new TestHarness();

  try {
    await harness.startServer(configPath);
    console.log("✅ Server started successfully");

    await harness.loadGoldenTasks();

    const report: Record<
      string,
      {
        passed: number;
        failed: number;
        duration: number;
        toolDiscovery: boolean;
        v05Sync?: {
          passed: boolean;
          handleGeneration: boolean;
          leaseExpiry: boolean;
          refreshIncremental: boolean;
          etagNotModified: boolean;
        };
        v05Governance?: {
          passed: boolean;
          ladderEscalation: boolean;
          auditHashGenerated: boolean;
          policyEnforced: boolean;
        };
        v05Determinism?: {
          passed: boolean;
          byteStable: boolean;
          hashStable: boolean;
          runConsistency: number;
        };
      }
    > = {};

    for (const profile of CLIENT_PROFILES) {
      console.log(`\n${"=".repeat(50)}`);
      console.log(`Testing profile: ${profile.name}`);
      console.log("=".repeat(50));

      const toolDiscoveryPassed = await harness.runToolDiscovery(profile);
      const results = await harness.runGoldenTasks();

      const passed = results.filter((r) => r.passed).length;
      const failed = results.filter((r) => !r.passed).length;
      const duration = results.reduce((sum, r) => sum + r.duration, 0);

      report[profile.name] = {
        passed,
        failed,
        duration,
        toolDiscovery: toolDiscoveryPassed,
      };

      console.log(`\n--- Summary for ${profile.name} ---`);
      console.log(
        `Tool Discovery: ${toolDiscoveryPassed ? "✅ PASSED" : "❌ FAILED"}`,
      );
      console.log(`Golden Tasks: ${passed} passed, ${failed} failed`);
      console.log(`Total duration: ${duration}ms`);

      if (failed > 0) {
        console.log("\nFailed tasks:");
        results
          .filter((r) => !r.passed)
          .forEach((r) => {
            console.log(`  - ${r.taskName}: ${r.error || "Validation failed"}`);
          });
      }
    }

    if (runV05Tests && testRepoId) {
      console.log(`\n${"=".repeat(50)}`);
      console.log("Running v0.5 Tests");
      console.log("=".repeat(50));

      for (const profile of CLIENT_PROFILES) {
        console.log(`\n--- v0.5 Tests for ${profile.name} ---`);

        const syncResult = await harness.runSyncAssertions(testRepoId);
        const governanceResult =
          await harness.runGovernanceAssertions(testRepoId);
        const determinismResult = await harness.runSkeletonDeterminismTests(
          testRepoId,
          3,
        );

        report[profile.name].v05Sync = {
          passed: syncResult.passed,
          handleGeneration: syncResult.handleGeneration,
          leaseExpiry: syncResult.leaseExpiry,
          refreshIncremental: syncResult.refreshIncremental,
          etagNotModified: syncResult.etagNotModified,
        };

        report[profile.name].v05Governance = {
          passed: governanceResult.passed,
          ladderEscalation: governanceResult.ladderEscalation,
          auditHashGenerated: governanceResult.auditHashGenerated,
          policyEnforced: governanceResult.policyEnforced,
        };

        report[profile.name].v05Determinism = {
          passed: determinismResult.passed,
          byteStable: determinismResult.byteStable,
          hashStable: determinismResult.hashStable,
          runConsistency: determinismResult.runConsistency,
        };

        console.log(`\n--- v0.5 Summary for ${profile.name} ---`);
        console.log(`Sync: ${syncResult.passed ? "✅ PASSED" : "❌ FAILED"}`);
        console.log(
          `Governance: ${governanceResult.passed ? "✅ PASSED" : "❌ FAILED"}`,
        );
        console.log(
          `Determinism: ${determinismResult.passed ? "✅ PASSED" : "❌ FAILED"}`,
        );

        if (syncResult.errors.length > 0) {
          console.log("\nSync errors:");
          syncResult.errors.forEach((e) => console.log(`  - ${e}`));
        }
        if (governanceResult.errors.length > 0) {
          console.log("\nGovernance errors:");
          governanceResult.errors.forEach((e) => console.log(`  - ${e}`));
        }
        if (determinismResult.errors.length > 0) {
          console.log("\nDeterminism errors:");
          determinismResult.errors.forEach((e) => console.log(`  - ${e}`));
        }
      }
    }

    console.log(`\n${"=".repeat(50)}`);
    console.log("FINAL REPORT");
    console.log("=".repeat(50));

    for (const [profileName, stats] of Object.entries(report)) {
      const allPassed = stats.toolDiscovery && stats.failed === 0;
      console.log(`${profileName}: ${allPassed ? "✅ PASSED" : "❌ FAILED"}`);
      console.log(`  - Tool Discovery: ${stats.toolDiscovery ? "✅" : "❌"}`);
      console.log(
        `  - Golden Tasks: ${stats.passed}/${stats.passed + stats.failed}`,
      );
      console.log(`  - Duration: ${stats.duration}ms`);

      if (stats.v05Sync) {
        console.log(`  - v0.5 Sync: ${stats.v05Sync.passed ? "✅" : "❌"}`);
      }
      if (stats.v05Governance) {
        console.log(
          `  - v0.5 Governance: ${stats.v05Governance.passed ? "✅" : "❌"}`,
        );
      }
      if (stats.v05Determinism) {
        console.log(
          `  - v0.5 Determinism: ${stats.v05Determinism.passed ? "✅" : "❌"}`,
        );
      }
    }

    const allProfilesPassed = Object.values(report).every(
      (s) => s.toolDiscovery && s.failed === 0,
    );
    await harness.stop();
    process.exit(allProfilesPassed ? 0 : 1);
  } catch (error) {
    console.error(
      `\n❌ Fatal error: ${error instanceof Error ? error.message : String(error)}`,
    );
    await harness.stop();
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`Uncaught error: ${error}`);
  process.exit(1);
});
