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

  it("preserves incompatible graph data and recommends a safe rebuild", async () => {
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
          message.includes("initialization failed") || message.includes("database could not be opened"),
          "error should include initialization failure description",
        );
        assert.ok(
          message.includes("preserve"),
          "error should tell operators to preserve the existing database",
        );
        assert.ok(
          message.includes("safe-rebuild"),
          "error should recommend building and validating a fresh candidate",
        );
        assert.ok(
          !message.includes("delete the database") &&
            !message.includes("remove the database"),
          "error should not recommend destructive in-place recovery",
        );

        return true;
      },
    );
  });
});
