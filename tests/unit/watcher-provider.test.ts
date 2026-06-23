import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  _buildWatchmanSubscriptionForTesting,
  _buildWatchmanStartupResyncForTesting,
  _decrementPendingChangeForGenerationForTesting,
  _drainPendingWatcherChangesForTesting,
  _normalizeWatchmanFileNameForTesting,
  _probeWatchmanClientAvailabilityForTesting,
  _rotateAbortControllerForTesting,
  _selectWatcherProviderForTesting,
  _watchmanAvailabilityForTesting,
  _watchmanCommandWithTimeoutForTesting,
  _watchmanResponseHasResyncSignalForTesting,
} from "../../dist/indexer/watcher.js";

type WatchmanSmokeClient = {
  capabilityCheck(
    capabilities: { required: string[]; optional?: string[] },
    callback: (error: Error | null, response: { version?: string }) => void,
  ): void;
  command<T>(
    args: readonly unknown[],
    callback: (error: Error | null, response: T) => void,
  ): void;
  end(): void;
};

class FailingProbeWatchmanClient extends EventEmitter {
  ended = false;

  capabilityCheck(): void {
    queueMicrotask(() => {
      this.emit("error", new Error("watchman binary failed to load libglog"));
    });
  }

  command(): void {}

  end(): void {
    this.ended = true;
  }
}

function watchmanSmokeCommand<T>(
  client: WatchmanSmokeClient,
  args: readonly unknown[],
): Promise<T> {
  return new Promise((resolve, reject) => {
    client.command<T>(args, (error, response) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(response);
    });
  });
}

describe("watcher provider selection", () => {
  it("auto chooses watchman when it is available", () => {
    const selected = _selectWatcherProviderForTesting("auto", {
      watchman: { available: true },
      chokidar: { available: true },
      fsWatch: { available: true },
    });

    assert.equal(selected.provider, "watchman");
    assert.equal(selected.fallbackReason, null);
  });

  it("auto falls back to chokidar and reports the skipped providers", () => {
    const selected = _selectWatcherProviderForTesting("auto", {
      watchman: { available: false, reason: "watchman command not found" },
      chokidar: { available: true },
      fsWatch: { available: true },
    });

    assert.equal(selected.provider, "chokidar");
    assert.match(selected.fallbackReason ?? "", /watchman command not found/);
  });

  it("auto falls through to fs.watch when both optional providers are unavailable", () => {
    const selected = _selectWatcherProviderForTesting("auto", {
      watchman: { available: false, reason: "watchman unavailable" },
      chokidar: { available: false, reason: "chokidar unavailable" },
      fsWatch: { available: true },
    });

    assert.equal(selected.provider, "fsWatch");
    assert.match(selected.fallbackReason ?? "", /watchman unavailable/);
    assert.match(selected.fallbackReason ?? "", /chokidar unavailable/);
  });

  it("explicit watchman fails visibly when unavailable", () => {
    assert.throws(
      () =>
        _selectWatcherProviderForTesting("watchman", {
          watchman: { available: false, reason: "watchman service not running" },
          chokidar: { available: true },
          fsWatch: { available: true },
        }),
      /watchman service not running/,
    );
  });

  it("shares concurrent Watchman auto startup probes", async () => {
    let probeCount = 0;
    let releaseProbe!: () => void;
    _watchmanAvailabilityForTesting.resetCache();

    const probe = async () => {
      probeCount++;
      await new Promise<void>((resolve) => {
        releaseProbe = resolve;
      });
      return { available: true };
    };

    const first = _watchmanAvailabilityForTesting.check("auto", probe);
    const second = _watchmanAvailabilityForTesting.check("auto", probe);

    assert.equal(probeCount, 1);
    releaseProbe();
    assert.deepEqual(await first, { available: true });
    assert.deepEqual(await second, { available: true });

    _watchmanAvailabilityForTesting.resetCache();
  });

  it("reuses Watchman auto fallback after the first failed probe", async () => {
    let probeCount = 0;
    _watchmanAvailabilityForTesting.resetCache();

    const first = await _watchmanAvailabilityForTesting.check("auto", async () => {
      probeCount++;
      return { available: false, reason: "Watchman was not found in PATH" };
    });
    const second = await _watchmanAvailabilityForTesting.check("auto", async () => {
      probeCount++;
      return { available: true };
    });

    assert.equal(probeCount, 1);
    assert.deepEqual(first, {
      available: false,
      reason: "Watchman was not found in PATH",
    });
    assert.deepEqual(second, first);

    _watchmanAvailabilityForTesting.resetCache();
  });
});

describe("watchman provider helpers", () => {
  it("builds a suffix-filtered subscription from SDL source extensions", () => {
    const subscription = _buildWatchmanSubscriptionForTesting({
      clock: "c:1700000000:1:1",
      relativePath: "packages/app",
      extensions: [".ts", ".tsx", ".go"],
    });

    assert.equal(subscription.since, "c:1700000000:1:1");
    assert.equal(subscription.relative_root, "packages/app");
    assert.deepEqual(subscription.fields, [
      "name",
      "exists",
      "type",
      "mtime_ms",
      "size",
    ]);
    assert.deepEqual(subscription.expression, [
      "anyof",
      ["suffix", "ts"],
      ["suffix", "tsx"],
      ["suffix", "go"],
    ]);
  });

  it("normalizes watchman names to repo-relative paths inside the subscribed root", () => {
    assert.equal(
      _normalizeWatchmanFileNameForTesting("packages/app/src/index.ts", {
        watchRoot: "C:/repo",
        relativePath: "packages/app",
      }),
      "src/index.ts",
    );
    assert.equal(
      _normalizeWatchmanFileNameForTesting("src\\index.ts", {
        watchRoot: "C:/repo",
        relativePath: "packages/app",
      }),
      "src/index.ts",
    );
  });

  it("detects fresh-instance and recrawl signals as resync boundaries", () => {
    assert.equal(
      _watchmanResponseHasResyncSignalForTesting({ is_fresh_instance: true }),
      true,
    );
    assert.equal(
      _watchmanResponseHasResyncSignalForTesting({
        warning: "Recrawled this watch because the root was changed too often",
      }),
      true,
    );
    assert.equal(
      _watchmanResponseHasResyncSignalForTesting({ warning: "minor warning" }),
      false,
    );
  });

  it("treats watch-project recrawl warnings as startup resync boundaries", () => {
    assert.deepEqual(
      _buildWatchmanStartupResyncForTesting(
        "Recrawled this watch because the root was changed too often",
      ),
      {
        type: "resync",
        reason: "watchman watch-project recrawl warning",
        warning: "Recrawled this watch because the root was changed too often",
      },
    );
    assert.equal(_buildWatchmanStartupResyncForTesting("minor warning"), null);
  });

  it("bounds Watchman command waits so auto can fall back", async () => {
    const neverResponds = {
      command<T>(
        _args: readonly unknown[],
        _callback: (error: Error | null, response: T) => void,
      ): void {
        // Intentionally do not call the callback.
      },
      capabilityCheck(): void {},
      on(): typeof neverResponds {
        return neverResponds;
      },
      end(): void {},
    };

    await assert.rejects(
      _watchmanCommandWithTimeoutForTesting(neverResponds, ["clock", "root"], 5),
      /timed out after 5ms/,
    );
  });

  it("turns Watchman startup error events into availability failures", async () => {
    const client = new FailingProbeWatchmanClient();

    const availability = await _probeWatchmanClientAvailabilityForTesting(
      () => client,
    );

    assert.equal(availability.available, false);
    assert.match(availability.reason ?? "", /failed to load libglog/);
    assert.equal(client.ended, true);
  });

  it("drains queued precise watcher work before a resync refresh", async () => {
    const fired: string[] = [];
    const timer = setTimeout(() => {
      fired.push("precise");
    }, 10);
    const pending = new Map<string, { timer: NodeJS.Timeout }>([
      ["src/index.ts", { timer }],
    ]);
    const health = { pendingChanges: 1, queueDepth: 1 };

    _drainPendingWatcherChangesForTesting(pending, health);

    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(fired, []);
    assert.equal(pending.size, 0);
    assert.equal(health.pendingChanges, 0);
    assert.equal(health.queueDepth, 0);
  });

  it("ignores stale-generation precise completions after resync", () => {
    const health = { pendingChanges: 1 };

    assert.equal(
      _decrementPendingChangeForGenerationForTesting(health, 2, 1),
      false,
    );
    assert.equal(health.pendingChanges, 1);

    assert.equal(
      _decrementPendingChangeForGenerationForTesting(health, 2, 2),
      true,
    );
    assert.equal(health.pendingChanges, 0);
  });

  it("rotates abort controllers when watcher generations advance", () => {
    const original = new AbortController();

    const next = _rotateAbortControllerForTesting(original);

    assert.equal(original.signal.aborted, true);
    assert.equal(next.signal.aborted, false);
    assert.notEqual(next, original);
  });

  it(
    "smoke tests real Watchman when SDL_TEST_WATCHMAN=1",
    { skip: process.env.SDL_TEST_WATCHMAN !== "1" },
    async (t) => {
      let watchmanModule: unknown;
      try {
        watchmanModule = await import("fb-watchman");
      } catch {
        t.skip("fb-watchman package is unavailable");
        return;
      }
      const moduleRecord = watchmanModule as {
        Client?: new () => WatchmanSmokeClient;
        default?: { Client?: new () => WatchmanSmokeClient };
      };
      const Client = moduleRecord.Client ?? moduleRecord.default?.Client;
      if (!Client) {
        t.skip("fb-watchman Client export is unavailable");
        return;
      }

      const repoRoot = mkdtempSync(join(tmpdir(), "sdl-watchman-"));
      writeFileSync(join(repoRoot, "index.ts"), "export const value = 1;\n");
      const client = new Client();
      try {
        await new Promise<void>((resolve, reject) => {
          client.capabilityCheck(
            { required: ["relative_root"], optional: [] },
            (error) => {
              if (error) {
                reject(error);
                return;
              }
              resolve();
            },
          );
        });
        const watchProject = await watchmanSmokeCommand<{
          watch: string;
          relative_path?: string;
        }>(client, ["watch-project", repoRoot]);
        assert.equal(typeof watchProject.watch, "string");
        const clock = await watchmanSmokeCommand<{ clock: string }>(client, [
          "clock",
          watchProject.watch,
        ]);
        assert.equal(typeof clock.clock, "string");
      } catch (error) {
        t.skip(
          `Watchman executable/service unavailable: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      } finally {
        client.end();
        rmSync(repoRoot, { recursive: true, force: true });
      }
    },
  );
});
