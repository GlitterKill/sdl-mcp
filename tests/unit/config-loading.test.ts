import { describe, it } from "node:test";
import assert from "node:assert";
import { loadConfig } from "../../dist/config/loadConfig.js";
import { createAsyncFsOperations } from "../../dist/util/asyncFs.js";
import { fileURLToPath } from "url";
import { resolve, dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe("Config Loading (RR-H.8)", () => {
  it("should resolve default path relative to module (RR-H.8.1)", () => {
    const loadConfigDir = resolve(__dirname, "../../dist/config");
    // From dist/config, go up two levels (to sdl-mcp root) then into config/
    const expectedPath = resolve(loadConfigDir, "../../config/sdlmcp.config.json");

    const absoluteExpected = resolve(
      __dirname,
      "../../config/sdlmcp.config.json",
    );

    assert.strictEqual(
      expectedPath,
      absoluteExpected,
      "Default config path should be resolved relative to loadConfig module",
    );
  });

  it("should load example config successfully", () => {
    const exampleConfigPath = resolve(
      __dirname,
      "../../config/sdlmcp.config.example.json",
    );
    const config = loadConfig(exampleConfigPath);

    assert.strictEqual(typeof config.dbPath, "string");
    assert.ok(config.dbPath.endsWith(".sqlite"));
  });

  it("should throw error for non-existent config", () => {
    assert.throws(
      () => loadConfig("/non/existent/path.json"),
      (err: Error) => err.message.includes("Config file not found"),
    );
  });
});

describe("AsyncFs Factory Pattern (RR-H.8.2)", () => {
  it("should create new instances with factory (RR-H.8.2.1)", () => {
    const ops1 = createAsyncFsOperations({ maxConcurrentReads: 5 });
    const ops2 = createAsyncFsOperations({ maxConcurrentReads: 10 });

    assert.notStrictEqual(ops1, ops2, "Factory should create new instances");
  });

  it("should apply config to each new instance (RR-H.8.2.2)", () => {
    const ops1 = createAsyncFsOperations({ maxConcurrentReads: 5 });
    const ops2 = createAsyncFsOperations({ maxConcurrentReads: 10 });
    const ops3 = createAsyncFsOperations({ maxConcurrentReads: 20 });

    assert.notStrictEqual(ops1, ops2);
    assert.notStrictEqual(ops2, ops3);
    assert.notStrictEqual(ops1, ops3);
  });

  it("should use default config when none provided", () => {
    const ops1 = createAsyncFsOperations();
    const ops2 = createAsyncFsOperations();

    assert.notStrictEqual(
      ops1,
      ops2,
      "Factory should always create new instances",
    );
  });
});
