import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  planTypeScriptSymbolEdit,
  type SymbolEditSymbolSnapshot,
} from "../../dist/mcp/tools/symbol-edit/ast.js";

const functionSnapshot: SymbolEditSymbolSnapshot = {
  symbolId: "sym-handle",
  name: "handleAuth",
  kind: "function",
  language: "typescript",
  range: { startLine: 1, startCol: 0, endLine: 3, endCol: 1 },
  astFingerprint: "fp-1",
};

describe("planTypeScriptSymbolEdit", () => {
  it("replaces only the inner function body", () => {
    const content = "export function handleAuth(user: User) {\n  return false;\n}\n";
    const result = planTypeScriptSymbolEdit({
      content,
      filePath: "src/auth.ts",
      symbol: functionSnapshot,
      operation: { kind: "replaceBody", content: "return true;\n" },
    });

    assert.equal(
      result.newContent,
      "export function handleAuth(user: User) {\n  return true;\n}\n",
    );
    assert.equal(result.editMode, "replaceBody");
    assert.equal(result.validation.parseAfter, true);
  });

  it("uses the AST body node instead of the first brace-like token", () => {
    const content =
      "export function handleAuth(input: { enabled: boolean }): boolean {\n  return input.enabled;\n}\n";
    const result = planTypeScriptSymbolEdit({
      content,
      filePath: "src/auth.ts",
      symbol: {
        ...functionSnapshot,
        range: { startLine: 1, startCol: 0, endLine: 3, endCol: 1 },
      },
      operation: { kind: "replaceBody", content: "return true;\n" },
    });

    assert.equal(
      result.newContent,
      "export function handleAuth(input: { enabled: boolean }): boolean {\n  return true;\n}\n",
    );
  });

  it("normalizes caller indentation without double-indenting blank lines", () => {
    const content = "export function handleAuth() {\n  return false;\n}\n";
    const result = planTypeScriptSymbolEdit({
      content,
      filePath: "src/auth.ts",
      symbol: functionSnapshot,
      operation: {
        kind: "replaceBody",
        content:
          "  if (ready) {\n    return true;\n  }\n  \n  return false;\n",
      },
    });

    assert.equal(
      result.newContent,
      "export function handleAuth() {\n  if (ready) {\n    return true;\n  }\n\n  return false;\n}\n",
    );
  });

  it("preserves tab indentation and relative nesting", () => {
    const content = "export function handleAuth() {\n\treturn false;\n}\n";
    const result = planTypeScriptSymbolEdit({
      content,
      filePath: "src/auth.ts",
      symbol: functionSnapshot,
      operation: {
        kind: "replaceBody",
        content: "if (ready) {\n\treturn true;\n}\n",
      },
    });

    assert.equal(
      result.newContent,
      "export function handleAuth() {\n\tif (ready) {\n\t\treturn true;\n\t}\n}\n",
    );
  });

  it("infers nested method indentation and leaves surrounding source unchanged", () => {
    const content =
      "class Auth {\n  handleAuth() {\n    return false;\n  }\n  untouched() { return 1; }\n}\n";
    const result = planTypeScriptSymbolEdit({
      content,
      filePath: "src/auth.ts",
      symbol: {
        ...functionSnapshot,
        kind: "method",
        range: { startLine: 2, startCol: 2, endLine: 4, endCol: 3 },
      },
      operation: {
        kind: "replaceBody",
        content: "if (ready) {\n  return true;\n}\n",
      },
    });

    assert.equal(
      result.newContent,
      "class Auth {\n  handleAuth() {\n    if (ready) {\n      return true;\n    }\n  }\n  untouched() { return 1; }\n}\n",
    );
  });

  it("infers the local indentation unit for an empty body", () => {
    const content =
      "class Auth {\n  existing() {\n    return false;\n  }\n  handleAuth() {\n  }\n}\n";
    const result = planTypeScriptSymbolEdit({
      content,
      filePath: "src/auth.ts",
      symbol: {
        ...functionSnapshot,
        kind: "method",
        range: { startLine: 5, startCol: 2, endLine: 6, endCol: 3 },
      },
      operation: { kind: "replaceBody", content: "return true;" },
    });

    assert.equal(
      result.newContent,
      "class Auth {\n  existing() {\n    return false;\n  }\n  handleAuth() {\n    return true;\n  }\n}\n",
    );
  });

  it("keeps an empty method in its local whitespace family", () => {
    const content =
      "function tabIndented() {\n\treturn false;\n}\nclass Auth {\n  handleAuth() {\n  }\n}\n";
    const result = planTypeScriptSymbolEdit({
      content,
      filePath: "src/auth.ts",
      symbol: {
        ...functionSnapshot,
        kind: "method",
        range: { startLine: 5, startCol: 2, endLine: 6, endCol: 3 },
      },
      operation: { kind: "replaceBody", content: "return true;" },
    });

    assert.equal(
      result.newContent,
      "function tabIndented() {\n\treturn false;\n}\nclass Auth {\n  handleAuth() {\n    return true;\n  }\n}\n",
    );
  });

  it("preserves CRLF line endings for logical body text", () => {
    const content =
      "export function handleAuth() {\r\n  return false;\r\n}\r\n";
    const result = planTypeScriptSymbolEdit({
      content,
      filePath: "src/auth.ts",
      symbol: functionSnapshot,
      operation: {
        kind: "replaceBody",
        content: "if (ready) {\n  return true;\n}\n",
      },
    });

    assert.equal(
      result.newContent,
      "export function handleAuth() {\r\n  if (ready) {\r\n    return true;\r\n  }\r\n}\r\n",
    );
    assert.equal(result.newContent.replace(/\r\n/g, "").includes("\n"), false);
  });

  it("replaces the signature while preserving the existing body", () => {
    const content = "export function handleAuth(user: User): boolean {\n  return false;\n}\n";
    const result = planTypeScriptSymbolEdit({
      content,
      filePath: "src/auth.ts",
      symbol: functionSnapshot,
      operation: {
        kind: "replaceSignature",
        content: "export async function handleAuth(user: User): Promise<boolean>",
      },
    });

    assert.equal(
      result.newContent,
      "export async function handleAuth(user: User): Promise<boolean> {\n  return false;\n}\n",
    );
  });

  it("rejects target-resolution false positives when duplicate symbols remain", () => {
    const content =
      "function handleAuth() {\n  return false;\n}\nfunction handleAuth() {\n  return true;\n}\n";

    assert.throws(
      () =>
        planTypeScriptSymbolEdit({
          content,
          filePath: "src/auth.ts",
          symbol: {
            ...functionSnapshot,
            range: { startLine: 1, startCol: 0, endLine: 3, endCol: 1 },
          },
          operation: {
            kind: "replaceSignature",
            content: "function otherAuth()",
          },
        }),
      /Target symbol did not resolve/,
    );
  });

  it("rejects target-resolution false positives from nested same-name symbols", () => {
    const content =
      "function handleAuth() {\n  function handleAuth() {\n    return true;\n  }\n  return false;\n}\n";

    assert.throws(
      () =>
        planTypeScriptSymbolEdit({
          content,
          filePath: "src/auth.ts",
          symbol: {
            ...functionSnapshot,
            range: { startLine: 1, startCol: 0, endLine: 6, endCol: 1 },
          },
          operation: {
            kind: "replaceSignature",
            content: "function otherAuth()",
          },
        }),
      /Target symbol did not resolve/,
    );
  });

  it("uses the exported declaration boundary for adjacent inserts", () => {
    const content = "export function handleAuth() {\n  return false;\n}\n";
    const result = planTypeScriptSymbolEdit({
      content,
      filePath: "src/auth.ts",
      symbol: {
        ...functionSnapshot,
        range: { startLine: 1, startCol: 7, endLine: 3, endCol: 1 },
      },
      operation: { kind: "insertBefore", content: "export const inserted = 2;\n" },
    });

    assert.equal(
      result.newContent,
      "export const inserted = 2;\nexport function handleAuth() {\n  return false;\n}\n",
    );
  });

  it("inserts adjacent sibling text after the selected symbol", () => {
    const content = "export function handleAuth() {\n  return false;\n}\nexport const later = 1;\n";
    const result = planTypeScriptSymbolEdit({
      content,
      filePath: "src/auth.ts",
      symbol: functionSnapshot,
      operation: { kind: "insertAfter", content: "export const inserted = 2;\n" },
    });

    assert.equal(
      result.newContent,
      "export function handleAuth() {\n  return false;\n}\nexport const inserted = 2;\nexport const later = 1;\n",
    );
  });

  it("renames locals only inside the selected symbol", () => {
    const content =
      "export function handleAuth() {\n  const value = 1;\n  return value;\n}\nconst value = 2;\n";
    const result = planTypeScriptSymbolEdit({
      content,
      filePath: "src/auth.ts",
      symbol: {
        ...functionSnapshot,
        range: { startLine: 1, startCol: 0, endLine: 4, endCol: 1 },
      },
      operation: { kind: "renameLocal", name: "value", replacement: "nextValue" },
    });

    assert.equal(
      result.newContent,
      "export function handleAuth() {\n  const nextValue = 1;\n  return nextValue;\n}\nconst value = 2;\n",
    );
  });

  it("renames AST identifiers without changing strings, comments, or properties", () => {
    const content =
      "export function handleAuth() {\n  const value = 1;\n  console.log(\"value\", account.value);\n  // value should stay in comments\n  return value;\n}\n";
    const result = planTypeScriptSymbolEdit({
      content,
      filePath: "src/auth.ts",
      symbol: {
        ...functionSnapshot,
        range: { startLine: 1, startCol: 0, endLine: 6, endCol: 1 },
      },
      operation: { kind: "renameLocal", name: "value", replacement: "nextValue" },
    });

    assert.equal(
      result.newContent,
      "export function handleAuth() {\n  const nextValue = 1;\n  console.log(\"value\", account.value);\n  // value should stay in comments\n  return nextValue;\n}\n",
    );
  });

  it("rejects renameLocal when a nested scope contains the same identifier", () => {
    const content =
      "export function handleAuth() {\n  const value = 1;\n  function nested() {\n    const value = 2;\n    return value;\n  }\n  return value;\n}\n";

    assert.throws(
      () =>
        planTypeScriptSymbolEdit({
          content,
          filePath: "src/auth.ts",
          symbol: {
            ...functionSnapshot,
            range: { startLine: 1, startCol: 0, endLine: 8, endCol: 1 },
          },
          operation: {
            kind: "renameLocal",
            name: "value",
            replacement: "nextValue",
          },
        }),
      /nested scope/,
    );
  });

  it("rejects renameLocal when multiple declarations match", () => {
    const content =
      "export function handleAuth() {\n  const value = 1;\n  if (value) {\n    const value = 2;\n    return value;\n  }\n  return value;\n}\n";

    assert.throws(
      () =>
        planTypeScriptSymbolEdit({
          content,
          filePath: "src/auth.ts",
          symbol: {
            ...functionSnapshot,
            range: { startLine: 1, startCol: 0, endLine: 8, endCol: 1 },
          },
          operation: {
            kind: "renameLocal",
            name: "value",
            replacement: "nextValue",
          },
        }),
      /multiple declarations/,
    );
  });

  it("rejects renameLocal for object literal shorthand", () => {
    const content =
      "export function handleAuth() {\n  const value = 1;\n  return { value };\n}\n";

    assert.throws(
      () =>
        planTypeScriptSymbolEdit({
          content,
          filePath: "src/auth.ts",
          symbol: {
            ...functionSnapshot,
            range: { startLine: 1, startCol: 0, endLine: 4, endCol: 1 },
          },
          operation: {
            kind: "renameLocal",
            name: "value",
            replacement: "nextValue",
          },
        }),
      /shorthand object or destructuring/,
    );
  });

  it("rejects renameLocal for destructuring shorthand", () => {
    const content =
      "export function handleAuth(source: { value: number }) {\n  const { value } = source;\n  return value;\n}\n";

    assert.throws(
      () =>
        planTypeScriptSymbolEdit({
          content,
          filePath: "src/auth.ts",
          symbol: {
            ...functionSnapshot,
            range: { startLine: 1, startCol: 0, endLine: 4, endCol: 1 },
          },
          operation: {
            kind: "renameLocal",
            name: "value",
            replacement: "nextValue",
          },
        }),
      /shorthand object or destructuring/,
    );
  });

  it("rejects unsupported body edits for ambient declarations", () => {
    assert.throws(
      () =>
        planTypeScriptSymbolEdit({
          content: "declare function handleAuth(): boolean;\n",
          filePath: "src/auth.d.ts",
          symbol: {
            ...functionSnapshot,
            range: { startLine: 1, startCol: 0, endLine: 1, endCol: 39 },
          },
          operation: { kind: "replaceBody", content: "return true;\n" },
        }),
      /Cannot locate body range/,
    );
  });

  it("gives a concrete next action when a selected symbol range cannot resolve", () => {
    assert.throws(
      () =>
        planTypeScriptSymbolEdit({
          content: "export interface ToolResponseEnvelope {\n  ok: boolean;\n}\n",
          filePath: "src/server.ts",
          symbol: {
            symbolId: "sym-envelope",
            name: "ToolResponseEnvelope",
            kind: "interface",
            language: "typescript",
            range: { startLine: 1, startCol: 1, endLine: 3, endCol: 1 },
            astFingerprint: "fp-interface",
          },
          operation: { kind: "insertAfter", content: "export interface Added {}\n" },
        }),
      /Cannot locate AST node.*interface.*source window/i,
    );
  });
});
