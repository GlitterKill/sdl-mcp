import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  closeLadybugDb,
  getLadybugConn,
  initLadybugDb,
  withWriteConn,
} from "../../dist/db/ladybug.js";
import { exec, queryAll } from "../../dist/db/ladybug-core.js";
import * as queries from "../../dist/db/ladybug-queries.js";
import {
  bufferAuditEvent,
  drainAuditBuffer,
  flushAuditBufferOnShutdown,
  getBufferedAuditCount,
} from "../../dist/mcp/audit-buffer.js";
import { withPostIndexWriteSession } from "../../dist/db/write-session.js";

// Real-DB end-to-end coverage for the post-index session end-hook drain.
// Exercises the production wiring: audit-buffer.ts registers a session end
// hook at module load; ladybug.ts wires the writeConnAcquirer at initLadybugDb.
// The test pushes audit rows while a session is active, lets the session end,
// and verifies the rows landed in the LadybugDB Audit node table.

const REPO_ID = "audit-end-hook-drain-test";
const TEST_DIR = mkdtempSync(join(tmpdir(), "sdl-audit-drain-"));
const DB_PATH = join(TEST_DIR, "audit-drain.lbug");
const CONFIG_PATH = join(TEST_DIR, "config.json");

function makeRow(suffix: string) {
  return {
    eventId: `audit-drain-${suffix}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    tool: "test.audit-drain",
    decision: "success",
    repoId: REPO_ID,
    symbolId: null,
    detailsJson: JSON.stringify({ suffix }),
  };
}

async function countAuditRowsForRepo(): Promise<number> {
  const conn = await getLadybugConn();
  const rows = await queryAll<{ n: unknown }>(
    conn,
    `MATCH (a:Audit) WHERE a.repoId = $repoId RETURN count(a) AS n`,
    { repoId: REPO_ID },
  );
  if (rows.length === 0) return 0;
  const raw = rows[0].n;
  return typeof raw === "bigint"
    ? Number(raw)
    : typeof raw === "number"
      ? raw
      : Number(raw ?? 0);
}

async function clearAllAuditRows(): Promise<void> {
  await withWriteConn(async (conn) => {
    await exec(conn, `MATCH (a:Audit) DELETE a`);
  });
}

// Reset both the in-memory audit buffer and the DB Audit table so each test
// case starts from a known-clean state regardless of how the previous case
// exited (success, throw, or partial drain).
async function resetBufferAndDb(): Promise<void> {
  if (getBufferedAuditCount() > 0) {
    await flushAuditBufferOnShutdown(async (body) => {
      await withWriteConn(body);
    });
  }
  await clearAllAuditRows();
}

let ladybugAvailable = true;
const prevConfig = process.env.SDL_CONFIG;
const prevConfigPath = process.env.SDL_CONFIG_PATH;

before(async () => {
  try {
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify(
        {
          repos: [],
          policy: {},
          indexing: { engine: "typescript", enableFileWatching: false },
          liveIndex: { enabled: false },
        },
        null,
        2,
      ),
      "utf8",
    );
    process.env.SDL_CONFIG = CONFIG_PATH;
    delete process.env.SDL_CONFIG_PATH;

    await closeLadybugDb();
    await initLadybugDb(DB_PATH);
    const conn = await getLadybugConn();
    await queries.upsertRepo(conn, {
      repoId: REPO_ID,
      rootPath: TEST_DIR,
      configJson: JSON.stringify({
        repoId: REPO_ID,
        rootPath: TEST_DIR,
        ignore: [],
        languages: [],
        maxFileBytes: 1_000_000,
        includeNodeModulesTypes: false,
      }),
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    ladybugAvailable = false;
    // eslint-disable-next-line no-console
    console.warn(
      `[audit-buffer-end-hook-drain] LadybugDB init failed; skipping suite: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
});

after(async () => {
  try {
    await closeLadybugDb();
  } catch {
    // ignore
  }
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
  if (prevConfig === undefined) delete process.env.SDL_CONFIG;
  else process.env.SDL_CONFIG = prevConfig;
  if (prevConfigPath !== undefined) {
    process.env.SDL_CONFIG_PATH = prevConfigPath;
  }
  delete process.env.SDL_POST_INDEX_SESSION_TIMEOUT_MS;
});

describe("audit-buffer end-hook drain (real DB)", () => {
  it(
    "drains buffered audit rows into LadybugDB at session end",
    { skip: !ladybugAvailable },
    async () => {
      await resetBufferAndDb();
      assert.equal(getBufferedAuditCount(), 0, "buffer starts empty");
      assert.equal(await countAuditRowsForRepo(), 0, "DB starts empty");

      let depthMidSession = -1;
      await withPostIndexWriteSession(async () => {
        // Push audit rows through the buffer surface — same code path the
        // production telemetry.recordAuditEvent uses while a session is active.
        for (let i = 0; i < 5; i += 1) {
          assert.equal(
            bufferAuditEvent(makeRow(`drain-${i}`)),
            true,
            "buffer accepts row",
          );
        }
        depthMidSession = getBufferedAuditCount();
      });

      assert.equal(
        depthMidSession,
        5,
        "5 rows queued in the in-memory buffer mid-session",
      );
      assert.equal(
        getBufferedAuditCount(),
        0,
        "end-hook drained the buffer to empty",
      );
      const persisted = await countAuditRowsForRepo();
      assert.equal(persisted, 5, "all 5 rows landed in LadybugDB");
    },
  );

  it(
    "skips drain on session timeout; rows persist in buffer until next drain",
    { skip: !ladybugAvailable },
    async () => {
      await resetBufferAndDb();
      assert.equal(getBufferedAuditCount(), 0);

      process.env.SDL_POST_INDEX_SESSION_TIMEOUT_MS = "60";
      try {
        await assert.rejects(
          withPostIndexWriteSession(async () => {
            for (let i = 0; i < 3; i += 1) {
              bufferAuditEvent(makeRow(`timeout-${i}`));
            }
            await new Promise((r) => setTimeout(r, 200));
          }),
          /timed out/,
        );
      } finally {
        delete process.env.SDL_POST_INDEX_SESSION_TIMEOUT_MS;
      }

      assert.equal(
        getBufferedAuditCount(),
        3,
        "buffered rows remain because end-hook is skipped on timeout",
      );
      assert.equal(
        await countAuditRowsForRepo(),
        0,
        "no rows persisted to DB (drain was skipped)",
      );

      // Manually drain via withWriteConn to confirm the buffered rows are
      // still well-formed and would land on a subsequent session/shutdown.
      let drained = 0;
      await withWriteConn(async (conn) => {
        drained = await drainAuditBuffer(conn);
      });
      assert.equal(drained, 3, "manual drain processes the stranded rows");
      assert.equal(getBufferedAuditCount(), 0);
      assert.equal(await countAuditRowsForRepo(), 3);
    },
  );

  it(
    "shutdown flush persists remaining buffered rows",
    { skip: !ladybugAvailable },
    async () => {
      await resetBufferAndDb();
      bufferAuditEvent(makeRow("shutdown-0"));
      bufferAuditEvent(makeRow("shutdown-1"));
      assert.equal(getBufferedAuditCount(), 2);

      await flushAuditBufferOnShutdown(async (body) => {
        await withWriteConn(body);
      });

      assert.equal(getBufferedAuditCount(), 0);
      assert.equal(await countAuditRowsForRepo(), 2);
    },
  );
});
