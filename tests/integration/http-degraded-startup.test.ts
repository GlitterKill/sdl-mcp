import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

async function stopChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32" && child.pid !== undefined) {
    spawnSync(
      "taskkill.exe",
      ["/PID", String(child.pid), "/T", "/F"],
      { stdio: "ignore" },
    );
  } else {
    child.kill("SIGKILL");
  }
  for (
    let attempt = 0;
    attempt < 100 && child.exitCode === null && child.signalCode === null;
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(
    child.exitCode !== null || child.signalCode !== null,
    "serve child did not exit",
  );
}

describe("HTTP degraded startup", () => {
  it(
    "keeps a real serve process diagnostic-only after one failed storage preflight",
    { timeout: 30_000 },
    async () => {
      const kuzu = await import("kuzu");
      const root = await mkdtemp(join(tmpdir(), "sdl-degraded-startup-"));
      const dbPath = join(root, "incompatible-schema.lbug");
      const fixtureRoot = join(root, "fixture");
      const configPath = join(root, "config.json");
      let child: ReturnType<typeof spawn> | undefined;
      let output = "";

      try {
        await mkdir(fixtureRoot);
        await writeFile(
          join(fixtureRoot, "example.ts"),
          "export const example = true;\n",
        );

        const db = new kuzu.Database(dbPath);
        const conn = new kuzu.Connection(db);
        const createResult = await conn.query(
          "CREATE NODE TABLE Symbol(wrongId STRING PRIMARY KEY)",
        );
        (Array.isArray(createResult) ? createResult[0] : createResult).close();
        await conn.close();
        await db.close();

        // This unowned, incompatible database must fail the child's storage
        // preflight; validating it here would reject it before HTTP can start.

        await writeFile(
          configPath,
          JSON.stringify({
            repos: [
              {
                repoId: "fixture",
                rootPath: fixtureRoot,
                languages: ["ts"],
              },
            ],
            graphDatabase: { path: dbPath },
            indexing: { enableFileWatching: true },
            httpAuth: { enabled: false },
            policy: {},
          }),
        );

        const portProbe = createServer();
        await new Promise<void>((resolve, reject) => {
          portProbe.once("error", reject);
          portProbe.listen(0, "127.0.0.1", resolve);
        });
        const address = portProbe.address();
        assert.ok(address && typeof address === "object");
        const port = address.port;
        await new Promise<void>((resolve, reject) => {
          portProbe.close((error) => (error ? reject(error) : resolve()));
        });

        const childEnv = { ...process.env };
        childEnv.SDL_GRAPH_DB_PATH = dbPath;
        childEnv.SDL_LOG_LEVEL = "error";
        childEnv.SDL_MCP_DISABLE_NATIVE_ADDON = "1";
        delete childEnv.SDL_GRAPH_DB_DIR;
        delete childEnv.SDL_DB_PATH;

        child = spawn(
          process.execPath,
          [
            "dist/cli/index.js",
            "--config",
            configPath,
            "serve",
            "--http",
            "--host",
            "127.0.0.1",
            "--port",
            String(port),
          ],
          {
            cwd: process.cwd(),
            env: childEnv,
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => {
          output += chunk;
        });
        child.stderr?.on("data", (chunk: string) => {
          output += chunk;
        });

        const healthUrl = `http://127.0.0.1:${port}/health`;
        let health: Response | undefined;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (child.exitCode !== null) {
            throw new Error(`serve exited before HTTP readiness:\n${output}`);
          }
          try {
            health = await fetch(healthUrl);
            break;
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        }
        assert.ok(health, `serve did not bind HTTP:\n${output}`);
        await new Promise((resolve) => setTimeout(resolve, 50));

        const healthBody = (await health.json()) as {
          readiness?: {
            state?: string;
            reason?: string;
            watchers?: { expected?: number; ready?: number };
          };
        };
        const sessions = await fetch(
          `http://127.0.0.1:${port}/api/sessions`,
          { signal: AbortSignal.timeout(10_000) },
        );
        await sessions.arrayBuffer();
        const mutation = await fetch(
          `http://127.0.0.1:${port}/api/repo/fixture/reindex`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
            signal: AbortSignal.timeout(10_000),
          },
        );
        const mutationBody = (await mutation.json()) as {
          error?: { code?: string };
        };

        assert.equal(health.status, 503);
        assert.deepEqual(healthBody.readiness, {
          state: "degraded",
          reason: "storage_preflight_failed",
          watchers: { expected: 1, ready: 0 },
        });
        assert.equal(sessions.status, 200);
        assert.equal(mutation.status, 503);
        assert.equal(
          mutationBody.error?.code,
          "STORAGE_NOT_WRITE_READY",
        );
        assert.equal(output.match(/Storage preflight failed:/g)?.length, 1);
        assert.equal(
          output.match(/DEGRADED — watchers not ready/g)?.length,
          1,
        );
        assert.ok(
          output.indexOf("Storage preflight failed:") <
            output.indexOf(
              "Skipping repository bootstrap and derived-state recovery",
            ),
        );
        assert.ok(
          output.indexOf(
            "Skipping repository bootstrap and derived-state recovery",
          ) < output.indexOf("HTTP server listening"),
        );
        assert.equal(child.exitCode, null);

      } finally {
        if (child) await stopChild(child);
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
