import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";

const MODES = [
  "legacy-crash-baseline",
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

const childPath = resolve("tests/fixtures/ladybug/windows-fts-clean-env-child.mjs");
const accessViolationStatuses = new Set([0xc0000005, -1073741819]);
const fixedEvidence = [
  { phase: "environment", pathDlls: [] },
  { phase: "install", extension: "fts" },
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
    "CONDA_PREFIX",
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

      if (mode === "legacy-crash-baseline") {
        const unavailable = unavailableEvidence(result.stderr);
        if (unavailable) {
          assert.equal(
            requireModeDependencies,
            false,
            "required mode dependencies unavailable: " +
              unavailable.missing.join(", "),
          );
          t.skip(unavailable.missing.join(", "));
          return;
        }
        assert.ok(
          accessViolation,
          "expected native access violation 0xC0000005\n" +
            failureMessage(mode, result),
        );
        return;
      }

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
