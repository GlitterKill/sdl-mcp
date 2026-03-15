import { describe, it } from "node:test";
import assert from "node:assert";

import {
  buildRedactionPatterns,
  compilePatterns,
  redactSecrets,
  shouldRedactFile,
} from "../../src/code/redact.js";

describe("redact compilePatterns", () => {
  it("compiles valid custom patterns", () => {
    const compiled = compilePatterns([
      { name: "alpha", pattern: "alpha\\d+" },
      { name: "beta", pattern: "BETA", flags: "gi" },
    ]);

    assert.strictEqual(compiled.length, 2);
    assert.strictEqual(compiled[0]?.name, "alpha");
    assert.ok(compiled[0]?.pattern.test("alpha42"));
    assert.strictEqual(compiled[1]?.name, "beta");
    assert.ok(compiled[1]?.pattern.test("beta"));
  });

  it("skips invalid and unsafe patterns", () => {
    const compiled = compilePatterns([
      { name: "safe", pattern: "foo" },
      { name: "invalid", pattern: "[unterminated" },
      { name: "redos", pattern: "(a+)+b" },
    ]);

    assert.deepStrictEqual(
      compiled.map((p) => p.name),
      ["safe"],
    );
  });

  it("assigns auto-generated names for unnamed patterns", () => {
    const compiled = compilePatterns([{ pattern: "foo" }, { pattern: "bar" }]);

    assert.deepStrictEqual(
      compiled.map((p) => p.name),
      ["custom-0", "custom-1"],
    );
  });
});

describe("redact buildRedactionPatterns", () => {
  it("includes defaults when includeDefaults is true", () => {
    const patterns = buildRedactionPatterns({ includeDefaults: true });
    assert.ok(patterns.length >= 8);
    assert.ok(patterns.some((p) => p.name === "aws-access-key"));
    assert.ok(patterns.some((p) => p.name === "env-variable"));
  });

  it("excludes defaults when includeDefaults is false", () => {
    const patterns = buildRedactionPatterns({ includeDefaults: false });
    assert.strictEqual(patterns.length, 0);
  });

  it("adds custom patterns and preserves custom order before defaults", () => {
    const patterns = buildRedactionPatterns({
      includeDefaults: true,
      patterns: [{ name: "custom-secret", pattern: "mysecret\\d+" }],
    });

    assert.strictEqual(patterns[0]?.name, "custom-secret");
    assert.ok(patterns.some((p) => p.name === "aws-access-key"));
  });

  it("returns only compiled custom patterns when defaults disabled", () => {
    const patterns = buildRedactionPatterns({
      includeDefaults: false,
      patterns: [{ pattern: "safe\\d+" }, { pattern: "(x+)+" }],
    });

    assert.deepStrictEqual(
      patterns.map((p) => p.name),
      ["custom-0"],
    );
  });
});

describe("redact redactSecrets", () => {
  it("redacts AWS access keys", () => {
    const input = "const aws = 'AKIA1234567890ABCDEF';";
    const output = redactSecrets(input);
    assert.ok(output.includes("[REDACTED:aws-access-key]"));
  });

  it("redacts GitHub tokens", () => {
    const input = "const gh = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';";
    const output = redactSecrets(input);
    assert.ok(output.includes("[REDACTED:github-token]"));
  });

  it("redacts generic API key assignments", () => {
    const input = 'api_key = "abcdefghijklmnopqrstuvwx"';
    const output = redactSecrets(input);
    assert.ok(output.includes("[REDACTED:api-key]"));
  });

  it("redacts password assignments", () => {
    const input = 'password: "supersecret99"';
    const output = redactSecrets(input);
    assert.ok(output.includes("[REDACTED:password]"));
  });

  it("redacts connection strings", () => {
    const input = "dsn = mongodb://user:pass@localhost:27017/mydb";
    const output = redactSecrets(input);
    assert.ok(output.includes("[REDACTED:connection-string]"));
  });

  it("redacts JWT tokens", () => {
    const input = "token=eyJabcdefghijk.ABCDEFGHIJKL.mnopqrstuvWX";
    const output = redactSecrets(input);
    assert.ok(output.includes("[REDACTED:jwt-token]"));
  });

  it("redacts private key headers", () => {
    const input = "-----BEGIN RSA PRIVATE KEY-----\n...";
    const output = redactSecrets(input);
    assert.ok(output.includes("[REDACTED:private-key]"));
  });

  it("redacts sensitive env variable assignments", () => {
    const input = "TOKEN_VALUE = ABCDEFGHIJKLMNOPQRSTUVWX";
    const output = redactSecrets(input);
    assert.ok(output.includes("[REDACTED:env-variable]"));
  });

  it("applies custom redaction patterns", () => {
    const output = redactSecrets("client_secret=my-value", [
      { name: "client-secret", pattern: /client_secret=my-value/g },
    ]);

    assert.strictEqual(output, "[REDACTED:client-secret]");
  });

  it("does not redact safe code patterns", () => {
    const input = [
      "const MAX_BUFFER_SIZE = 1024;",
      "const authMode = 'TOKEN';",
      "const apiVersion = 'v1';",
    ].join("\n");
    const output = redactSecrets(input);
    assert.strictEqual(output, input);
  });
});

describe("redact shouldRedactFile", () => {
  it("returns true for all excluded files", () => {
    const excluded = [
      ".env",
      ".env.local",
      ".env.production",
      ".env.development",
      ".env.test",
      "server.key",
      "server.pem",
      "credentials.json",
      "secrets.yaml",
      "secrets.yml",
      ".secrets",
      "config/secrets.json",
      ".aws/credentials",
    ];

    for (const file of excluded) {
      assert.strictEqual(shouldRedactFile(file), true, file);
    }
  });

  it("returns false for non-excluded files", () => {
    assert.strictEqual(shouldRedactFile("src/index.ts"), false);
    assert.strictEqual(shouldRedactFile("config/settings.json"), false);
    assert.strictEqual(shouldRedactFile("notes/secrets.txt"), false);
  });

  it("handles Windows-style paths", () => {
    assert.strictEqual(
      shouldRedactFile("C:\\repo\\app\\.env.production"),
      true,
    );
    assert.strictEqual(
      shouldRedactFile("C:\\Users\\dev\\.aws\\credentials"),
      true,
    );
    assert.strictEqual(shouldRedactFile("C:\\repo\\src\\app.ts"), false);
  });
});
