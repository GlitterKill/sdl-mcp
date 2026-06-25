import assert from "node:assert/strict";
import { add, subtract } from "./math.mjs";

assert.equal(add(2, 3), 5);
assert.equal(subtract(7, 4), 3);
