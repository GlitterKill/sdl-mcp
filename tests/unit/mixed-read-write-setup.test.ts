import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ensureStressFixtureReady } from "../stress/infra/scenario-setup.ts";

describe("ensureStressFixtureReady", () => {
  it("reuses an already indexed fixture repo", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client = {
      async callToolParsed(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        if (name === "sdl.repo.status") {
          return { symbolsIndexed: 333, filesIndexed: 23 };
        }
        throw new Error(`unexpected call: ${name}`);
      },
    };

    await ensureStressFixtureReady(client, "F:/fixture", () => undefined);

    assert.deepEqual(calls, [
      { name: "sdl.repo.status", args: { repoId: "stress-fixtures" } },
    ]);
  });

  it("registers and fully indexes when the fixture repo is missing", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client = {
      async callToolParsed(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        if (name === "sdl.repo.status") {
          throw new Error("Repository not found");
        }
        return {};
      },
    };

    await ensureStressFixtureReady(client, "F:/fixture", () => undefined);

    assert.deepEqual(calls, [
      { name: "sdl.repo.status", args: { repoId: "stress-fixtures" } },
      {
        name: "sdl.repo.register",
        args: { repoId: "stress-fixtures", rootPath: "F:/fixture" },
      },
      {
        name: "sdl.index.refresh",
        args: { repoId: "stress-fixtures", mode: "full" },
      },
    ]);
  });

  it("fully indexes when the repo exists but has no indexed content", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client = {
      async callToolParsed(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        if (name === "sdl.repo.status") {
          return { symbolsIndexed: 0, filesIndexed: 0 };
        }
        return {};
      },
    };

    await ensureStressFixtureReady(client, "F:/fixture", () => undefined);

    assert.deepEqual(calls, [
      { name: "sdl.repo.status", args: { repoId: "stress-fixtures" } },
      {
        name: "sdl.index.refresh",
        args: { repoId: "stress-fixtures", mode: "full" },
      },
    ]);
  });
});
