/**
 * Tests for the behavioral summary system.
 * Verifies that analyzeBodyPatterns detects the correct signals
 * and that generateSummary produces behavioral (non-tautological) summaries.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import {
  generateSummary,
  analyzeBodyPatterns,
} from "../../dist/indexer/summaries.js";

const makeSymbol = (
  name: string,
  kind: string,
  body: string,
  overrides: Record<string, unknown> = {},
) => {
  const lines = body.split("\n");
  return {
    name,
    kind,
    range: { startLine: 1, startCol: 0, endLine: lines.length, endCol: 0 },
    exported: true,
    signature: { params: [] },
    ...overrides,
  };
};

// ── analyzeBodyPatterns ─────────────────────────────────────────────

describe("analyzeBodyPatterns", () => {
  it("detects throw statements", () => {
    const body = "function foo() {\n  throw new Error('bad');\n}";
    const sym = makeSymbol("foo", "function", body);
    const signals = analyzeBodyPatterns(sym as any, body);
    assert.strictEqual(signals.throws, true);
  });

  it("detects validation guards with early return", () => {
    const body = "function foo(x) {\n  if (!x) throw new Error('required');\n  return x;\n}";
    const sym = makeSymbol("foo", "function", body);
    const signals = analyzeBodyPatterns(sym as any, body);
    assert.strictEqual(signals.validates, true);
    assert.strictEqual(signals.throws, true);
  });

  it("detects async/await", () => {
    const body = "async function foo() {\n  const data = await fetch('/api');\n  return data;\n}";
    const sym = makeSymbol("foo", "function", body);
    const signals = analyzeBodyPatterns(sym as any, body);
    assert.strictEqual(signals.isAsync, true);
  });

  it("detects iteration via for-of", () => {
    const body = "function foo(items) {\n  for (const item of items) {\n    item.process();\n  }\n}";
    const sym = makeSymbol("foo", "function", body);
    const signals = analyzeBodyPatterns(sym as any, body);
    assert.strictEqual(signals.iterates, true);
  });

  it("detects iteration via .map", () => {
    const body = "function foo(items) {\n  return items.map(i => i.name);\n}";
    const sym = makeSymbol("foo", "function", body);
    const signals = analyzeBodyPatterns(sym as any, body);
    assert.strictEqual(signals.iterates, true);
    assert.strictEqual(signals.transforms, true);
  });

  it("detects .filter as iteration + transform", () => {
    const body = "function foo(items) {\n  return items.filter(i => i.active);\n}";
    const sym = makeSymbol("foo", "function", body);
    const signals = analyzeBodyPatterns(sym as any, body);
    assert.strictEqual(signals.iterates, true);
  });

  it("detects aggregation via .reduce", () => {
    const body = "function foo(nums) {\n  return nums.reduce((a, b) => a + b, 0);\n}";
    const sym = makeSymbol("foo", "function", body);
    const signals = analyzeBodyPatterns(sym as any, body);
    assert.strictEqual(signals.aggregates, true);
  });

  it("detects sort patterns", () => {
    const body = "function foo(items) {\n  return items.sort((a, b) => a.name.localeCompare(b.name));\n}";
    const sym = makeSymbol("foo", "function", body);
    const signals = analyzeBodyPatterns(sym as any, body);
    assert.strictEqual(signals.sorts, true);
  });

  it("detects network I/O via fetch", () => {
    const body = "async function foo() {\n  const resp = await fetch('https://api.example.com');\n  return resp.json();\n}";
    const sym = makeSymbol("foo", "function", body);
    const signals = analyzeBodyPatterns(sym as any, body);
    assert.strictEqual(signals.hasNetworkIO, true);
  });

  it("detects filesystem I/O", () => {
    const body = "function foo(path) {\n  return fs.readFileSync(path, 'utf8');\n}";
    const sym = makeSymbol("foo", "function", body);
    const signals = analyzeBodyPatterns(sym as any, body);
    assert.strictEqual(signals.hasFileIO, true);
  });

  it("detects database I/O", () => {
    const body = "function foo(id) {\n  return db.query('SELECT * FROM users WHERE id = ?', [id]);\n}";
    const sym = makeSymbol("foo", "function", body);
    const signals = analyzeBodyPatterns(sym as any, body);
    assert.strictEqual(signals.hasDbIO, true);
  });

  it("detects event emission", () => {
    const body = "function foo(data) {\n  this.emit('change', data);\n}";
    const sym = makeSymbol("foo", "function", body);
    const signals = analyzeBodyPatterns(sym as any, body);
    assert.strictEqual(signals.emitsEvents, true);
  });

  it("detects event subscription", () => {
    const body = "function foo(handler) {\n  emitter.on('data', handler);\n}";
    const sym = makeSymbol("foo", "function", body);
    const signals = analyzeBodyPatterns(sym as any, body);
    assert.strictEqual(signals.registersListeners, true);
  });

  it("detects recursion", () => {
    const body = "function walk(node) {\n  if (!node) return;\n  walk(node.left);\n  walk(node.right);\n}";
    const sym = makeSymbol("walk", "function", body);
    const signals = analyzeBodyPatterns(sym as any, body);
    assert.strictEqual(signals.recursion, true);
  });

  it("detects switch/case routing", () => {
    const body = "function foo(type) {\n  switch (type) {\n    case 'a': return 1;\n    case 'b': return 2;\n    case 'c': return 3;\n    default: return 0;\n  }\n}";
    const sym = makeSymbol("foo", "function", body);
    const signals = analyzeBodyPatterns(sym as any, body);
    assert.strictEqual(signals.switchOrChain, true);
  });

  it("detects delegation in short functions", () => {
    const body = "function foo(x) {\n  return this.bar(x);\n}";
    const sym = makeSymbol("foo", "function", body);
    const signals = analyzeBodyPatterns(sym as any, body);
    assert.ok(signals.delegates !== null, "should detect delegation");
  });

  it("skips comment lines", () => {
    const body = "function foo() {\n  // throw new Error('not real');\n  /* fetch('/api'); */\n  return 42;\n}";
    const sym = makeSymbol("foo", "function", body);
    const signals = analyzeBodyPatterns(sym as any, body);
    assert.strictEqual(signals.throws, false);
    assert.strictEqual(signals.hasNetworkIO, false);
  });

  it("returns empty signals for trivial body", () => {
    const body = "function foo() {\n  return 42;\n}";
    const sym = makeSymbol("foo", "function", body);
    const signals = analyzeBodyPatterns(sym as any, body);
    assert.strictEqual(signals.throws, false);
    assert.strictEqual(signals.validates, false);
    assert.strictEqual(signals.iterates, false);
    assert.strictEqual(signals.transforms, false);
    assert.strictEqual(signals.delegates, null);
  });

  it("detects merge patterns", () => {
    const body = "function foo(a, b) {\n  return Object.assign({}, a, b);\n}";
    const sym = makeSymbol("foo", "function", body);
    const signals = analyzeBodyPatterns(sym as any, body);
    assert.strictEqual(signals.merges, true);
  });
});

// ── generateSummary behavioral templates ────────────────────────────

describe("behavioral function summaries", () => {
  it("returns delegation summary for wrapper function", () => {
    const body = "function getUser(id) {\n  return this.store.get(id);\n}";
    const sym = makeSymbol("getUser", "function", body);
    const result = generateSummary(sym as any, body);
    assert.ok(result !== null, "should not be null");
    assert.ok(result!.startsWith("Delegates to"), "Expected delegation summary, got: " + result);
  });

  it("returns null for guard function with name-only subject", () => {
    const body = "function validateEmail(email) {\n  if (!email) throw new Error('required');\n  if (!email.includes('@')) throw new Error('invalid');\n  return email;\n}";
    const sym = makeSymbol("validateEmail", "function", body);
    const result = generateSummary(sym as any, body);
    assert.equal(result, null, "name-only subject should return null");  });

  it("returns network I/O summary for fetch function", () => {
    const body = "async function fetchData(url) {\n  const resp = await fetch(url);\n  return resp.json();\n}";
    const sym = makeSymbol("fetchData", "function", body);
    const result = generateSummary(sym as any, body);
    assert.ok(result !== null, "should not be null");
    assert.ok(result!.includes("Fetches") || result!.includes("network"), "Expected network summary, got: " + result);
  });

  it("returns null for .map chain with name-only subject", () => {
    const body = "function transformItems(items) {\n  return items.map(i => i.name).filter(n => n.length > 0);\n}";
    const sym = makeSymbol("transformItems", "function", body);
    const result = generateSummary(sym as any, body);
    assert.equal(result, null, "name-only subject should return null");  });

  it("returns recursion summary for self-calling function", () => {
    const body = "function traverse(node) {\n  if (!node) return;\n  console.log(node.value);\n  traverse(node.left);\n  traverse(node.right);\n}";
    const sym = makeSymbol("traverse", "function", body);
    const result = generateSummary(sym as any, body);
    assert.ok(result !== null, "should not be null");
    assert.ok(result!.includes("Recurs"), "Expected recursion summary, got: " + result);
  });

  it("returns null for function with no detectable behavior", () => {
    const body = "function getName() {\n  return this.name;\n}";
    const sym = makeSymbol("getName", "function", body);
    const result = generateSummary(sym as any, body);
    // Trivial getter — null is better than tautology
    assert.strictEqual(result, null);
  });

  it("returns null for forEach loop with name-only subject", () => {
    const body = "function notifyAll(listeners) {\n  listeners.forEach(l => l.callback());\n}";
    const sym = makeSymbol("notifyAll", "function", body);
    const result = generateSummary(sym as any, body);
    assert.equal(result, null, "name-only subject should return null");  });

  it("returns null for .sort call with name-only subject", () => {
    const body = "function sortUsers(users) {\n  return users.sort((a, b) => a.name.localeCompare(b.name));\n}";
    const sym = makeSymbol("sortUsers", "function", body);
    const result = generateSummary(sym as any, body);
    assert.equal(result, null, "name-only subject should return null");  });

  it("returns filesystem I/O summary for readFile", () => {
    const body = "function loadConfig(path) {\n  const raw = fs.readFileSync(path, 'utf8');\n  return JSON.parse(raw);\n}";
    const sym = makeSymbol("loadConfig", "function", body);
    const result = generateSummary(sym as any, body);
    assert.ok(result !== null, "should not be null");
    assert.ok(result!.includes("filesystem") || result!.includes("Reads/writes"), "Expected filesystem I/O summary, got: " + result);
  });

  it("preserves JSDoc summaries over behavioral analysis", () => {
    const body = "/** Computes the hash of input data. */\nfunction computeHash(data) {\n  return crypto.createHash('sha256').update(data).digest('hex');\n}";
    const sym = makeSymbol("computeHash", "function", body, {
      range: { startLine: 2, startCol: 0, endLine: 4, endCol: 1 },
    });
    const result = generateSummary(sym as any, body);
    assert.ok(result !== null, "should not be null");
    assert.strictEqual(result, "Computes the hash of input data");
  });
});
