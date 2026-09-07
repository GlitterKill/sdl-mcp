import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rename,
  unlink,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { it } from "node:test";
import {
  initLadybugDb,
  closeLadybugDb,
  withWriteConn,
} from "../../dist/db/ladybug.js";
import * as db from "../../dist/db/ladybug-queries.js";
import { RepoConfigSchema } from "../../dist/config/types.js";
import {
  watchRepositoryWithIndexer,
  getWatcherHealth,
} from "../../dist/indexer/watcher.js";
import type { LiveIndexCoordinator } from "../../dist/live-index/types.js";

it(
  "real fsWatch and chokidar retain saves before readiness, plus startup/config/rename/directory recovery",
  { timeout: 30_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "sdl-watcher-reconciliation-"));
    const previousConfig = process.env.SDL_CONFIG;
    let active:
      | Awaited<ReturnType<typeof watchRepositoryWithIndexer>>
      | undefined;
    try {
      await initLadybugDb(join(root, "graph.lbug"));
      for (const provider of ["fsWatch", "chokidar"] as const) {
        const repoRoot = join(root, provider);
        await mkdir(join(repoRoot, "src"), { recursive: true });
        const file = join(repoRoot, "src", "index.ts");
        await writeFile(file, "export const value = 11;\n");
        const config = RepoConfigSchema.parse({
          repoId: provider,
          // Exercise Windows 8.3 aliases, including aliases in parent directories.
          rootPath: process.platform === "win32"
            ? execFileSync("cmd.exe", ["/d", "/c", "for %I in (.) do @echo %~fsI"], {
                cwd: repoRoot,
                encoding: "utf8",
              }).trim()
            : repoRoot,
          languages: ["ts"],
        });
        process.env.SDL_CONFIG = join(root, `${provider}.json`);
        await writeFile(
          process.env.SDL_CONFIG,
          JSON.stringify({
            repos: [config],
            policy: {},
            indexing: { watchProvider: provider, watchDebounceMs: 5000 },
          }),
        );
        await withWriteConn((conn) =>
          db.upsertRepo(conn, {
            repoId: provider,
            rootPath: config.rootPath,
            configJson: JSON.stringify(config),
          }),
        );
        const events: Array<{
          filePath?: string;
          removed?: boolean;
          inventory?: boolean;
          force?: boolean;
          invalidated?: boolean;
        }> = [];
        let signal: (() => void) | undefined;
        let readiness: (() => boolean) | undefined;
        function record(event: (typeof events)[number]) {
          events.push(event);
          signal?.();
          return true;
        }
        const coordinator = {
          recordDiskChange(input: { filePath: string; removed?: boolean }) {
            return record(input);
          },
          requestReconcileInventory(
            _repoId: string,
            options?: { force?: boolean },
          ) {
            return record({ inventory: true, ...options });
          },
          invalidateSourceContext() {
            record({ invalidated: true });
          },
          setReconciliationReadiness(
            _repoId: string,
            predicate: () => boolean,
          ) {
            readiness = predicate;
          },
        } as LiveIndexCoordinator;
        let phase = 0;
        async function observe(
          predicate: () => boolean,
          operation: () => Promise<unknown>,
        ) {
          phase++;
          const observed = new Promise<void>((done) => {
            signal = () => {
              if (predicate()) done();
            };
          });
          await operation();
          signal?.();
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              observed,
              new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () =>
                    reject(
                      new Error(
                        `${provider} phase ${phase} missing event: ${JSON.stringify(events)}`,
                      ),
                    ),
                  3000,
                );
              }),
            ]);
          } finally {
            clearTimeout(timer);
            signal = undefined;
          }
        }
        active = await watchRepositoryWithIndexer(
          provider,
          async () => assert.fail("automatic index"),
          () => false,
          { coordinator },
        );
        await active.ready;
        assert.equal(readiness?.(), false);
        assert.ok(events.some((event) => event.inventory));
        for (const save of [12, 13]) {
          const before = events.length;
          await observe(
            () =>
              events
                .slice(before)
                .some((event) => event.filePath === "src/index.ts"),
            () => writeFile(file, `export const value = ${save};\n`),
          );
        }
        let before = events.length;
        await observe(
          () => events.slice(before).some((event) => event.force),
          () => writeFile(join(repoRoot, "package.json"), "{}"),
        );
        assert.ok(
          events.slice(before).findIndex((event) => event.invalidated) <
            events.slice(before).findIndex((event) => event.force),
        );
        before = events.length;
        await observe(
          () => events.slice(before).some((event) => event.inventory),
          () => mkdir(join(repoRoot, "new-directory")),
        );
        before = events.length;
        const renamed = join(repoRoot, "src", "renamed.ts");
        await observe(
          () =>
            events
              .slice(before)
              .some((event) => event.filePath === "src/renamed.ts"),
          () => rename(file, renamed),
        );
        before = events.length;
        await observe(
          () =>
            events
              .slice(before)
              .some((event) =>
                provider === "fsWatch"
                  ? event.inventory
                  : event.filePath === "src/renamed.ts" && event.removed,
              ),
          () => unlink(renamed),
        );
        assert.equal(getWatcherHealth(provider)?.lastSuccessfulReindexAt, null);
        assert.equal(getWatcherHealth(provider)?.stale, false);
        assert.ok((getWatcherHealth(provider)?.eventsProcessed ?? 0) > 0);
        const accepted = events.length;
        await active.close();
        active = undefined;
        assert.equal(
          events.length,
          accepted,
          "close must not erase or mutate shared admission",
        );
      }
    } finally {
      await active?.close();
      await closeLadybugDb({ strict: true });
      if (previousConfig === undefined) delete process.env.SDL_CONFIG;
      else process.env.SDL_CONFIG = previousConfig;
      assert.equal(dirname(resolve(root)), resolve(tmpdir()));
      assert.ok(basename(root).startsWith("sdl-watcher-reconciliation-"));
      await rm(root, { recursive: true, force: true });
    }
  },
);
