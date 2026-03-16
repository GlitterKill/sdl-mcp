import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let initLadybugDb: (dbPath: string) => Promise<void>;
let closeLadybugDb: () => Promise<void>;
let ladybugAvailable = false;

await import("../../dist/db/ladybug.js")
  .then((kuzu) => {
    initLadybugDb = kuzu.initLadybugDb;
    closeLadybugDb = kuzu.closeLadybugDb;
    ladybugAvailable = true;
  })
  .catch(() => {
    initLadybugDb = async () => {
      throw new Error("Module not built");
    };
    closeLadybugDb = async () => {};
  });

function containsAny(text: string, words: string[]): boolean {
  return words.some((word) => text.includes(word));
}

describe("Ladybug reindex guidance", { skip: !ladybugAvailable }, () => {
  const testRoot = join(
    tmpdir(),
    `sdl-mcp-ladybug-guidance-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );

  afterEach(async () => {
    await closeLadybugDb();
    if (existsSync(testRoot)) {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it("adds actionable delete/reindex guidance for incompatible graph data", async () => {
    mkdirSync(testRoot, { recursive: true });
    const fakeDbPath = join(testRoot, "fake-old-db.lbug");

    // Force open/init failure by placing a non-database file at the DB path.
    writeFileSync(fakeDbPath, "not-a-valid-ladybug-database", "utf8");

    await assert.rejects(
      async () => {
        await initLadybugDb(fakeDbPath);
      },
      (error: unknown) => {
        const message =
          error instanceof Error
            ? error.message.toLowerCase()
            : String(error).toLowerCase();

        assert.ok(
          message.includes("database at '") &&
            message.includes("fake-old-db.lbug"),
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

        return true;
      },
    );
  });
});
