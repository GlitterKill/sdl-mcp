import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { describe, it } from "node:test";

import {
  isWindowsFtsRuntimeUnavailable,
  withWindowsFtsRuntime,
  type WindowsFtsRuntimeOptions,
} from "../../src/db/ladybug-windows-fts-runtime.ts";

const packageName = "@sdl-mcp/ladybug-openssl-win32-x64";
const ladybugSource = readFileSync("src/db/ladybug.ts", "utf8");
const openChildPath = resolve(
  "tests/fixtures/ladybug/windows-fts-open-child.mjs",
);

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function createRuntimePackage(version = "3.5.7-sdl.2"): {
  root: string;
  cleanup: () => void;
  options: Pick<WindowsFtsRuntimeOptions, "requireResolve">;
} {
  const root = mkdtempSync(join(tmpdir(), "sdl-fts-runtime-test-"));
  const bin = join(root, "bin");
  const crypto = "crypto-runtime";
  const ssl = "ssl-runtime";
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: packageName, version }), "utf8");
  writeFileSync(join(root, "provenance.json"), JSON.stringify({
    artifacts: {
      "bin/libcrypto-3-x64.dll": { sha256: sha256(crypto) },
      "bin/libssl-3-x64.dll": { sha256: sha256(ssl) },
    },
  }), "utf8");
  writeFileSync(join(root, "README.md"), "fixture", "utf8");
  writeFileSync(join(root, "OPENSSL-LICENSE.txt"), "fixture", "utf8");
  writeFileSync(join(root, "provenance-extra.txt"), "ignored", "utf8");
  writeFileSync(join(root, "package-lock.json"), "{}", "utf8");
  writeFileSync(join(root, "sbom.spdx.json"), "fixture", "utf8");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "libcrypto-3-x64.dll"), crypto, "utf8");
  writeFileSync(join(bin, "libssl-3-x64.dll"), ssl, "utf8");

  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
    options: {
      requireResolve: (specifier) => {
        assert.equal(specifier, packageName + "/package.json");
        return join(root, "package.json");
      },
    },
  };
}

function windowsOptions(options: Partial<WindowsFtsRuntimeOptions> = {}): WindowsFtsRuntimeOptions {
  return { platform: "win32", arch: "x64", ...options };
}

function cleanWindowsChildEnvironment(
  home: string,
  dbPath: string,
): NodeJS.ProcessEnv {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  return {
    HOME: home,
    PATH: join(systemRoot, "System32"),
    SDL_GRAPH_DB_PATH: dbPath,
    SDL_LOG_LEVEL: "error",
    SystemRoot: systemRoot,
    TEMP: home,
    TMP: home,
    USERPROFILE: home,
  };
}

function runOpenChild(mode: "seed" | "open", home: string, dbPath: string) {
  return spawnSync(process.execPath, [openChildPath, mode, dbPath], {
    cwd: resolve("."),
    encoding: "utf8",
    env: cleanWindowsChildEnvironment(home, dbPath),
    timeout: 60_000,
  });
}

function openChildFailure(
  mode: "seed" | "open",
  result: ReturnType<typeof runOpenChild>,
): string {
  return [
    mode + " child exited with " + result.status,
    result.error?.stack ?? result.error?.message ?? "",
    result.stdout,
    result.stderr,
  ].join("\n");
}

describe("withWindowsFtsRuntime", () => {
  it(
    "reopens a populated FTS database across clean child processes",
    {
      skip:
        process.platform !== "win32"
          ? "Windows-only FTS runtime boundary"
          : false,
    },
    () => {
      const home = mkdtempSync(join(tmpdir(), "sdl-fts-reopen-test-"));
      const dbPath = join(home, "fts-reopen.lbug");
      try {
        const seeded = runOpenChild("seed", home, dbPath);
        assert.notEqual(
          seeded.error?.code,
          "ETIMEDOUT",
          openChildFailure("seed", seeded),
        );
        assert.equal(seeded.status, 0, openChildFailure("seed", seeded));

        // Repeating the process boundary catches DLL handle lifetime mistakes
        // that a same-process singleton reopen cannot expose.
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const opened = runOpenChild("open", home, dbPath);
          assert.notEqual(
            opened.error?.code,
            "ETIMEDOUT",
            openChildFailure("open", opened),
          );
          assert.equal(opened.status, 0, openChildFailure("open", opened));
        }
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it("does not require the Windows FTS runtime before importing Ladybug core", () => {
    assert.match(
      ladybugSource,
      /async function loadLadybug\(\)[\s\S]*?const imported = await import\("kuzu"\)/u,
    );
    assert.doesNotMatch(
      ladybugSource,
      /withWindowsFtsRuntime\(\s*async\s*\(\)\s*=>\s*\{[\s\S]*?import\("kuzu"\)/u,
      "optional Windows FTS runtime failures must not block non-FTS Ladybug startup",
    );
  });

  it("preloads the Windows runtime only around LOAD EXTENSION fts", () => {
    assert.match(
      ladybugSource,
      /if \(ext === "fts"\) \{[\s\S]*?withWindowsFtsRuntime\(\(\) =>[\s\S]*?execDdl\(conn, `LOAD EXTENSION \$\{ext\}`\)/u,
    );
  });

  it("bypasses preloading outside Windows x64 and forwards the load result", async () => {
    let calls = 0;
    const result = await withWindowsFtsRuntime(async () => {
      calls += 1;
      return "loaded";
    }, { platform: "linux", arch: "x64" });

    assert.equal(result, "loaded");
    assert.equal(calls, 1);
  });

  it("bypasses provisioning when the upstream no-runtime probe disables it", async () => {
    let calls = 0;
    const result = await withWindowsFtsRuntime(async () => {
      calls += 1;
      return "loaded";
    }, windowsOptions({
      disableProvisioning: true,
      requireResolve: () => {
        throw new Error("should not resolve package");
      },
    }));

    assert.equal(result, "loaded");
    assert.equal(calls, 1);
  });

  it("returns missing-package without calling LOAD when the runtime package cannot resolve", async () => {
    let calls = 0;
    const result = await withWindowsFtsRuntime(async () => {
      calls += 1;
      return "loaded";
    }, windowsOptions({
      requireResolve: () => {
        throw new Error("not found");
      },
    }));

    assert.equal(calls, 0);
    assert.equal(isWindowsFtsRuntimeUnavailable(result), true);
    assert.equal(isWindowsFtsRuntimeUnavailable(result) ? result.reason : undefined, "missing-package");
    assert.match(
      isWindowsFtsRuntimeUnavailable(result) ? result.recovery : "",
      /@sdl-mcp\/ladybug-openssl-win32-x64@3\.5\.7-sdl\.2/u,
    );
    assert.doesNotMatch(isWindowsFtsRuntimeUnavailable(result) ? result.recovery : "", /[A-Z]:\\|\\Users\\|\/tmp\//u);
  });

  it("rejects the retired 3.5.7-sdl.1 runtime package", async () => {
    const fixture = createRuntimePackage("3.5.7-sdl.1");
    try {
      const result = await withWindowsFtsRuntime(
        async () => "loaded",
        windowsOptions({ ...fixture.options, loadNativeAddon: () => null }),
      );
      assert.equal(isWindowsFtsRuntimeUnavailable(result), true);
      assert.equal(
        isWindowsFtsRuntimeUnavailable(result) ? result.reason : undefined,
        "invalid-package",
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("returns invalid-package when package metadata or hashes do not match", async () => {
    const fixture = createRuntimePackage();
    try {
      writeFileSync(join(fixture.root, "bin", "libssl-3-x64.dll"), "tampered", "utf8");
      const result = await withWindowsFtsRuntime(async () => "loaded", windowsOptions(fixture.options));
      assert.equal(isWindowsFtsRuntimeUnavailable(result), true);
      assert.equal(isWindowsFtsRuntimeUnavailable(result) ? result.reason : undefined, "invalid-package");
    } finally {
      fixture.cleanup();
    }
  });

  it("returns native-loader-unavailable when the native addon is missing or lacks preload APIs", async () => {
    const fixture = createRuntimePackage();
    try {
      const result = await withWindowsFtsRuntime(async () => "loaded", windowsOptions({
        ...fixture.options,
        loadNativeAddon: () => null,
      }));
      assert.equal(isWindowsFtsRuntimeUnavailable(result), true);
      assert.equal(isWindowsFtsRuntimeUnavailable(result) ? result.reason : undefined, "native-loader-unavailable");
    } finally {
      fixture.cleanup();
    }
  });

  it("preloads crypto before SSL, forwards LOAD result, and releases in reverse order", async () => {
    const fixture = createRuntimePackage();
    const events: string[] = [];
    try {
      const result = await withWindowsFtsRuntime(async () => {
        events.push("load");
        return "loaded";
      }, windowsOptions({
        ...fixture.options,
        loadNativeAddon: () => ({
          preloadWindowsLibrary: (absolutePath: string) => {
            events.push("preload:" + basename(absolutePath));
            return { token: events.length, loadedPath: absolutePath };
          },
          releaseWindowsLibrary: (token: number) => {
            events.push("release:" + token);
          },
        }),
      }));

      assert.equal(result, "loaded");
      assert.deepEqual(events, [
        "preload:libcrypto-3-x64.dll",
        "preload:libssl-3-x64.dll",
        "load",
        "release:2",
        "release:1",
      ]);
    } finally {
      fixture.cleanup();
    }
  });

  it("accepts native-reported extended-length paths inside the package bin directory", async () => {
    if (process.platform !== "win32") {
      return;
    }

    const fixture = createRuntimePackage();
    try {
      const result = await withWindowsFtsRuntime(async () => "loaded", windowsOptions({
        ...fixture.options,
        loadNativeAddon: () => ({
          preloadWindowsLibrary: (absolutePath: string) => ({
            token: absolutePath.endsWith("libcrypto-3-x64.dll") ? 1 : 2,
            loadedPath: "\\\\?\\" + absolutePath,
          }),
          releaseWindowsLibrary: () => undefined,
        }),
      }));

      assert.equal(result, "loaded");
    } finally {
      fixture.cleanup();
    }
  });

  it("releases acquired handles when LOAD fails", async () => {
    const fixture = createRuntimePackage();
    const events: string[] = [];
    try {
      await assert.rejects(
        () => withWindowsFtsRuntime(async () => {
          events.push("load");
          throw new Error("fts failed");
        }, windowsOptions({
          ...fixture.options,
          loadNativeAddon: () => ({
            preloadWindowsLibrary: (absolutePath: string) => {
              events.push("preload:" + basename(absolutePath));
              return { token: events.length, loadedPath: absolutePath };
            },
            releaseWindowsLibrary: (token: number) => events.push("release:" + token),
          }),
        })),
        /fts failed/u,
      );
      assert.deepEqual(events, [
        "preload:libcrypto-3-x64.dll",
        "preload:libssl-3-x64.dll",
        "load",
        "release:2",
        "release:1",
      ]);
    } finally {
      fixture.cleanup();
    }
  });

  it("releases partial acquisitions and reports preload-failed", async () => {
    const fixture = createRuntimePackage();
    const events: string[] = [];
    try {
      const result = await withWindowsFtsRuntime(async () => "loaded", windowsOptions({
        ...fixture.options,
        loadNativeAddon: () => ({
          preloadWindowsLibrary: (absolutePath: string) => {
            events.push("preload:" + basename(absolutePath));
            if (absolutePath.endsWith("libssl-3-x64.dll")) throw new Error("ssl failed");
            return { token: 7, loadedPath: absolutePath };
          },
          releaseWindowsLibrary: (token: number) => events.push("release:" + token),
        }),
      }));

      assert.equal(isWindowsFtsRuntimeUnavailable(result), true);
      assert.equal(isWindowsFtsRuntimeUnavailable(result) ? result.reason : undefined, "preload-failed");
      assert.deepEqual(events, ["preload:libcrypto-3-x64.dll", "preload:libssl-3-x64.dll", "release:7"]);
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects native-reported paths outside the package bin directory", async () => {
    const fixture = createRuntimePackage();
    try {
      const result = await withWindowsFtsRuntime(async () => "loaded", windowsOptions({
        ...fixture.options,
        loadNativeAddon: () => ({
          preloadWindowsLibrary: (absolutePath: string) => ({
            token: 1,
            loadedPath: absolutePath.endsWith("libcrypto-3-x64.dll")
              ? resolve(fixture.root, "..", "other", "libcrypto-3-x64.dll")
              : absolutePath,
          }),
          releaseWindowsLibrary: () => undefined,
        }),
      }));

      assert.equal(isWindowsFtsRuntimeUnavailable(result), true);
      assert.equal(isWindowsFtsRuntimeUnavailable(result) ? result.reason : undefined, "preload-failed");
    } finally {
      fixture.cleanup();
    }
  });
});
