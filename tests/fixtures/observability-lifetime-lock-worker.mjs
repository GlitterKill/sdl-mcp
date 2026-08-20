import { createInterface } from "node:readline";
import { link, lstat, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

import {
  acquireLifetimeLease,
  releaseLifetimeLease,
} from "../../dist/observability/lifetime-lock.js";
import { rotateLifetimeEvidence } from "../../dist/observability/lifetime-evidence.js";

const directory = process.argv[2];
if (!directory) throw new Error("trusted directory argument is required");
const operation = process.argv[3] ?? "lease";

if (operation === "exit-zero") process.exit(0);

if (operation === "create-before-fixed") {
  await acquireLifetimeLease(directory, {
    fileSystem: {
      link: async (source, target) => {
        if (target.endsWith("sdl-observability-lifetime.claim")) {
          process.stdout.write(`${JSON.stringify({ event: "create-held", phase: "before-fixed" })}\n`);
          await new Promise(() => setInterval(() => undefined, 1_000));
        }
        return link(source, target);
      },
    },
  });
  throw new Error("create hold unexpectedly completed");
}

if (operation === "release-after-fixed-removal" || operation === "release-after-lock-move") {
  const leaseResult = await acquireLifetimeLease(directory);
  if (leaseResult.mode !== "writer") throw new Error("release hold requires writer lease");
  await releaseLifetimeLease(leaseResult.lease, {
    fileSystem: {
      unlink: async (path) => {
        if (operation === "release-after-lock-move" && path.includes(".release.")) {
          process.stdout.write(`${JSON.stringify({ event: "release-held", phase: "after-lock-move" })}\n`);
          await new Promise(() => setInterval(() => undefined, 1_000));
        }
        if (path.includes(".claim-cleanup.")) {
          process.stdout.write(`${JSON.stringify({ event: "release-held", phase: "after-fixed-removal" })}\n`);
          await new Promise(() => setInterval(() => undefined, 1_000));
        }
        return unlink(path);
      },
    },
  });
  throw new Error("release hold unexpectedly completed");
}

if (operation === "claim-before-move" || operation === "claim-after-move") {
  const sourcePath = process.argv[4];
  if (!sourcePath) throw new Error("claim source argument is required");
  await rotateLifetimeEvidence(
    directory,
    sourcePath,
    { kind: "lock", eligibility: "validated-supported" },
    {
      fileSystem: {
        rename: async (source, target) => {
          if (source !== sourcePath) return rename(source, target);
          if (operation === "claim-before-move") {
            process.stdout.write(`${JSON.stringify({ event: "claim-held", phase: "before-move" })}\n`);
            await new Promise(() => setInterval(() => undefined, 1_000));
          }
          await rename(source, target);
          process.stdout.write(`${JSON.stringify({ event: "claim-held", phase: "after-move" })}\n`);
          await new Promise(() => setInterval(() => undefined, 1_000));
        },
      },
    },
  );
  throw new Error("claim hold unexpectedly completed");
}

const result = await acquireLifetimeLease(directory);
process.stdout.write(`${JSON.stringify({ event: "acquired", mode: result.mode })}\n`);

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

const lines = createInterface({ input: process.stdin });
for await (const command of lines) {
  if (command === "state") {
    process.stdout.write(`${JSON.stringify({
      event: "state",
      mode: result.mode,
      lockExists: await exists(join(directory, "sdl-observability-lifetime.lock.json")),
      claimExists: await exists(join(directory, "sdl-observability-lifetime.claim")),
    })}\n`);
    continue;
  }
  if (command === "release") {
    const released = result.mode === "writer"
      ? await releaseLifetimeLease(result.lease)
      : false;
    process.stdout.write(`${JSON.stringify({ event: "released", released })}\n`);
    break;
  }
  if (command === "exit") break;
}

lines.close();
