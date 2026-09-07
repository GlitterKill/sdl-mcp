import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";

it("CI polls readiness and still rejects process exit and deadline expiry", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  const block = workflow.match(/          # (?:Give the server|Wait at most)[\s\S]*?          echo "Smoke test passed"/)?.[0];
  assert.ok(block, "expected the Linux stdio readiness check");
  const bash = process.platform === "win32"
    ? join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe")
    : "bash";
  for (const [readyAt, exitAt, status, ticks] of [
    [11, 200, 0, 11],
    [11, 3, 1, 3],
    [200, 200, 1, 150],
  ]) {
    // Model each poll deterministically; execute the actual workflow branches.
    const result = spawnSync(bash, ["--noprofile", "--norc", "-c", `
      set -e
      ticks=0
      SERVER_PID=123
      sleep() { ticks=$((ticks + 1)); }
      kill() { ((ticks < ${exitAt})); }
      grep() { ((ticks >= ${readyAt})); }
      cat() { :; }
      wait() { :; }
      rm() { :; }
      trap 'echo polls=$ticks' EXIT
      ${block}
    `], { encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, status, result.stdout + result.stderr);
    assert.match(result.stdout, new RegExp(`polls=${ticks}\\b`));
  }
});
