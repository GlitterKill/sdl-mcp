import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";

const ftsContract = JSON.parse(readFileSync("ladybug-openssl/ladybug-fts-0.19.0.json", "utf8"));

const MODES = [
  "missing-runtime-baseline",
  "fixed-regression",
] as const;
type Mode = (typeof MODES)[number];

const requestedMode = process.env.SDL_LADYBUG_WINDOWS_FTS_TEST_MODE;
assert.ok(
  requestedMode === undefined || MODES.includes(requestedMode as Mode),
  "invalid SDL_LADYBUG_WINDOWS_FTS_TEST_MODE: " + requestedMode,
);
const requireModeDependencies =
  process.env.SDL_LADYBUG_WINDOWS_FTS_REQUIRE_MODE === "1";
const selectedNativeAddonPath =
  process.env.SDL_LADYBUG_WINDOWS_FTS_NATIVE_ADDON_PATH;

const childPath = resolve("tests/fixtures/ladybug/windows-fts-clean-env-child.mjs");
const testPath = resolve("tests/integration/live-index-symbol-fts-crash.test.ts");
const workflowPath = resolve(".github/workflows/ladybug-windows-fts-compat.yml");

it("preflights the selected addon content-parser contract", () => {
  const childSource = readFileSync(childPath, "utf8");
  assert.match(childSource, /typeof parserAddon\.parseContent !== "function"/u);
  assert.match(
    childSource,
    /typeof parserAddon\.parserIdentityContractVersion !== "function"/u,
  );
  assert.match(
    childSource,
    /parserAddon\.parserIdentityContractVersion\(\) !== 1/u,
  );
});

it("routes the branch-built addon into the clean fixed-regression child", () => {
  const childSource = readFileSync(childPath, "utf8");
  const testSource = readFileSync(testPath, "utf8");
  const workflowSource = readFileSync(workflowPath, "utf8");
  assert.match(
    workflowSource,
    /if: matrix\.mode == 'fixed-regression'[\s\S]*SDL_LADYBUG_WINDOWS_FTS_NATIVE_ADDON_PATH=\$addonPath/u,
  );
  assert.match(
    testSource,
    /env\.SDL_MCP_NATIVE_ADDON_PATH = selectedNativeAddonPath/u,
  );
  assert.match(
    childSource,
    /require\(process\.env\.SDL_MCP_NATIVE_ADDON_PATH\)/u,
  );
});

it("fails the native build step on the first failed command", () => {
  const workflowSource = readFileSync(workflowPath, "utf8");
  assert.match(
    workflowSource,
    /npm run build:all\r?\n\s+if \(\$LASTEXITCODE -ne 0\) \{ exit \$LASTEXITCODE \}/u,
  );
  assert.match(
    workflowSource,
    /npm run build:native\r?\n\s+if \(\$LASTEXITCODE -ne 0\) \{ exit \$LASTEXITCODE \}/u,
  );
  assert.match(
    workflowSource,
    /npm run native:artifacts\r?\n\s+if \(\$LASTEXITCODE -ne 0\) \{ exit \$LASTEXITCODE \}/u,
  );
});

const accessViolationStatuses = new Set([0xc0000005, -1073741819]);
const fixedEvidence = [
  { phase: "environment", pathDlls: [] },
  { phase: "install", extension: "fts", sha256: ftsContract.artifactSha256 },
  {
    phase: "preload",
    modules: ["libcrypto-3-x64.dll", "libssl-3-x64.dll"],
  },
  { phase: "load", extension: "fts" },
  { phase: "mutation", iterations: 25 },
  { phase: "patchSavedFile", activeFts: true },
  { phase: "shutdown", ok: true },
];
const missingRuntimeEvidence = [
  {
    mode: "missing-runtime-baseline",
    phase: "load",
    classification: "missing-openssl-runtime",
    exitCode: 1,
    imports: ["libcrypto-3-x64.dll", "libssl-3-x64.dll"],
  },
];
const noSdlRuntimeSuccessEvidence = fixedEvidence.filter(
  (item) => item.phase !== "preload",
);
const noSdlRuntimeExpectedFailure = {
  mode: "fixed-regression",
  phase: "load",
  classification: "upstream-runtime-unavailable",
  provisioning: "disabled",
  exitCode: 1,
};

function cleanEnvironment(home: string): NodeJS.ProcessEnv {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    SDL_LOG_LEVEL: "error",
    USERPROFILE: home,
  };
  for (const key of [
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "OPENSSL_CONF",
    "OPENSSL_MODULES",
    "CONDA_PREFIX",
    "SDL_LADYBUG_WINDOWS_FTS_NATIVE_ADDON_PATH",
    "SDL_MCP_NATIVE_ADDON_PATH",
    "SDL_MCP_DISABLE_NATIVE_ADDON",
    "SDL_GRAPH_DB_PATH",
    "SDL_GRAPH_DB_DIR",
    "SDL_CONFIG",
    "SDL_TEST_DISABLE_OPENSSL_PROVISIONING",
    "NODE_OPTIONS",
    "NODE_PATH",
  ]) {
    delete env[key];
  }
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === "path") {
      delete env[key];
    }
    if (/^(?:KUZU|LBUG|LADYBUG).*?(?:EXTENSION|REPOSITORY|REPO)/i.test(key)) {
      delete env[key];
    }
  }
  env.PATH = join(systemRoot, "System32");
  // Only an explicit CI fixture selection may survive the clean environment.
  if (selectedNativeAddonPath) {
    env.SDL_MCP_NATIVE_ADDON_PATH = selectedNativeAddonPath;
  }
  return env;
}

function parseJsonLines(value: string): unknown[] {
  return value
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}

function unavailableEvidence(stderr: string):
  | { classification: "mode-dependency-unavailable"; missing: string[] }
  | undefined {
  for (const line of stderr.split(/\r?\n/u).filter(Boolean)) {
    try {
      const parsed = JSON.parse(line) as {
        classification?: string;
        missing?: unknown;
      };
      if (
        parsed.classification === "mode-dependency-unavailable" &&
        Array.isArray(parsed.missing) &&
        parsed.missing.every((item) => typeof item === "string")
      ) {
        return {
          classification: parsed.classification,
          missing: parsed.missing as string[],
        };
      }
    } catch {
      // Native diagnostics are included in the assertion below.
    }
  }
  return undefined;
}

function runMode(mode: Mode, extraEnv: NodeJS.ProcessEnv = {}) {
  const home = mkdtempSync(join(tmpdir(), "ladybug-windows-fts-" + mode + "-"));
  try {
    return spawnSync(process.execPath, [childPath, mode], {
      cwd: resolve("."),
      encoding: "utf8",
      env: { ...cleanEnvironment(home), ...extraEnv },
      timeout: 60_000,
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function failureMessage(
  mode: Mode,
  result: ReturnType<typeof runMode>,
): string {
  return [
    mode + " child exited with " + result.status,
    result.error?.stack ?? result.error?.message ?? "",
    result.stdout,
    result.stderr,
  ].join("\n");
}

// Historical workaround context:
// devdocs/implemented/specs/2026-07-13-live-index-symbol-fts-crash-fix-design.md
for (const mode of MODES) {
  it(
    "isolates Ladybug Windows FTS mode: " + mode,
    {
      skip:
        process.platform !== "win32" ||
        (requestedMode !== undefined && requestedMode !== mode)
          ? "Windows-only mode not selected"
          : false,
    },
    (t) => {
      const result = runMode(mode);
      assert.notEqual(result.error?.code, "ETIMEDOUT", failureMessage(mode, result));
      const accessViolation =
        result.status !== null && accessViolationStatuses.has(result.status);

      assert.ok(
        !accessViolation,
        "native access violation 0xC0000005\n" + failureMessage(mode, result),
      );
      const unavailable = unavailableEvidence(result.stderr);
      if (unavailable) {
        assert.equal(
          requireModeDependencies,
          false,
          "required mode dependencies unavailable: " + unavailable.missing.join(", "),
        );
        t.skip(unavailable.missing.join(", "));
        return;
      }
      assert.equal(result.status, 0, failureMessage(mode, result));
      console.log(result.stdout.trim());
      if (result.stderr.trim()) console.log(result.stderr.trim());
      if (mode === "missing-runtime-baseline") {
        assert.deepEqual(parseJsonLines(result.stdout), missingRuntimeEvidence);
      }
      if (mode === "fixed-regression") {
        assert.deepEqual(parseJsonLines(result.stdout), fixedEvidence);
      }
    },
  );
}


it(
  "probes upstream Windows FTS without SDL OpenSSL provisioning",
  {
    skip:
      process.platform !== "win32" ||
      (requestedMode !== undefined && requestedMode !== "fixed-regression")
        ? "Windows-only fixed-regression probe not selected"
        : false,
  },
  (t) => {
    const result = runMode("fixed-regression", {
      SDL_TEST_DISABLE_OPENSSL_PROVISIONING: "1",
    });
    assert.notEqual(result.error?.code, "ETIMEDOUT", failureMessage("fixed-regression", result));
    const accessViolation =
      result.status !== null && accessViolationStatuses.has(result.status);
    assert.ok(
      !accessViolation,
      "native access violation 0xC0000005\n" + failureMessage("fixed-regression", result),
    );
    const unavailable = unavailableEvidence(result.stderr);
    if (unavailable) {
      assert.equal(requireModeDependencies, false, unavailable.missing.join(", "));
      t.skip(unavailable.missing.join(", "));
      return;
    }
    assert.equal(result.status, 0, failureMessage("fixed-regression", result));
    const evidence = parseJsonLines(result.stdout);
    assert.deepEqual(evidence.slice(0, 2), noSdlRuntimeSuccessEvidence.slice(0, 2));
    if (JSON.stringify(evidence.at(-1)) === JSON.stringify(noSdlRuntimeExpectedFailure)) {
      t.skip("upstream still requires SDL OpenSSL provisioning");
      return;
    }
    assert.deepEqual(evidence, noSdlRuntimeSuccessEvidence);
  },
);
