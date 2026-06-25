import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const report = readFileSync("review-report.md", "utf8").toLowerCase();

for (const term of ["payment token", "date.now", "inventory", "mutable", "tax", "priority"]) {
  assert.equal(report.includes(term), true, `missing review finding: ${term}`);
}

console.log("review-ok");
