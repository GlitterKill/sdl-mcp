import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let initKuzuDb: (dbPath: string) => Promise<void>;
let closeKuzuDb: () => Promise<void>;
let kuzuAvailable = false;

await import("../../dist/db/kuzu.js")
  .then((kuzu) => {
    initKuzuDb = kuzu.initKuzuDb;
    closeKuzuDb = kuzu.closeKuzuDb;
    kuzuAvailable = true;
  })
  .catch(() => {
    initKuzuDb = async () => {
      throw new Error("Module not built");
    };
    closeKuzuDb = async () => {};
  });

function containsAny(text: string, words: string[]): boolean {
  return words.some((word) => text.includes(word));
}

describe("Ladybug reindex guidance", { skip: !kuzuAvailable }, () => {
  const testRoot = join(
    tmpdir(),
    `sdl-mcp-ladybug-guidance-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );

  afterEach(async () => {
    await closeKuzuDb();
    if (existsSync(testRoot)) {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it("adds actionable delete/reindex guidance for incompatible graph data", async () => {
    mkdirSync(testRoot, { recursive: true });
    const fakeDbPath = join(testRoot, "fake-old-db.kuzu");

    // Force open/init failure by placing a non-database file at the DB path.
    writeFileSync(fakeDbPath, "not-a-valid-ladybug-database", "utf8");

    await assert.rejects(
      async () => {
        await initKuzuDb(fakeDbPath);
      },
      (error: unknown) => {
        const message =
          error instanceof Error
            ? error.message.toLowerCase()
            : String(error).toLowerCase();

        assert.ok(
          message.includes("database at '") &&
            message.includes("fake-old-db.kuzu"),
          "error should include the database path context",
        );
        assert.ok(
          containsAny(message, ["delete", "remove"]),
          "error should include delete/remove guidance",
        );

        assert.ok(
          containsAny(message, ["delete", "remove"]),
          "error should include delete/remove guidance",
        );

        assert.ok(
          containsAny(message, ["delete", "remove"]),
          "error should include delete/remove guidance",
        );
        assert.ok(
          containsAny(message, ["reindex", "rebuild", "re-run"]),
          "error should include reindex/rebuild/re-run guidance",
        );
        assert.ok(
          message.includes(
            "migrating older graph databases in-place is not supported",
          ),
          "error should state that migration is not supported",
        );

        return true;
      },
    );
  });
});
