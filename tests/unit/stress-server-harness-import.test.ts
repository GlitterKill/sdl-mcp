import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "../..");

function runCommand(command: string, args: string[]) {
  if (process.platform === "win32") {
    const comspec = process.env.ComSpec ?? "cmd.exe";
    return spawnSync(comspec, ["/d", "/s", "/c", command, ...args], {
      cwd: repoRoot,
      encoding: "utf8",
    });
  }

  return spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

describe("compiled stress server harness", () => {
  before(() => {
    const build = runCommand("npm", ["run", "build"]);

    assert.strictEqual(
      build.status,
      0,
      `Expected npm run build to succeed.\nSTDOUT:\n${build.stdout}\nSTDERR:\n${build.stderr}`,
    );

    const compile = runCommand(
      "npx",
      [
        "tsc",
        "--rootDir",
        "tests/stress",
        "--outDir",
        "dist/tests/stress",
        "--module",
        "nodenext",
        "tests/stress/infra/server-harness.ts",
      ],
    );

    assert.strictEqual(
      compile.status,
      0,
      `Expected stress harness compilation to succeed.\nSTDOUT:\n${compile.stdout}\nSTDERR:\n${compile.stderr}`,
    );
  });

  it("imports without resolving dist/dist paths", () => {
    const importResult = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "import { pathToFileURL } from 'node:url'; await import(pathToFileURL(process.argv[1]).href);",
        resolve(repoRoot, "dist/tests/stress/infra/server-harness.js"),
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
      },
    );

    assert.strictEqual(
      importResult.status,
      0,
      `Expected compiled stress server harness to import successfully.\nSTDOUT:\n${importResult.stdout}\nSTDERR:\n${importResult.stderr}`,
    );
  });

  it("initializes LadybugDB before accepting stress traffic", () => {
    const lifecycleResult = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
          import assert from "node:assert/strict";
          import { resolve } from "node:path";
          import { pathToFileURL } from "node:url";

          const repoRoot = process.argv[1];
          const harnessUrl = pathToFileURL(resolve(repoRoot, "dist/tests/stress/infra/server-harness.js")).href;
          const typesUrl = pathToFileURL(resolve(repoRoot, "dist/tests/stress/infra/types.js")).href;
          const { ServerHarness } = await import(harnessUrl);
          const { DEFAULT_CONFIG } = await import(typesUrl);

          const harness = new ServerHarness({
            ...DEFAULT_CONFIG,
            fixturePath: resolve(repoRoot, "tests/stress/fixtures"),
          });

          try {
            await harness.start({ maxSessions: 1, maxToolConcurrency: 1 });
            const poolStats = harness.getPoolStats();
            assert.equal(poolStats.writeInitialized, true);
            assert.equal(poolStats.readPoolInitialized > 0, true);
          } finally {
            await harness.stop();
          }
        `,
        repoRoot,
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
      },
    );

    assert.strictEqual(
      lifecycleResult.status,
      0,
      `Expected stress harness startup to initialize LadybugDB.\nSTDOUT:\n${lifecycleResult.stdout}\nSTDERR:\n${lifecycleResult.stderr}`,
    );
  });
});
