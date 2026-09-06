import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";

for (const mode of ["ordinary", "fts"]) {
  it(
    `reconciliation native ${mode} reads finish during an uncommitted write`,
    {
      timeout: 45_000,
      skip:
        mode === "fts" &&
        process.platform === "win32" &&
        process.env.SDL_MCP_DISABLE_NATIVE_ADDON === "1"
          ? "Windows FTS preload disabled by SDL_MCP_DISABLE_NATIVE_ADDON=1"
          : false,
    },
    (t) => {
      const root = mkdtempSync(join(tmpdir(), "sdl-reconcile-read-"));
      try {
        const child = spawnSync(
          process.execPath,
          [
            fileURLToPath(
              new URL(
                "../fixtures/ladybug/reconcile-read-concurrency-child.mjs",
                import.meta.url,
              ),
            ),
            mode,
            root,
          ],
          { encoding: "utf8", timeout: 35_000, windowsHide: true },
        );
        assert.equal(child.error, undefined, child.error?.message);
        assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
        assert.match(child.stdout, /"readsBeforeCommit":true/);
        assert.match(child.stdout, /"exclusiveAdmissionRetained":true/);
        t.diagnostic(child.stdout.trim().split(/\r?\n/).at(-1)!);
      } finally {
        assert.equal(dirname(resolve(root)), resolve(tmpdir()));
        assert.ok(basename(root).startsWith("sdl-reconcile-read-"));
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
}
