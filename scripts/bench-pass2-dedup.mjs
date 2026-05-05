#!/usr/bin/env node
// Microbench for the pass-2 dedup-set hot loop.
//
// Simulates `clearLocalCallDedupKeys` at sizes typical for the SDL-MCP repo:
//   - createdCallEdges grows to ~67k entries during pass-2
//   - ~1000 pass-2 files × ~10 symbols/file = ~10k clearLocalCallDedupKeys calls
//
// Compares two implementations:
//   A. Current — `for (edgeKey of Array.from(set)) if (edgeKey.startsWith(...))`
//   B. G1 candidate — `Map<fromSymbolId, Set<toSymbolId>>` index, prefix match becomes O(1)

const DEDUP_SIZE = 67000; // matches repo.status edge count
const FILES = 1000;
const SYMBOLS_PER_FILE = 10;
const FROM_POOL = 8000; // ~7842 symbols

function makeSymbolId(i) {
  return `sym${i.toString(36).padStart(6, "0")}`;
}

function makeEdgeKey(fromIdx, toIdx) {
  return `${makeSymbolId(fromIdx)}->${makeSymbolId(toIdx)}`;
}

// Build a realistic dedup set: each from-symbol has ~8 outgoing edges on
// average (67k / 8000 ≈ 8). Distribution roughly mirrors actual fan-out.
function buildDedupSet() {
  const set = new Set();
  for (let i = 0; i < DEDUP_SIZE; i++) {
    const from = i % FROM_POOL;
    const to = (from + i * 7) % FROM_POOL; // pseudo-random target
    set.add(makeEdgeKey(from, to));
  }
  return set;
}

function buildDedupIndex(set) {
  // Convert flat set to Map<fromSymbolId, Set<toSymbolId>> for O(1) prefix delete
  const index = new Map();
  for (const edgeKey of set) {
    const arrowIdx = edgeKey.indexOf("->");
    const from = edgeKey.slice(0, arrowIdx);
    const to = edgeKey.slice(arrowIdx + 2);
    let bucket = index.get(from);
    if (!bucket) {
      bucket = new Set();
      index.set(from, bucket);
    }
    bucket.add(to);
  }
  return index;
}

// Baseline: current implementation
function clearCurrentImpl(symbolIds, set) {
  for (const symbolId of symbolIds) {
    for (const edgeKey of Array.from(set)) {
      if (edgeKey.startsWith(`${symbolId}->`)) {
        set.delete(edgeKey);
      }
    }
  }
}

// G1 candidate: indexed
function clearG1Impl(symbolIds, set, index) {
  for (const symbolId of symbolIds) {
    const bucket = index.get(symbolId);
    if (!bucket) continue;
    for (const to of bucket) {
      set.delete(`${symbolId}->${to}`);
    }
    index.delete(symbolId);
  }
}

function bench(label, fn) {
  // Warm up
  for (let i = 0; i < 3; i++) fn();
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 5; i++) fn();
  const t1 = process.hrtime.bigint();
  const totalMs = Number(t1 - t0) / 1_000_000;
  const perRunMs = totalMs / 5;
  console.log(
    `  ${label}: ${perRunMs.toFixed(2)}ms / run (5 runs, ${totalMs.toFixed(0)}ms total)`,
  );
  return perRunMs;
}

console.log(`\nPass-2 dedup-set microbench`);
console.log(`  dedup size: ${DEDUP_SIZE} edges`);
console.log(`  files:      ${FILES}`);
console.log(
  `  symbols/file: ${SYMBOLS_PER_FILE} (${FILES * SYMBOLS_PER_FILE} total clears)\n`,
);

// Simulate full pass-2: process FILES files, each with SYMBOLS_PER_FILE
// symbol IDs to clear from a fresh local snapshot.
const baselineRun = () => {
  const set = buildDedupSet();
  for (let f = 0; f < FILES; f++) {
    const localSet = new Set(set); // dispatcher's per-file snapshot
    const symbolIds = [];
    for (let s = 0; s < SYMBOLS_PER_FILE; s++) {
      symbolIds.push(makeSymbolId((f * SYMBOLS_PER_FILE + s) % FROM_POOL));
    }
    clearCurrentImpl(symbolIds, localSet);
  }
};

const g1Run = () => {
  const set = buildDedupSet();
  for (let f = 0; f < FILES; f++) {
    const localSet = new Set(set); // dispatcher's per-file snapshot
    const localIndex = buildDedupIndex(localSet); // candidate: also build index per snapshot
    const symbolIds = [];
    for (let s = 0; s < SYMBOLS_PER_FILE; s++) {
      symbolIds.push(makeSymbolId((f * SYMBOLS_PER_FILE + s) % FROM_POOL));
    }
    clearG1Impl(symbolIds, localSet, localIndex);
  }
};

// Optimistic G1: treat the index as canonical state, no per-file rebuild.
// Models the version where dispatcher snapshots the INDEX (not the flat set)
// and the helper operates only on the index.
const g1OptimisticRun = () => {
  const masterIndex = buildDedupIndex(buildDedupSet());
  for (let f = 0; f < FILES; f++) {
    // Per-file snapshot: shallow copy of map (Set values shared by reference).
    // Models a cheap snapshot since deletes happen on a local clone.
    const localIndex = new Map();
    for (const [from, tos] of masterIndex) {
      localIndex.set(from, new Set(tos));
    }
    const symbolIds = [];
    for (let s = 0; s < SYMBOLS_PER_FILE; s++) {
      symbolIds.push(makeSymbolId((f * SYMBOLS_PER_FILE + s) % FROM_POOL));
    }
    // Direct on index (no flat set needed if all consumers use index)
    for (const symbolId of symbolIds) {
      localIndex.delete(symbolId);
    }
  }
};

console.log("Baseline (Array.from + startsWith):");
const baselineMs = bench("current", baselineRun);

console.log("\nG1 candidate (Map<from, Set<to>>, rebuilt per file):");
const g1Ms = bench("G1 + per-file index rebuild", g1Run);

console.log("\nG1 optimistic (Map<from, Set<to>> shared, deep copy):");
const g1OptMs = bench("G1 shared (deep copy snapshot)", g1OptimisticRun);

console.log(`\nResults`);
console.log(`  baseline: ${baselineMs.toFixed(0)}ms`);
console.log(
  `  G1 (index rebuild per file): ${g1Ms.toFixed(0)}ms (${(((baselineMs - g1Ms) / baselineMs) * 100).toFixed(0)}% saved)`,
);
console.log(
  `  G1 optimistic: ${g1OptMs.toFixed(0)}ms (${(((baselineMs - g1OptMs) / baselineMs) * 100).toFixed(0)}% saved)`,
);
