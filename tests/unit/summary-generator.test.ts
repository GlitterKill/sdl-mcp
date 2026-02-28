import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, unlinkSync } from "node:fs";
import {
  generateSummaryWithGuardrails,
  AnthropicSummaryProvider,
  OpenAICompatibleSummaryProvider,
  createSummaryProvider,
} from "../../src/indexer/summary-generator.js";
import { getDb, closeDb } from "../../src/db/db.js";
import { runMigrations } from "../../src/db/migrations.js";
import { getSummaryCache, resetQueryCache } from "../../src/db/queries.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FetchCall = {
  url: string;
  options: RequestInit;
};

interface MockFetchOptions {
  status: number;
  body: unknown;
}

function makeFetch(opts: MockFetchOptions): typeof fetch {
  return async (_url: string | URL | Request, _init?: RequestInit) => {
    const bodyText = JSON.stringify(opts.body);
    return {
      ok: opts.status >= 200 && opts.status < 300,
      status: opts.status,
      statusText: String(opts.status),
      text: async () => bodyText,
      json: async () => opts.body,
    } as unknown as Response;
  };
}

// ---------------------------------------------------------------------------
// Mock provider tests (no DB required)
// ---------------------------------------------------------------------------

describe("summary generator — mock provider", () => {
  it("returns deterministic summary metadata with heuristic text", async () => {
    const result = await generateSummaryWithGuardrails({
      symbolName: "buildSlice",
      heuristicSummary: "Builds a graph slice from entry symbols.",
      provider: "mock",
    });

    assert.ok(result.summary.length > 0);
    assert.strictEqual(result.summary, "Builds a graph slice from entry symbols.");
    assert.ok(result.costUsd >= 0);
    assert.ok(result.divergenceScore >= 0 && result.divergenceScore <= 1);
    assert.strictEqual(result.provider, "mock");
  });

  it("returns fallback summary when no heuristic is provided", async () => {
    const result = await generateSummaryWithGuardrails({
      symbolName: "frobnicate",
      provider: "mock",
    });

    assert.ok(result.summary.includes("frobnicate"));
  });

  it("divergenceScore is 0 when summary equals heuristic", async () => {
    const heuristic = "Computes a hash for the given content.";
    const result = await generateSummaryWithGuardrails({
      symbolName: "hashContent",
      heuristicSummary: heuristic,
      provider: "mock",
    });

    assert.strictEqual(result.divergenceScore, 0);
  });
});

// ---------------------------------------------------------------------------
// createSummaryProvider — no-API-key fallback
// ---------------------------------------------------------------------------

describe("createSummaryProvider — no API key", () => {
  it("falls back to mock provider when 'api' requested without an API key", () => {
    const savedKey = process.env["ANTHROPIC_API_KEY"];
    delete process.env["ANTHROPIC_API_KEY"];

    const provider = createSummaryProvider("api", {});
    assert.strictEqual(provider.name, "mock");

    if (savedKey !== undefined) {
      process.env["ANTHROPIC_API_KEY"] = savedKey;
    }
  });

  it("returns mock when provider is 'mock'", () => {
    const provider = createSummaryProvider("mock", {});
    assert.strictEqual(provider.name, "mock");
  });

  it("returns openai-compatible for 'local' provider", () => {
    const provider = createSummaryProvider("local", {
      summaryApiBaseUrl: "http://localhost:11434",
    });
    assert.strictEqual(provider.name, "openai-compatible");
  });
});

// ---------------------------------------------------------------------------
// AnthropicSummaryProvider — fetch structure
// ---------------------------------------------------------------------------

describe("AnthropicSummaryProvider — HTTP structure", () => {
  it("sends correct endpoint, headers, and prompt to Anthropic API", async () => {
    const calls: FetchCall[] = [];

    globalThis.fetch = async (
      url: string | URL | Request,
      options?: RequestInit,
    ) => {
      calls.push({ url: String(url), options: options ?? {} });
      return {
        ok: true,
        status: 200,
        text: async () => "{}",
        json: async () => ({
          content: [{ type: "text", text: "Hashes a string using SHA-256." }],
        }),
      } as unknown as Response;
    };

    const provider = new AnthropicSummaryProvider({
      apiKey: "test-key-abc",
      model: "claude-haiku-4-5-20251001",
    });

    const result = await provider.generate({
      symbolName: "hashContent",
      kind: "function",
      signature: "hashContent(content: string): string",
      heuristicSummary: "Hashes content.",
    });

    assert.strictEqual(calls.length, 1);
    const call = calls[0];

    // Correct endpoint
    assert.ok(
      call.url.includes("api.anthropic.com/v1/messages"),
      `Expected Anthropic endpoint, got: ${call.url}`,
    );

    // Correct headers
    const headers = call.options.headers as Record<string, string>;
    assert.strictEqual(headers["x-api-key"], "test-key-abc");
    assert.strictEqual(headers["anthropic-version"], "2023-06-01");
    assert.strictEqual(headers["content-type"], "application/json");

    // Body structure
    const body = JSON.parse(call.options.body as string) as {
      model: string;
      max_tokens: number;
      system: string;
      messages: Array<{ role: string; content: string }>;
    };
    assert.strictEqual(body.model, "claude-haiku-4-5-20251001");
    assert.strictEqual(body.max_tokens, 256);
    assert.ok(typeof body.system === "string" && body.system.length > 0);
    assert.strictEqual(body.messages[0].role, "user");
    assert.ok(body.messages[0].content.includes("hashContent"));

    // Parsed response
    assert.strictEqual(result, "Hashes a string using SHA-256.");
  });

  it("throws a descriptive error containing status code on HTTP 429", async () => {
    globalThis.fetch = makeFetch({
      status: 429,
      body: { error: { message: "Rate limit exceeded" } },
    });

    const provider = new AnthropicSummaryProvider({ apiKey: "test-key" });

    await assert.rejects(
      async () => provider.generate({ symbolName: "foo" }),
      (err: Error) => {
        assert.ok(
          err.message.includes("429"),
          `Expected 429 in error, got: ${err.message}`,
        );
        return true;
      },
    );
  });

  it("throws on HTTP 500 with truncated body in message", async () => {
    globalThis.fetch = makeFetch({
      status: 500,
      body: { error: "Internal server error" },
    });

    const provider = new AnthropicSummaryProvider({ apiKey: "test-key" });

    await assert.rejects(
      async () => provider.generate({ symbolName: "bar" }),
      (err: Error) => {
        assert.ok(err.message.includes("500"));
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// OpenAICompatibleSummaryProvider — Authorization header
// ---------------------------------------------------------------------------

describe("OpenAICompatibleSummaryProvider — Authorization header", () => {
  it("sends Authorization: Bearer header and correct endpoint", async () => {
    const calls: FetchCall[] = [];

    globalThis.fetch = async (
      url: string | URL | Request,
      options?: RequestInit,
    ) => {
      calls.push({ url: String(url), options: options ?? {} });
      return {
        ok: true,
        status: 200,
        text: async () => "{}",
        json: async () => ({
          choices: [{ message: { content: "Ollama generated summary." } }],
        }),
      } as unknown as Response;
    };

    const provider = new OpenAICompatibleSummaryProvider({
      apiKey: "my-local-key",
      model: "llama3",
      baseUrl: "http://localhost:11434",
    });

    const result = await provider.generate({
      symbolName: "doThing",
      kind: "function",
    });

    assert.strictEqual(calls.length, 1);
    const headers = calls[0].options.headers as Record<string, string>;
    assert.strictEqual(headers["Authorization"], "Bearer my-local-key");

    assert.ok(
      calls[0].url.includes("localhost:11434"),
      `Expected local endpoint, got: ${calls[0].url}`,
    );
    assert.ok(calls[0].url.endsWith("/chat/completions"));

    assert.strictEqual(result, "Ollama generated summary.");
  });

  it("throws a descriptive error on non-OK response", async () => {
    globalThis.fetch = makeFetch({ status: 503, body: { error: "down" } });

    const provider = new OpenAICompatibleSummaryProvider({
      apiKey: "key",
      baseUrl: "http://localhost:11434",
    });

    await assert.rejects(
      async () => provider.generate({ symbolName: "x" }),
      (err: Error) => {
        assert.ok(err.message.includes("503"));
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Cache integration tests (uses isolated DB)
// ---------------------------------------------------------------------------

describe("generateSummaryWithGuardrails — cache integration", () => {
  const testDbPath = join(__dirname, "test-summary-generator.db");

  beforeEach(() => {
    process.env["SDL_DB_PATH"] = testDbPath;
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }
    resetQueryCache();
    const db = getDb();
    runMigrations(db);
  });

  afterEach(() => {
    closeDb();
    resetQueryCache();
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }
    delete process.env["SDL_DB_PATH"];
  });

  it("cache miss — calls provider and persists result", async () => {
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount += 1;
      return {
        ok: true,
        status: 200,
        text: async () => "{}",
        json: async () => ({
          content: [{ type: "text", text: "Generated summary." }],
        }),
      } as unknown as Response;
    };

    // Use 'api' provider with a key so AnthropicSummaryProvider is used
    const result = await generateSummaryWithGuardrails({
      symbolName: "myFunc",
      symbolId: "sym-cache-miss-01",
      kind: "function",
      signature: "myFunc(): void",
      heuristicSummary: "Does something.",
      provider: "api",
      summaryApiKey: "test-api-key",
    });

    assert.ok(result.summary.length > 0);
    assert.strictEqual(callCount, 1, "Provider should be called once on cache miss");

    const cached = getSummaryCache("sym-cache-miss-01");
    assert.ok(cached !== null, "Cache should be populated after first call");
    assert.strictEqual(cached.summary, result.summary);
  });

  it("cache hit — second call with same cardHash does not invoke fetch", async () => {
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount += 1;
      return {
        ok: true,
        status: 200,
        text: async () => "{}",
        json: async () => ({
          content: [{ type: "text", text: "Cached result." }],
        }),
      } as unknown as Response;
    };

    const sharedArgs = {
      symbolName: "cachedFunc",
      symbolId: "sym-cache-hit-01",
      kind: "function",
      signature: "cachedFunc(): string",
      heuristicSummary: "Returns a string.",
      provider: "api",
      summaryApiKey: "test-api-key",
    };

    const first = await generateSummaryWithGuardrails(sharedArgs);
    const second = await generateSummaryWithGuardrails(sharedArgs);

    assert.strictEqual(callCount, 1, "fetch should only be called once — second call hits cache");
    assert.strictEqual(first.summary, second.summary);
  });

  it("cache miss on cardHash change triggers a new provider call", async () => {
    let callCount = 0;
    let callIndex = 0;
    const responses = ["First summary.", "Second summary."];

    globalThis.fetch = async () => {
      callCount += 1;
      const text = responses[callIndex++ % responses.length];
      return {
        ok: true,
        status: 200,
        text: async () => "{}",
        json: async () => ({
          content: [{ type: "text", text: text }],
        }),
      } as unknown as Response;
    };

    // First call: signature v1
    await generateSummaryWithGuardrails({
      symbolName: "evolvedFunc",
      symbolId: "sym-hash-change-01",
      kind: "function",
      signature: "evolvedFunc(a: string): void",
      heuristicSummary: "Does A.",
      provider: "api",
      summaryApiKey: "test-api-key",
    });

    assert.strictEqual(callCount, 1, "First call should invoke provider");

    // Second call: different signature → different cardHash → cache miss
    const result2 = await generateSummaryWithGuardrails({
      symbolName: "evolvedFunc",
      symbolId: "sym-hash-change-01",
      kind: "function",
      signature: "evolvedFunc(a: string, b: number): string",
      heuristicSummary: "Does A and B.",
      provider: "api",
      summaryApiKey: "test-api-key",
    });

    assert.strictEqual(callCount, 2, "Changed cardHash should trigger a new provider call");
    assert.ok(result2.summary.length > 0);
  });

  it("no API key — returns heuristic from mock without throwing", async () => {
    const savedKey = process.env["ANTHROPIC_API_KEY"];
    delete process.env["ANTHROPIC_API_KEY"];

    const result = await generateSummaryWithGuardrails({
      symbolName: "safeFunc",
      symbolId: "sym-no-key-01",
      kind: "function",
      heuristicSummary: "Heuristic text here.",
      provider: "api",
      // no summaryApiKey provided
    });

    assert.ok(result.summary.length > 0, "Should return a non-empty summary");
    assert.strictEqual(result.summary, "Heuristic text here.", "Should return heuristic via mock");
    assert.strictEqual(result.provider, "mock");

    if (savedKey !== undefined) {
      process.env["ANTHROPIC_API_KEY"] = savedKey;
    }
  });
});
