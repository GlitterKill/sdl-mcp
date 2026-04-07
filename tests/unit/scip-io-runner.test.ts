/**
 * Unit tests for src/scip/scip-io-runner.ts.
 *
 * These tests exercise the runner without touching the network or installing
 * a real binary. They:
 *
 *   - Verify `detectScipIo` finds a stub on PATH and returns null when missing.
 *   - Verify `runScipIoIndex` spawns the configured binary with the right
 *     args, cwd, and exit-code handling, including timeout/abort behavior,
 *     by using a tiny Node script as the "scip-io" binary.
 *   - Verify the in-flight install lock single-flights concurrent calls.
 *
 * No real network calls, no real scip-io binary, no real refresh — that's
 * covered by tests/integration/scip-io-pre-refresh.test.ts.
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import {
  __resetInstallLockForTests,
  detectScipIo,
  installScipIo,
  runScipIoIndex,
  ScipIoInstallError,
} from "../../dist/scip/scip-io-runner.js";

const IS_WINDOWS = process.platform === "win32";

/**
 * Create a stub "scip-io" executable inside `dir` that, when invoked, prints
 * a fixed line to stdout and exits with the supplied exit code.
 *
 * On Windows we generate a `.cmd` wrapper because `where` only finds files
 * with extensions in PATHEXT, and `.exe` requires a real PE binary. The
 * `.cmd` is named `scip-io.cmd` so the lookup logic (which strips `.exe`
 * before searching) still locates it via `where scip-io`.
 *
 * On Unix we generate a `bash` script and chmod 755.
 *
 * Returns the absolute path to the stub.
 */
function makeStubBinary(
  dir: string,
  opts: { exitCode?: number; sleepMs?: number; logFile?: string } = {},
): string {
  const exitCode = opts.exitCode ?? 0;
  if (IS_WINDOWS) {
    const path = join(dir, "scip-io.cmd");
    const lines: string[] = ["@echo off", "echo scip-io stub invoked %*"];
    if (opts.logFile) {
      // %CD% records the cwd; %* records all args. Useful for asserting
      // the runner passed the expected cwd and "index" arg.
      lines.push(`>>"${opts.logFile}" echo cwd=%CD% args=%*`);
    }
    if (opts.sleepMs) {
      // PowerShell's Start-Sleep is the most portable way to sleep.
      lines.push(
        `powershell -nop -c "Start-Sleep -Milliseconds ${opts.sleepMs}"`,
      );
    }
    lines.push(`exit /b ${exitCode}`);
    writeFileSync(path, lines.join("\r\n") + "\r\n", "utf-8");
    return path;
  }

  const path = join(dir, "scip-io");
  const lines: string[] = [
    "#!/usr/bin/env bash",
    'echo "scip-io stub invoked $@"',
  ];
  if (opts.logFile) {
    lines.push(`echo "cwd=$PWD args=$@" >> "${opts.logFile}"`);
  }
  if (opts.sleepMs) {
    lines.push(`sleep ${opts.sleepMs / 1000}`);
  }
  lines.push(`exit ${exitCode}`);
  writeFileSync(path, lines.join("\n") + "\n", "utf-8");
  chmodSync(path, 0o755);
  return path;
}

describe("scip-io-runner: detectScipIo", () => {
  let tmp = "";
  const prevPath = process.env.PATH;

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "scip-io-detect-"));
  });

  after(() => {
    process.env.PATH = prevPath;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("finds a stub binary on PATH", async () => {
    const stubDir = join(tmp, "bin-found");
    mkdirSync(stubDir, { recursive: true });
    makeStubBinary(stubDir);

    process.env.PATH = stubDir + delimiter + (prevPath ?? "");
    const result = await detectScipIo();
    assert.ok(result, "expected to find stub binary");
    assert.equal(result.source, "path");
    assert.match(result.binaryPath, /scip-io/);
  });

  it("returns null when binary is missing from PATH and managed dir", async () => {
    // Clean PATH so the only entry is a known-empty dir.
    const emptyDir = join(tmp, "empty-bin");
    mkdirSync(emptyDir, { recursive: true });
    process.env.PATH = emptyDir;

    // Use a binary name that cannot exist anywhere.
    const result = await detectScipIo("scip-io-test-no-such-binary-xyz");
    assert.equal(result, null);
  });
});

describe("scip-io-runner: runScipIoIndex", () => {
  let tmp = "";

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "scip-io-run-"));
  });

  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("spawns the binary with cwd=repoRoot and 'index' as the first arg", async () => {
    const binDir = join(tmp, "bin1");
    const repoDir = join(tmp, "repo1");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(repoDir, { recursive: true });
    const logFile = join(tmp, "invocation1.log");
    const stub = makeStubBinary(binDir, { exitCode: 0, logFile });

    const result = await runScipIoIndex({
      binaryPath: stub,
      repoRootPath: repoDir,
      timeoutMs: 30_000,
    });

    assert.equal(result.ok, true, `expected ok=true, stderr=${result.stderr}`);
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);

    // Verify cwd and args via the log file the stub wrote.
    const log = (await import("node:fs")).readFileSync(logFile, "utf-8");
    assert.match(log, /args=.*index/, `log was: ${log}`);
    // The stub records cwd=%CD%/$PWD; on Windows this is the literal repoDir
    // path, on Unix it may be the realpath. Compare basenames to avoid
    // /private/tmp vs /tmp differences on macOS.
    const repoBase = (await import("node:path")).basename(repoDir);
    assert.match(log, new RegExp(repoBase));
  });

  it("returns ok=false on non-zero exit", async () => {
    const binDir = join(tmp, "bin2");
    const repoDir = join(tmp, "repo2");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(repoDir, { recursive: true });
    const stub = makeStubBinary(binDir, { exitCode: 7 });

    const result = await runScipIoIndex({
      binaryPath: stub,
      repoRootPath: repoDir,
      timeoutMs: 30_000,
    });

    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 7);
    assert.equal(result.timedOut, false);
  });

  it("times out and reports timedOut=true", async () => {
    const binDir = join(tmp, "bin3");
    const repoDir = join(tmp, "repo3");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(repoDir, { recursive: true });
    const stub = makeStubBinary(binDir, { exitCode: 0, sleepMs: 5000 });

    const start = Date.now();
    const result = await runScipIoIndex({
      binaryPath: stub,
      repoRootPath: repoDir,
      timeoutMs: 500,
    });
    const elapsed = Date.now() - start;

    assert.equal(result.ok, false);
    assert.equal(result.timedOut, true);
    // Allow generous slack for CI; should be well under 5s if timeout fired.
    assert.ok(
      elapsed < 4000,
      `expected timeout to fire well before 5s sleep finished, took ${elapsed}ms`,
    );
  });

  it("returns ok=false when the binary path does not exist", async () => {
    const repoDir = join(tmp, "repo-missing-binary");
    mkdirSync(repoDir, { recursive: true });
    const result = await runScipIoIndex({
      binaryPath: join(tmp, "definitely-not-a-binary"),
      repoRootPath: repoDir,
      timeoutMs: 5000,
    });
    assert.equal(result.ok, false);
    // exitCode is null on spawn error
    assert.equal(result.exitCode, null);
  });
});

describe("scip-io-runner: installScipIo security hardening", () => {
  // Regression coverage for the code-review fixes:
  //   - Mandatory SHA256SUMS.txt: refuse to install if checksum file absent
  //   - Download URL allowlist: reject non-github.com hosts
  //
  // Each test monkey-patches global.fetch to simulate a specific API
  // response, then asserts that installScipIo rejects with ScipIoInstallError
  // and that the rejection message mentions the expected failure reason.

  let originalFetch: typeof fetch | undefined;

  before(() => {
    originalFetch = globalThis.fetch;
  });

  after(() => {
    __resetInstallLockForTests();
    if (originalFetch) globalThis.fetch = originalFetch;
  });

  it("refuses to install when SHA256SUMS.txt is absent from the release", async () => {
    __resetInstallLockForTests();
    // Return a valid-shape release payload with the archive asset but NO
    // SHA256SUMS.txt. This is exactly the downgrade-attack vector the
    // hard-error fix closes.
    const platform = process.platform;
    const arch = process.arch;
    // Build a plausible asset name matching the runner's platform mapping.
    let assetName = "";
    if (platform === "win32" && arch === "x64")
      assetName = "scip-io-v0.1.1-x86_64-pc-windows-msvc.zip";
    else if (platform === "darwin" && arch === "x64")
      assetName = "scip-io-v0.1.1-x86_64-apple-darwin.tar.gz";
    else if (platform === "darwin" && arch === "arm64")
      assetName = "scip-io-v0.1.1-aarch64-apple-darwin.tar.gz";
    else if (platform === "linux" && arch === "x64")
      assetName = "scip-io-v0.1.1-x86_64-unknown-linux-gnu.tar.gz";
    else {
      // Unsupported platform — we expect ScipIoUnsupportedPlatformError
      // instead of the checksum error, which is also acceptable coverage.
      assetName = "scip-io-v0.1.1-unknown.tar.gz";
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async (url: unknown) => {
      const urlStr = String(url);
      if (urlStr.includes("api.github.com")) {
        return new Response(
          JSON.stringify({
            tag_name: "v0.1.1",
            assets: [
              {
                name: assetName,
                size: 1024,
                browser_download_url: `https://github.com/GlitterKill/scip-io/releases/download/v0.1.1/${assetName}`,
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("unexpected", { status: 500 });
    };

    let err: unknown;
    try {
      await installScipIo();
    } catch (e) {
      err = e;
    }
    assert.ok(
      err instanceof ScipIoInstallError,
      `expected ScipIoInstallError, got ${err}`,
    );
    // The error message must mention SHA256SUMS.txt so users know why it
    // failed and how to fix it.
    const msg = (err as Error).message;
    assert.match(
      msg,
      /SHA256SUMS\.txt/,
      `error message should mention SHA256SUMS.txt: ${msg}`,
    );
  });

  it("rejects download URLs pointing at non-github.com hosts", async () => {
    __resetInstallLockForTests();
    const platform = process.platform;
    const arch = process.arch;
    let assetName = "";
    if (platform === "win32" && arch === "x64")
      assetName = "scip-io-v0.1.1-x86_64-pc-windows-msvc.zip";
    else if (platform === "darwin" && arch === "x64")
      assetName = "scip-io-v0.1.1-x86_64-apple-darwin.tar.gz";
    else if (platform === "darwin" && arch === "arm64")
      assetName = "scip-io-v0.1.1-aarch64-apple-darwin.tar.gz";
    else if (platform === "linux" && arch === "x64")
      assetName = "scip-io-v0.1.1-x86_64-unknown-linux-gnu.tar.gz";
    else assetName = "scip-io-v0.1.1-unknown.tar.gz";

    // Simulate a tampered API response: the archive's download URL points
    // at an attacker-controlled host. SHA256SUMS.txt is present (to get
    // past the first gate) but also points at a hostile host.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async (url: unknown) => {
      const urlStr = String(url);
      if (urlStr.includes("api.github.com")) {
        return new Response(
          JSON.stringify({
            tag_name: "v0.1.1",
            assets: [
              {
                name: assetName,
                size: 1024,
                browser_download_url: `https://evil.example.com/${assetName}`,
              },
              {
                name: "SHA256SUMS.txt",
                size: 256,
                browser_download_url:
                  "https://github.com/GlitterKill/scip-io/releases/download/v0.1.1/SHA256SUMS.txt",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("unexpected", { status: 500 });
    };

    let err: unknown;
    try {
      await installScipIo();
    } catch (e) {
      err = e;
    }
    assert.ok(
      err instanceof ScipIoInstallError,
      `expected ScipIoInstallError, got ${err}`,
    );
    const msg = (err as Error).message;
    // The error must mention the host or the allowlist so the failure is
    // diagnosable from logs alone.
    assert.match(
      msg,
      /host|allowed|github\.com/i,
      `error message should reference the allowlist: ${msg}`,
    );
  });
});

describe("scip-io-runner: installScipIo single-flight lock", () => {
  // Monkey-patch global.fetch so the test never touches the network. The
  // mock returns a 503 so the install fails fast with ScipIoInstallError.
  // Both parallel calls must share the same rejection reason — which only
  // happens if the in-flight lock is honored.
  let originalFetch: typeof fetch | undefined;
  let fetchCallCount = 0;

  before(() => {
    __resetInstallLockForTests();
    originalFetch = globalThis.fetch;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async (_url: unknown, _init?: unknown) => {
      fetchCallCount++;
      // Resolve on a microtask so that the second installScipIo() call has
      // a chance to enter the in-flight lock check before the first one
      // resolves and clears it.
      await new Promise((r) => setImmediate(r));
      return new Response("simulated outage", {
        status: 503,
        statusText: "Service Unavailable",
      });
    };
  });

  after(() => {
    __resetInstallLockForTests();
    if (originalFetch) {
      globalThis.fetch = originalFetch;
    }
  });

  it("two parallel install calls share a single in-flight promise", async () => {
    fetchCallCount = 0;
    const pair = await Promise.allSettled([installScipIo(), installScipIo()]);

    assert.equal(pair[0].status, "rejected");
    assert.equal(pair[1].status, "rejected");

    // The single-flight lock means both calls share the same underlying
    // promise, so both rejections must reference the exact same error
    // object. This is the most direct proof the lock works.
    if (pair[0].status === "rejected" && pair[1].status === "rejected") {
      assert.equal(
        pair[0].reason,
        pair[1].reason,
        "both parallel installs must reject with the SAME error object (proves single-flight lock)",
      );
      assert.ok(pair[0].reason instanceof ScipIoInstallError);
    }

    // The mock fetch should have been called exactly once if the lock
    // worked: only the first installScipIo() actually hit fetch; the second
    // joined the in-flight promise without re-issuing the request.
    assert.equal(
      fetchCallCount,
      1,
      `expected exactly 1 fetch call (single-flight), got ${fetchCallCount}`,
    );
  });
});
