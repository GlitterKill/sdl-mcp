import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Legends,
  quoteIfNeeded,
  unquote,
  splitSections,
  assemble,
  writeHeader,
  parseHeader,
  parseScalars,
  writeScalars,
} from "../../dist/mcp/wire/packed/index.js";

test("Legends.add returns 1-based dense index and dedupes", () => {
  const l = new Legends();
  assert.equal(l.add("src/foo/"), 1);
  assert.equal(l.add("src/bar/"), 2);
  assert.equal(l.add("src/foo/"), 1);
});

test("Legends.replace replaces longest matching prefix", () => {
  const l = new Legends();
  l.add("src/");
  l.add("src/foo/");
  assert.equal(l.replace("src/foo/bar.ts"), "@2bar.ts");
  assert.equal(l.replace("src/baz.ts"), "@1baz.ts");
  assert.equal(l.replace("other/x.ts"), "other/x.ts");
});

test("Legends.expand reverses replace", () => {
  const l = new Legends();
  l.add("src/foo/");
  assert.equal(l.expand("@1bar.ts"), "src/foo/bar.ts");
  assert.equal(l.expand("plain.ts"), "plain.ts");
});

test("quoteIfNeeded quotes commas, equals, spaces, quotes", () => {
  assert.equal(quoteIfNeeded("simple"), "simple");
  assert.equal(quoteIfNeeded("with,comma"), '"with,comma"');
  assert.equal(quoteIfNeeded("with=eq"), '"with=eq"');
  assert.equal(quoteIfNeeded("with space"), '"with space"');
  assert.equal(quoteIfNeeded('with"quote'), '"with""quote"');
  assert.equal(quoteIfNeeded(""), '""');
});

test("quoteIfNeeded escapes newlines and CR (audit F1)", () => {
  assert.equal(quoteIfNeeded("a\nb"), '"a\\nb"');
  assert.equal(quoteIfNeeded("a\rb"), '"a\\rb"');
  assert.equal(quoteIfNeeded("a\\b"), '"a\\\\b"');
});

test("unquote round-trips quoteIfNeeded", () => {
  for (const s of [
    "simple",
    "x,y",
    "with space",
    'a"b',
    "a\nb",
    "a\rb",
    "a\\b",
    "",
  ]) {
    const round = unquote(quoteIfNeeded(s));
    assert.equal(round, s, `round-trip failed for ${JSON.stringify(s)}`);
  }
});

test("Windows backslash paths round-trip", () => {
  const winPath = "C:\\\\Users\\\\test\\\\file.ts";
  const round = unquote(quoteIfNeeded(winPath));
  assert.equal(round, winPath);
});

test("writeHeader / parseHeader round-trip", () => {
  const h = writeHeader("slice.build", "sl1");
  const parsed = parseHeader(h);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.toolName, "slice.build");
  assert.equal(parsed.encoderId, "sl1");
});

test("parseHeader rejects non-#PACKED prefixes", () => {
  assert.throws(() => parseHeader("#MUNCH/1 tool=x enc=y"));
  assert.throws(() => parseHeader("garbage"));
});

test("writeScalars / parseScalars round-trip plain values", () => {
  const out = writeScalars({ foo: "bar", n: "42", flag: "T" });
  const parsed = parseScalars(out);
  assert.equal(parsed.foo, "bar");
  assert.equal(parsed.n, "42");
  assert.equal(parsed.flag, "T");
});

test("writeScalars passes reserved keys verbatim", () => {
  const out = writeScalars({ __tables: "c:cards:id|f:str|str", regular: "x" });
  assert.match(out, /__tables=c:cards:id\|f:str\|str/);
  assert.match(out, /regular=x/);
});

test("splitSections / assemble preserve sections", () => {
  const payload = assemble({
    header: "#PACKED/1 tool=t enc=e",
    legend: "@1=src/",
    scalars: "k=v",
    tables: "t,a,b\nt,c,d",
  });
  assert.ok(payload.endsWith("\n"));
  const sections = splitSections(payload);
  assert.equal(sections.header, "#PACKED/1 tool=t enc=e");
  assert.equal(sections.legend, "@1=src/");
  assert.equal(sections.scalars, "k=v");
  assert.equal(sections.tables, "t,a,b\nt,c,d");
});
