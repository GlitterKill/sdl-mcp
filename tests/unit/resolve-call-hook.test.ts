import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { PythonAdapter } from "../../src/indexer/adapter/python.js";
import { GoAdapter } from "../../src/indexer/adapter/go.js";
import { JavaAdapter } from "../../src/indexer/adapter/java.js";
import { CSharpAdapter } from "../../src/indexer/adapter/csharp.js";
import { KotlinAdapter } from "../../src/indexer/adapter/kotlin.js";
import { RustAdapter } from "../../src/indexer/adapter/rust.js";
import { PhpAdapter } from "../../src/indexer/adapter/php.js";
import { CppAdapter } from "../../src/indexer/adapter/cpp.js";
import type {
  CallResolutionContext,
  AdapterResolvedCall,
} from "../../src/indexer/adapter/LanguageAdapter.js";
import type { ExtractedCall } from "../../src/indexer/treesitter/extractCalls.js";

function makeCall(calleeIdentifier: string): ExtractedCall {
  return {
    callerNodeId: "caller",
    calleeIdentifier,
    isResolved: false,
    callType: "function",
    range: {
      startLine: 1,
      startCol: 0,
      endLine: 1,
      endCol: 1,
    },
  };
}

function makeContext(input: {
  call: ExtractedCall;
  imported?: Record<string, string[]>;
  namespaces?: Record<string, Record<string, string>>;
  names?: Record<string, string[]>;
}): CallResolutionContext {
  const namespaceImports = new Map<string, Map<string, string>>();
  for (const [ns, members] of Object.entries(input.namespaces ?? {})) {
    namespaceImports.set(ns, new Map(Object.entries(members)));
  }

  return {
    call: input.call,
    importedNameToSymbolIds: new Map(Object.entries(input.imported ?? {})),
    namespaceImports,
    nameToSymbolIds: new Map(Object.entries(input.names ?? {})),
  };
}

function resolveWith(
  adapter: unknown,
  context: CallResolutionContext,
): AdapterResolvedCall | null {
  const candidate = adapter as {
    resolveCall?: (
      context: CallResolutionContext,
    ) => AdapterResolvedCall | null;
  };
  assert.ok(candidate.resolveCall, "expected adapter to implement resolveCall");
  return candidate.resolveCall(context);
}

describe("resolveCall hook", () => {
  describe("existing adapters", () => {
    it("python resolves namespace member", () => {
      const adapter = new PythonAdapter();
      const result = resolveWith(
        adapter,
        makeContext({
          call: makeCall("requests.get"),
          namespaces: {
            requests: { get: "sym:requests.get" },
          },
        }),
      );

      assert.deepStrictEqual(result, {
        symbolId: "sym:requests.get",
        isResolved: true,
        strategy: "exact",
        confidence: 0.92,
      });
    });

    it("go resolves dot import fallback", () => {
      const adapter = new GoAdapter();
      const result = resolveWith(
        adapter,
        makeContext({
          call: makeCall("Println"),
          namespaces: {
            ".": { Println: "sym:fmt.Println" },
          },
        }),
      );

      assert.deepStrictEqual(result, {
        symbolId: "sym:fmt.Println",
        isResolved: true,
        strategy: "heuristic",
        confidence: 0.76,
      });
    });

    it("java resolves this receiver using local names", () => {
      const adapter = new JavaAdapter();
      const result = resolveWith(
        adapter,
        makeContext({
          call: makeCall("this.process"),
          names: {
            process: ["sym:local.process"],
          },
        }),
      );

      assert.deepStrictEqual(result, {
        symbolId: "sym:local.process",
        isResolved: true,
        strategy: "heuristic",
        confidence: 0.78,
      });
    });
  });

  describe("csharp", () => {
    it("resolves this receiver", () => {
      const adapter = new CSharpAdapter();
      const result = resolveWith(
        adapter,
        makeContext({
          call: makeCall("this.execute"),
          names: {
            execute: ["sym:csharp.execute"],
          },
        }),
      );

      assert.deepStrictEqual(result, {
        symbolId: "sym:csharp.execute",
        isResolved: true,
        strategy: "heuristic",
        confidence: 0.78,
      });
    });

    it("resolves imported name", () => {
      const adapter = new CSharpAdapter();
      const result = resolveWith(
        adapter,
        makeContext({
          call: makeCall("Task"),
          imported: {
            Task: ["sym:system.threading.tasks.Task"],
          },
        }),
      );

      assert.deepStrictEqual(result, {
        symbolId: "sym:system.threading.tasks.Task",
        isResolved: true,
        strategy: "exact",
        confidence: 0.88,
      });
    });
  });

  describe("kotlin", () => {
    it("resolves super receiver", () => {
      const adapter = new KotlinAdapter();
      const result = resolveWith(
        adapter,
        makeContext({
          call: makeCall("super.render"),
          names: {
            render: ["sym:kotlin.render"],
          },
        }),
      );

      assert.deepStrictEqual(result, {
        symbolId: "sym:kotlin.render",
        isResolved: true,
        strategy: "heuristic",
        confidence: 0.78,
      });
    });

    it("resolves namespace member", () => {
      const adapter = new KotlinAdapter();
      const result = resolveWith(
        adapter,
        makeContext({
          call: makeCall("Collections.sort"),
          namespaces: {
            Collections: { sort: "sym:kotlin.collections.sort" },
          },
        }),
      );

      assert.deepStrictEqual(result, {
        symbolId: "sym:kotlin.collections.sort",
        isResolved: true,
        strategy: "exact",
        confidence: 0.9,
      });
    });
  });

  describe("rust", () => {
    it("resolves self receiver with dot syntax", () => {
      const adapter = new RustAdapter();
      const result = resolveWith(
        adapter,
        makeContext({
          call: makeCall("self.compute"),
          names: {
            compute: ["sym:rust.compute"],
          },
        }),
      );

      assert.deepStrictEqual(result, {
        symbolId: "sym:rust.compute",
        isResolved: true,
        strategy: "heuristic",
        confidence: 0.78,
      });
    });

    it("resolves double-colon namespace call", () => {
      const adapter = new RustAdapter();
      const result = resolveWith(
        adapter,
        makeContext({
          call: makeCall("HashMap::new"),
          namespaces: {
            HashMap: { new: "sym:rust.HashMap.new" },
          },
        }),
      );

      assert.deepStrictEqual(result, {
        symbolId: "sym:rust.HashMap.new",
        isResolved: true,
        strategy: "exact",
        confidence: 0.9,
      });
    });
  });

  describe("php", () => {
    it("resolves $this receiver", () => {
      const adapter = new PhpAdapter();
      const result = resolveWith(
        adapter,
        makeContext({
          call: makeCall("$this.handle"),
          names: {
            handle: ["sym:php.handle"],
          },
        }),
      );

      assert.deepStrictEqual(result, {
        symbolId: "sym:php.handle",
        isResolved: true,
        strategy: "heuristic",
        confidence: 0.78,
      });
    });

    it("resolves static scope call", () => {
      const adapter = new PhpAdapter();
      const result = resolveWith(
        adapter,
        makeContext({
          call: makeCall("self::boot"),
          names: {
            boot: ["sym:php.self.boot"],
          },
        }),
      );

      assert.deepStrictEqual(result, {
        symbolId: "sym:php.self.boot",
        isResolved: true,
        strategy: "heuristic",
        confidence: 0.78,
      });
    });
  });

  describe("cpp", () => {
    it("resolves this receiver", () => {
      const adapter = new CppAdapter();
      const result = resolveWith(
        adapter,
        makeContext({
          call: makeCall("this.run"),
          names: {
            run: ["sym:cpp.run"],
          },
        }),
      );

      assert.deepStrictEqual(result, {
        symbolId: "sym:cpp.run",
        isResolved: true,
        strategy: "heuristic",
        confidence: 0.78,
      });
    });

    it("resolves double-colon namespace call", () => {
      const adapter = new CppAdapter();
      const result = resolveWith(
        adapter,
        makeContext({
          call: makeCall("std::move"),
          namespaces: {
            std: { move: "sym:cpp.std.move" },
          },
        }),
      );

      assert.deepStrictEqual(result, {
        symbolId: "sym:cpp.std.move",
        isResolved: true,
        strategy: "exact",
        confidence: 0.9,
      });
    });
  });
});
