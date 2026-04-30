import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideFormat,
  decideFormatDetailed,
  isPackedEnabled,
  resolveThreshold,
  resolveTokenThreshold,
  shouldEmitPacked,
  PACKED_DEFAULT_THRESHOLD,
  PACKED_DEFAULT_TOKEN_THRESHOLD,
} from "../../dist/mcp/wire/packed/index.js";

test("default thresholds: bytes 0.10, tokens 0.20", () => {
  assert.equal(PACKED_DEFAULT_THRESHOLD, 0.10);
  assert.equal(PACKED_DEFAULT_TOKEN_THRESHOLD, 0.20);
});

test("shouldEmitPacked clears 0.15 byte threshold", () => {
  assert.equal(shouldEmitPacked(1000, 850, 0.15), true);
  assert.equal(shouldEmitPacked(1000, 851, 0.15), false);
});

test("decideFormat 'packed' enforces threshold (legacy bytes-only)", () => {
  assert.equal(decideFormat("packed", 1000, 700, 0.15), "packed");
  assert.equal(decideFormat("packed", 1000, 950, 0.15), "fallback");
});

test("decideFormatDetailed: token axis wins when bytes fall short", () => {
  // 5% byte savings (under 0.15) but 45% token savings (over 0.30) → emit
  const r = decideFormatDetailed(
    "packed",
    { jsonBytes: 1000, packedBytes: 950, jsonTokens: 500, packedTokens: 275 },
    0.15,
    0.3,
  );
  assert.equal(r.decision, "packed");
  assert.equal(r.axisHit, "tokens");
});

test("decideFormatDetailed: byte axis wins when tokens fall short", () => {
  // 25% byte savings (over 0.15), tokens at 10% (under 0.30) → still emit
  const r = decideFormatDetailed(
    "packed",
    { jsonBytes: 1000, packedBytes: 750, jsonTokens: 500, packedTokens: 450 },
    0.15,
    0.3,
  );
  assert.equal(r.decision, "packed");
  assert.equal(r.axisHit, "bytes");
});

test("decideFormatDetailed: both axes below thresholds → fallback", () => {
  const r = decideFormatDetailed(
    "packed",
    { jsonBytes: 1000, packedBytes: 950, jsonTokens: 500, packedTokens: 480 },
    0.15,
    0.3,
  );
  assert.equal(r.decision, "fallback");
  assert.equal(r.axisHit, null);
});

test("decideFormatDetailed 'auto' picks smaller token footprint", () => {
  const r = decideFormatDetailed("auto", {
    jsonBytes: 1000,
    packedBytes: 1100, // bytes worse
    jsonTokens: 500,
    packedTokens: 480, // tokens better
  });
  assert.equal(r.decision, "packed");
  assert.equal(r.axisHit, "tokens");
});

test("decideFormatDetailed 'auto' falls back to bytes when tokens absent", () => {
  const r = decideFormatDetailed("auto", { jsonBytes: 1000, packedBytes: 999 });
  assert.equal(r.decision, "packed");
  assert.equal(r.axisHit, "bytes");
});

test("resolveThreshold call-level wins (bytes)", () => {
  delete process.env.SDL_PACKED_THRESHOLD;
  assert.equal(resolveThreshold({ callThreshold: 0.42 }), 0.42);
});

test("resolveTokenThreshold call-level wins", () => {
  delete process.env.SDL_PACKED_TOKEN_THRESHOLD;
  assert.equal(resolveTokenThreshold({ callTokenThreshold: 0.55 }), 0.55);
});

test("resolveThreshold env beats config default", () => {
  process.env.SDL_PACKED_THRESHOLD = "0.55";
  try {
    assert.equal(resolveThreshold({ configThreshold: 0.2 }), 0.55);
  } finally {
    delete process.env.SDL_PACKED_THRESHOLD;
  }
});

test("resolveTokenThreshold env beats config default", () => {
  process.env.SDL_PACKED_TOKEN_THRESHOLD = "0.7";
  try {
    assert.equal(resolveTokenThreshold({ configTokenThreshold: 0.2 }), 0.7);
  } finally {
    delete process.env.SDL_PACKED_TOKEN_THRESHOLD;
  }
});

test("isPackedEnabled honors env kill switch", () => {
  process.env.SDL_PACKED_ENABLED = "false";
  try {
    assert.equal(isPackedEnabled(true), false);
  } finally {
    delete process.env.SDL_PACKED_ENABLED;
  }
  assert.equal(isPackedEnabled(true), true);
  assert.equal(isPackedEnabled(false), false);
});
