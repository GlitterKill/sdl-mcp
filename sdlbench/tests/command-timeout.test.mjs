import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommandAsync } from "../src/sdlbench.mjs";

test("timeout settles even when a detached descendant retains output pipes", async () => {
  const root = await mkdtemp(join(tmpdir(), "sdlbench-pipes-"));
  try {
    const file = join(root, "hold.mjs");
    await writeFile(file, `import { spawn } from "node:child_process";
const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 3500)"], { detached: true, cwd: process.env.TEMP ?? "/tmp", stdio: ["ignore", process.stdout, process.stderr] });
child.unref();`);
    const started = performance.now();
    const result = await runCommandAsync(`node "${file}"`, root, 200);
    assert.equal(result.timedOut, true);
    assert.ok(performance.now() - started < 2500, "timeout must not await inherited output pipes");
  } finally { await rm(root, { recursive: true, force: true }); }
});
