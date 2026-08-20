import { createInterface } from "node:readline";

import {
  acquireLifetimeLease,
  releaseLifetimeLease,
} from "../../dist/observability/lifetime-lock.js";

const directory = process.argv[2];
if (!directory) throw new Error("trusted directory argument is required");

const result = await acquireLifetimeLease(directory);
process.stdout.write(`${JSON.stringify({ event: "acquired", mode: result.mode })}\n`);

const lines = createInterface({ input: process.stdin });
for await (const command of lines) {
  if (command === "state") {
    process.stdout.write(`${JSON.stringify({ event: "state", mode: result.mode })}\n`);
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
