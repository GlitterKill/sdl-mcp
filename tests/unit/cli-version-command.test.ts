import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { readFileSync } from "fs";
import { join } from "path";

describe("CLI version command", () => {
  let capturedOutput: string[];
  let originalLog: typeof console.log;

  beforeEach(() => {
    capturedOutput = [];
    originalLog = console.log;
    console.log = (...args: unknown[]) => {
      capturedOutput.push(args.map(String).join(" "));
    };
  });

  afterEach(() => {
    console.log = originalLog;
  });

  it("outputs the version from package.json", async () => {
    const { versionCommand } = await import(
      "../../dist/cli/commands/version.js"
    );

    await versionCommand({});

    const pkg = JSON.parse(
      readFileSync(join(process.cwd(), "package.json"), "utf-8"),
    );
    const versionLine = capturedOutput.find((line) =>
      line.includes("SDL-MCP version:"),
    );
    assert.ok(versionLine, "Should output a version line");
    assert.ok(
      versionLine.includes(pkg.version),
      `Version line should include ${pkg.version}, got: ${versionLine}`,
    );
  });

  it("outputs Node.js version", async () => {
    const { versionCommand } = await import(
      "../../dist/cli/commands/version.js"
    );

    await versionCommand({});

    const nodeLine = capturedOutput.find((line) => line.includes("Node.js:"));
    assert.ok(nodeLine, "Should output a Node.js version line");
    assert.ok(
      nodeLine.includes(process.version),
      `Node.js line should include ${process.version}`,
    );
  });

  it("outputs platform information", async () => {
    const { versionCommand } = await import(
      "../../dist/cli/commands/version.js"
    );

    await versionCommand({});

    const platformLine = capturedOutput.find((line) =>
      line.includes("Platform:"),
    );
    assert.ok(platformLine, "Should output a platform line");
    assert.ok(
      platformLine.includes(process.platform),
      `Platform line should include ${process.platform}`,
    );
  });

  it("outputs architecture information", async () => {
    const { versionCommand } = await import(
      "../../dist/cli/commands/version.js"
    );

    await versionCommand({});

    const archLine = capturedOutput.find((line) => line.includes("Arch:"));
    assert.ok(archLine, "Should output an architecture line");
    assert.ok(
      archLine.includes(process.arch),
      `Arch line should include ${process.arch}`,
    );
  });

  it("outputs environment section header", async () => {
    const { versionCommand } = await import(
      "../../dist/cli/commands/version.js"
    );

    await versionCommand({});

    const envLine = capturedOutput.find((line) =>
      line.includes("Environment:"),
    );
    assert.ok(envLine, "Should output an Environment section header");
  });
});
