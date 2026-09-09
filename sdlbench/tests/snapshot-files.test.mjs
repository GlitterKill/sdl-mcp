import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { snapshotFiles } from "../src/sdlbench.mjs";

test("source snapshots honor Git ignores, including locked Gradle caches", async () => {
  const root = await mkdtemp(join(tmpdir(), "sdlbench-snapshot-"));
  let locker;
  try {
    execFileSync("git", ["init", "-q", root]);
    await writeFile(join(root, ".gitignore"), ".gradle/\n*.ignored\n");
    await writeFile(join(root, "tracked.ignored"), "tracked despite ignore");
    execFileSync("git", ["-C", root, "add", "-f", ".gitignore", "tracked.ignored"]);
    await writeFile(join(root, "new source.txt"), "new source");
    await mkdir(join(root, ".gradle"));
    const locked = join(root, ".gradle", "cache.lock");
    await writeFile(locked, "cache");
    if (process.platform === "win32") {
      // Match Gradle's exclusive Windows file lock while taking the snapshot.
      locker = spawn("powershell.exe", ["-NoProfile", "-Command",
        "$f=[IO.File]::Open($env:SDL_TEST_LOCK,'Open','ReadWrite','None'); [Console]::WriteLine('READY'); Start-Sleep -Seconds 30; $f.Dispose()"],
        { env: { ...process.env, SDL_TEST_LOCK: locked }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      await new Promise((resolve, reject) => {
        locker.stdout.once("data", data => data.toString().includes("READY") ? resolve() : reject(new Error(data.toString())));
        locker.stderr.on("data", data => reject(new Error(data.toString())));
        locker.once("error", reject);
        locker.once("exit", code => reject(new Error("Lock process exited: " + code)));
      });
    }
    const before = await snapshotFiles(root);
    assert.deepEqual([...before.keys()].sort(), [".gitignore", "new source.txt", "tracked.ignored"]);
    await writeFile(join(root, "new source.txt"), "edited");
    await rm(join(root, "tracked.ignored"));
    const after = await snapshotFiles(root);
    assert.notEqual(before.get("new source.txt"), after.get("new source.txt"));
    assert.equal(after.has("tracked.ignored"), false);
    if (process.platform === "win32") {
      await writeFile(join(root, ".gitignore"), "*.ignored\n");
      await assert.rejects(snapshotFiles(root), error => error.code === "EBUSY" && error.message.includes(".gradle/cache.lock"));
    }
  } finally {
    if (locker && locker.exitCode === null) {
      const exited = new Promise(resolve => locker.once("exit", resolve));
      locker.kill();
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("source snapshots retain non-Git fixture support", async () => {
  const root = await mkdtemp(join(tmpdir(), "sdlbench-snapshot-fixture-"));
  try {
    await writeFile(join(root, "source.txt"), "source");
    assert.deepEqual([...await snapshotFiles(root)].map(([file]) => file), ["source.txt"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
