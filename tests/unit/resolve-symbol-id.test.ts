import { describe, it } from "node:test";
import assert from "node:assert";
import type { Connection } from "kuzu";

import { NotFoundError } from "../../src/mcp/errors.js";
import { resolveSymbolId } from "../../src/util/resolve-symbol-id.js";

interface CapturedCall {
  statement: unknown;
  params: Record<string, unknown>;
}

function createFakeConnection(rows: unknown[]): {
  conn: Connection;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const conn = {
    async prepare(statement: string): Promise<{ statement: string }> {
      return { statement };
    },
    async execute(
      prepared: { statement: string },
      params: Record<string, unknown>,
    ): Promise<{ getAll: () => Promise<unknown[]>; close: () => void }> {
      calls.push({ statement: prepared.statement, params });
      return {
        async getAll(): Promise<unknown[]> {
          return rows;
        },
        close(): void {
          // no-op
        },
      };
    },
  } as unknown as Connection;

  return { conn, calls };
}

describe("resolveSymbolId", () => {
  it("returns lowercase SHA256 input as-is", async () => {
    const { conn } = createFakeConnection([]);
    const hash = "a".repeat(64);

    const result = await resolveSymbolId(conn, "repo-1", hash);
    assert.deepStrictEqual(result, { symbolId: hash, wasShorthand: false });
  });

  it("treats uppercase SHA-like input as non-hash fallback", async () => {
    const { conn } = createFakeConnection([]);
    const uppercaseHash = "A".repeat(64);

    const result = await resolveSymbolId(conn, "repo-1", uppercaseHash);
    assert.deepStrictEqual(result, {
      symbolId: uppercaseHash,
      wasShorthand: false,
    });
  });

  it("returns non-hex non-shorthand input as-is", async () => {
    const { conn } = createFakeConnection([]);
    const input = "plain-symbol-id";

    const result = await resolveSymbolId(conn, "repo-1", input);
    assert.deepStrictEqual(result, { symbolId: input, wasShorthand: false });
  });

  it("recognizes file::symbol shorthand and resolves via DB lookup", async () => {
    const { conn } = createFakeConnection([
      { symbolId: "resolved-1", kind: "function" },
    ]);

    const result = await resolveSymbolId(conn, "repo-1", "src/a.ts::doThing");
    assert.deepStrictEqual(result, {
      symbolId: "resolved-1",
      wasShorthand: true,
    });
  });

  it("normalizes backslashes in shorthand relPath before DB lookup", async () => {
    const { conn, calls } = createFakeConnection([
      { symbolId: "resolved-1", kind: "function" },
    ]);

    await resolveSymbolId(conn, "repo-1", "src\\module\\file.ts::doThing");

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].params.relPath, "src/module/file.ts");
    assert.strictEqual(calls[0].params.name, "doThing");
  });

  it("uses shorthand regex greedily for relPath segment", async () => {
    const { conn, calls } = createFakeConnection([
      { symbolId: "resolved-1", kind: "function" },
    ]);

    await resolveSymbolId(conn, "repo-1", "pkg:core::file.ts::entry");

    assert.strictEqual(calls[0].params.relPath, "pkg:core::file.ts");
    assert.strictEqual(calls[0].params.name, "entry");
  });

  it("treats malformed shorthand without symbol name as fallback", async () => {
    const { conn } = createFakeConnection([]);
    const input = "src/a.ts::";

    const result = await resolveSymbolId(conn, "repo-1", input);
    assert.deepStrictEqual(result, { symbolId: input, wasShorthand: false });
  });

  it("throws NotFoundError when shorthand has no DB or overlay match", async () => {
    const { conn } = createFakeConnection([]);

    await assert.rejects(
      () => resolveSymbolId(conn, "repo-1", "src/a.ts::missingName"),
      (err: unknown) => {
        assert.ok(err instanceof NotFoundError);
        assert.match(String((err as Error).message), /missingName/);
        return true;
      },
    );
  });

  it("returns first DB candidate when shorthand query yields multiple rows", async () => {
    const { conn } = createFakeConnection([
      { symbolId: "best-candidate", kind: "class" },
      { symbolId: "second-candidate", kind: "function" },
    ]);

    const result = await resolveSymbolId(conn, "repo-1", "src/a.ts::Thing");
    assert.deepStrictEqual(result, {
      symbolId: "best-candidate",
      wasShorthand: true,
    });
  });
});
