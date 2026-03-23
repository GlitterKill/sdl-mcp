import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  safeJsonParse,
  safeJsonParseOptional,
  safeJsonParseOrThrow,
  StringArraySchema,
  SignatureSchema,
} from "../../dist/util/safeJson.js";
import { DatabaseError } from "../../dist/mcp/errors.js";

test("safeJsonParse returns fallback for null input", () => {
  const result = safeJsonParse(null, z.string(), "fallback");
  assert.strictEqual(result, "fallback");
});

test("safeJsonParse returns fallback for undefined input", () => {
  const result = safeJsonParse(undefined, z.string(), "fallback");
  assert.strictEqual(result, "fallback");
});

test("safeJsonParse returns fallback for malformed JSON", () => {
  const result = safeJsonParse("not-json", z.string(), "fallback");
  assert.strictEqual(result, "fallback");
});

test("safeJsonParse returns fallback when schema validation fails", () => {
  const schema = z.object({ name: z.string() });
  const result = safeJsonParse('{"age": 30}', schema, { name: "default" });
  assert.deepStrictEqual(result, { name: "default" });
});

test("safeJsonParse returns parsed value when valid", () => {
  const schema = z.object({ name: z.string(), age: z.number() });
  const result = safeJsonParse('{"name": "John", "age": 30}', schema, {
    name: "default",
    age: 0,
  });
  assert.deepStrictEqual(result, { name: "John", age: 30 });
});

test("safeJsonParse returns fallback for array when schema expects object", () => {
  const schema = z.object({ name: z.string() });
  const result = safeJsonParse('["a", "b"]', schema, { name: "default" });
  assert.deepStrictEqual(result, { name: "default" });
});

test("safeJsonParseOptional returns undefined for null input", () => {
  const result = safeJsonParseOptional(null, z.string());
  assert.strictEqual(result, undefined);
});

test("safeJsonParseOptional returns undefined for malformed JSON", () => {
  const result = safeJsonParseOptional("invalid-json", z.string());
  assert.strictEqual(result, undefined);
});

test("safeJsonParseOptional returns undefined when schema validation fails", () => {
  const schema = z.object({ name: z.string() });
  const result = safeJsonParseOptional('{"age": 30}', schema);
  assert.strictEqual(result, undefined);
});

test("safeJsonParseOptional returns parsed value when valid", () => {
  const schema = z.array(z.string());
  const result = safeJsonParseOptional('["a", "b", "c"]', schema);
  assert.deepStrictEqual(result, ["a", "b", "c"]);
});

test("safeJsonParseOrThrow throws DatabaseError for null input", () => {
  assert.throws(
    () => safeJsonParseOrThrow(null, z.string(), "test context"),
    (err) => err instanceof DatabaseError,
  );
});

test("safeJsonParseOrThrow throws DatabaseError for malformed JSON", () => {
  assert.throws(
    () => safeJsonParseOrThrow("not-json", z.string(), "parsing config"),
    (err) => err instanceof DatabaseError,
  );
});

test("safeJsonParseOrThrow throws DatabaseError when schema validation fails", () => {
  const schema = z.object({ name: z.string() });
  assert.throws(
    () => safeJsonParseOrThrow('{"age": 30}', schema, "validating user object"),
    (err) => err instanceof DatabaseError,
  );
});

test("safeJsonParseOrThrow returns parsed value when valid", () => {
  const schema = z.object({ id: z.string(), name: z.string() });
  const result = safeJsonParseOrThrow(
    '{"id": "123", "name": "Alice"}',
    schema,
    "loading user",
  );
  assert.deepStrictEqual(result, { id: "123", name: "Alice" });
});

test("StringArraySchema validates array of strings", () => {
  const result = StringArraySchema.parse(["a", "b", "c"]);
  assert.deepStrictEqual(result, ["a", "b", "c"]);
});

test("StringArraySchema rejects non-string elements", () => {
  assert.throws(() => StringArraySchema.parse(["a", 123, "c"]));
});

test("SignatureSchema accepts object with any properties", () => {
  const result = SignatureSchema.parse({
    name: "myFunc",
    params: ["a", "b"],
    returnType: "string",
  });
  assert.deepStrictEqual(result, {
    name: "myFunc",
    params: ["a", "b"],
    returnType: "string",
  });
});

test("SignatureSchema accepts empty object", () => {
  const result = SignatureSchema.parse({});
  assert.deepStrictEqual(result, {});
});
