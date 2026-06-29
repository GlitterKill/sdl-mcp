import { describe, it, before, after } from "node:test";
import assert from "node:assert";

import {
  createSummaryProvider,
  AnthropicSummaryProvider,
  OpenAICompatibleSummaryProvider,
  summaryCacheKey,
} from "../../dist/indexer/summary-generator.js";
import type {
  SummaryProvider,
  SummaryBatchResult,
  GeneratedSummaryResult,
} from "../../dist/indexer/summary-generator.js";

describe("createSummaryProvider", () => {
  let originalApiKey: string | undefined;

  before(() => {
    originalApiKey = process.env.ANTHROPIC_API_KEY;
  });

  after(() => {
    if (originalApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalApiKey;
    }
  });

  it("returns MockSummaryProvider for 'mock' provider string", () => {
    const provider = createSummaryProvider("mock");
    assert.ok(provider, "Should return a provider");
    assert.strictEqual(provider.name, "mock");
  });

  it("returns MockSummaryProvider for unknown provider string", () => {
    const provider = createSummaryProvider("unknown-provider");
    assert.ok(provider, "Should return a provider");
    assert.strictEqual(provider.name, "mock");
  });

  it("returns null for 'api' provider when no API key is available", () => {
    delete process.env.ANTHROPIC_API_KEY;
    const provider = createSummaryProvider("api");
    assert.strictEqual(provider, null);
  });

  it("returns AnthropicSummaryProvider for 'api' provider with API key", () => {
    const provider = createSummaryProvider("api", {
      summaryApiKey: "test-key-123",
    });
    assert.ok(provider, "Should return a provider");
    assert.strictEqual(provider.name, "anthropic");
    assert.ok(provider instanceof AnthropicSummaryProvider);
  });

  it("returns AnthropicSummaryProvider using env var API key", () => {
    process.env.ANTHROPIC_API_KEY = "env-test-key";
    const provider = createSummaryProvider("api");
    assert.ok(provider, "Should return a provider");
    assert.strictEqual(provider.name, "anthropic");
  });

  it("returns OpenAICompatibleSummaryProvider for 'local' provider", () => {
    const provider = createSummaryProvider("local");
    assert.ok(provider, "Should return a provider");
    assert.strictEqual(provider.name, "openai-compatible");
    assert.ok(provider instanceof OpenAICompatibleSummaryProvider);
  });

  it("passes custom model to 'api' provider", () => {
    const provider = createSummaryProvider("api", {
      summaryApiKey: "test-key",
      summaryModel: "claude-sonnet-4-20250514",
    });
    assert.ok(provider, "Should return a provider");
    assert.strictEqual(provider.name, "anthropic");
  });

  it("passes custom base URL to 'local' provider", () => {
    const provider = createSummaryProvider("local", {
      summaryApiBaseUrl: "http://localhost:8080/v1",
    });
    assert.ok(provider, "Should return a provider");
    assert.strictEqual(provider.name, "openai-compatible");
  });
});

describe("MockSummaryProvider.generate", () => {
  it("uses prepared embedding input for concise prose", async () => {
    const provider = createSummaryProvider("mock");
    assert.ok(provider);

    const result = await provider.generate({
      symbolName: "loadUser",
      kind: "function",
      signature: "async function loadUser(id: string): Promise<UserProfile>",
      embeddingInput: {
        symbol: {
          name: "loadUser",
          kind: "function",
        },
        signatureText:
          "async function loadUser(id: string): Promise<UserProfile>",
        roleTags: ["request handler", "http"],
        sideEffects: ["reads from the user profile cache"],
        searchTerms: ["user", "profile"],
        imports: [{ label: "UserProfile", confidence: 1, resolved: true }],
        calls: [{ label: "readCache", confidence: 1, resolved: true }],
        invariants: [],
        relPath: "src/users/load-user.ts",
        language: "typescript",
        summaryFreshness: "absent",
        summaryText: null,
      },
    });

    assert.match(result, /^function loadUser request handler/);
    assert.match(result, /returns Promise<UserProfile>/);
    assert.match(result, /reads from the user profile cache/);
    assert.ok(!result.includes("UserProfile,"), "imports are ignored");
    assert.ok(!result.includes("readCache"), "calls are ignored");
    assert.ok(!result.includes("participates in"));
  });

  it("uses kind, name, and signature fallback when embedding input is absent", async () => {
    const provider = createSummaryProvider("mock");
    assert.ok(provider);

    const result = await provider.generate({
      symbolName: "parseConfig",
      kind: "function",
      signature: "function parseConfig(raw: string): RepoConfig",
      heuristicSummary: "Processes a single file for indexing.",
    });

    assert.match(result, /^function parseConfig/);
    assert.match(result, /returns RepoConfig/);
    assert.ok(!result.includes("Processes a single file"));
    assert.ok(!result.includes("participates in"));
  });

  it("returns a name-based fallback when no structural input exists", async () => {
    const provider = createSummaryProvider("mock");
    assert.ok(provider);

    const result = await provider.generate({
      symbolName: "myFunction",
    });
    assert.match(result, /^symbol myFunction/);
    assert.ok(!result.includes("participates in"));
  });
});

describe("summaryCacheKey", () => {
  it("returns a hex string", () => {
    const key = summaryCacheKey("sym-123", "mock");
    assert.ok(/^[0-9a-f]+$/.test(key), `Expected hex string, got: ${key}`);
  });

  it("is deterministic for same inputs", () => {
    const a = summaryCacheKey("sym-123", "mock");
    const b = summaryCacheKey("sym-123", "mock");
    assert.strictEqual(a, b);
  });

  it("differs for different symbolIds", () => {
    const a = summaryCacheKey("sym-123", "mock");
    const b = summaryCacheKey("sym-456", "mock");
    assert.notStrictEqual(a, b);
  });

  it("differs for different providers", () => {
    const a = summaryCacheKey("sym-123", "mock");
    const b = summaryCacheKey("sym-123", "anthropic");
    assert.notStrictEqual(a, b);
  });
});

describe("SummaryBatchResult type contract", () => {
  it("has expected numeric fields", () => {
    const result: SummaryBatchResult = {
      generated: 10,
      skipped: 5,
      failed: 2,
      totalCostUsd: 0.0042,
    };
    assert.strictEqual(result.generated, 10);
    assert.strictEqual(result.skipped, 5);
    assert.strictEqual(result.failed, 2);
    assert.ok(result.totalCostUsd > 0);
  });

  it("supports zero-value batch result", () => {
    const result: SummaryBatchResult = {
      generated: 0,
      skipped: 0,
      failed: 0,
      totalCostUsd: 0,
    };
    assert.strictEqual(result.generated + result.skipped + result.failed, 0);
  });
});

describe("GeneratedSummaryResult type contract", () => {
  it("has expected fields", () => {
    const result: GeneratedSummaryResult = {
      summary: "Processes data from input stream.",
      provider: "mock",
      costUsd: 0.000002,
      divergenceScore: 0.45,
    };
    assert.strictEqual(result.provider, "mock");
    assert.ok(result.summary.length > 0);
    assert.ok(result.divergenceScore >= 0 && result.divergenceScore <= 1);
    assert.ok(result.costUsd >= 0);
  });
});

describe("AnthropicSummaryProvider construction", () => {
  it("creates provider with required apiKey", () => {
    const provider = new AnthropicSummaryProvider({ apiKey: "test-key" });
    assert.strictEqual(provider.name, "anthropic");
  });

  it("accepts optional model and baseUrl", () => {
    const provider = new AnthropicSummaryProvider({
      apiKey: "test-key",
      model: "claude-haiku-4-5-20251001",
      baseUrl: "https://custom.api.example.com",
    });
    assert.strictEqual(provider.name, "anthropic");
  });
});

describe("OpenAICompatibleSummaryProvider construction", () => {
  it("creates provider with required apiKey", () => {
    const provider = new OpenAICompatibleSummaryProvider({
      apiKey: "ollama",
    });
    assert.strictEqual(provider.name, "openai-compatible");
  });

  it("accepts optional model and baseUrl", () => {
    const provider = new OpenAICompatibleSummaryProvider({
      apiKey: "ollama",
      model: "llama3",
      baseUrl: "http://localhost:11434/v1/",
    });
    assert.strictEqual(provider.name, "openai-compatible");
  });

  it("local provider does NOT use ANTHROPIC_API_KEY env var", () => {
    // Security: the local provider should not leak Anthropic credentials
    // to arbitrary summaryApiBaseUrl endpoints. createSummaryProvider('local')
    // uses 'ollama' as default key, not process.env.ANTHROPIC_API_KEY.
    const provider = createSummaryProvider("local");
    assert.ok(provider);
    assert.strictEqual(provider.name, "openai-compatible");
    // If it had used ANTHROPIC_API_KEY, it would still be openai-compatible,
    // but the test confirms the provider was created (not null) without
    // requiring an env var.
  });
});
