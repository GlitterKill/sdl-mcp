import { describe, it } from "node:test";
import assert from "node:assert";
import {
  getRuntime,
  getRegisteredRuntimes,
  getRuntimeExtension,
  isExecutableCompatibleWithRuntime,
  normalizeExecutableName,
  RUNTIME_NAMES,
} from "../../dist/runtime/runtimes.js";

describe("runtime table structure", () => {
  it("should register exactly 16 runtimes", () => {
    assert.strictEqual(getRegisteredRuntimes().length, 16);
  });

  it("should export RUNTIME_NAMES matching registered runtimes", () => {
    const registered = getRegisteredRuntimes().sort();
    const names = [...RUNTIME_NAMES].sort();
    assert.deepStrictEqual(names, registered);
  });

  it("every runtime should have a descriptor", () => {
    for (const name of RUNTIME_NAMES) {
      const rt = getRuntime(name);
      assert.ok(rt, `Missing descriptor for runtime: ${name}`);
      assert.strictEqual(rt.name, name);
    }
  });
});

describe("alias compatibility", () => {
  const cases: [string, string, boolean][] = [
    ["node", "node", true],
    ["node", "bun", true],
    ["node", "python3", false],
    ["typescript", "tsx", true],
    ["typescript", "bun", true],
    ["typescript", "node", false],
    ["python", "python3", true],
    ["python", "python", true],
    ["python", "py", true],
    ["shell", "bash", true],
    ["shell", "cmd", true],
    ["shell", "node", false],
    ["ruby", "ruby", true],
    ["ruby", "python", false],
    ["php", "php", true],
    ["perl", "perl", true],
    ["r", "Rscript", true],
    ["elixir", "elixir", true],
    ["go", "go", true],
    ["java", "java", true],
    ["kotlin", "kotlin", true],
    ["rust", "rustc", true],
    ["rust", "gcc", false],
    ["c", "gcc", true],
    ["c", "cc", true],
    ["cpp", "g++", true],
    ["cpp", "c++", true],
    ["csharp", "dotnet-script", true],
  ];

  for (const [runtime, executable, expected] of cases) {
    it(`${runtime} + ${executable} => ${expected}`, () => {
      assert.strictEqual(isExecutableCompatibleWithRuntime(runtime, executable), expected);
    });
  }
});

describe("buildCommand — interpreted runtimes", () => {
  const interpretedRuntimes = ["node", "typescript", "python", "ruby", "php", "perl", "r", "elixir"];

  for (const name of interpretedRuntimes) {
    it(`${name}: code mode includes codePath as first arg`, () => {
      const rt = getRuntime(name);
      assert.ok(rt);
      const { args: cmdArgs } = rt.buildCommand(["--flag"], { codePath: "/tmp/code.ext" });
      assert.ok(cmdArgs.includes("/tmp/code.ext"), `codePath not in args for ${name}`);
      assert.ok(cmdArgs.indexOf("/tmp/code.ext") < cmdArgs.indexOf("--flag"),
        `codePath should come before user args for ${name}`);
    });

    it(`${name}: args mode passes args directly`, () => {
      const rt = getRuntime(name);
      assert.ok(rt);
      const { args: cmdArgs } = rt.buildCommand(["--flag", "value"], {});
      assert.ok(cmdArgs.includes("--flag"));
      assert.ok(cmdArgs.includes("value"));
    });
  }
});

describe("buildCommand — run-command compiled runtimes", () => {
  it("go: code mode produces 'go run <codePath>'", () => {
    const rt = getRuntime("go");
    assert.ok(rt);
    const { executable, args: cmdArgs } = rt.buildCommand([], { codePath: "/tmp/main.go" });
    assert.strictEqual(executable, "go");
    assert.deepStrictEqual(cmdArgs, ["run", "/tmp/main.go"]);
  });

  it("java: code mode produces 'java <codePath>'", () => {
    const rt = getRuntime("java");
    assert.ok(rt);
    const { executable, args: cmdArgs } = rt.buildCommand([], { codePath: "/tmp/Main.java" });
    assert.strictEqual(executable, "java");
    assert.deepStrictEqual(cmdArgs, ["/tmp/Main.java"]);
  });

  it("kotlin: code mode produces 'kotlin <codePath>'", () => {
    const rt = getRuntime("kotlin");
    assert.ok(rt);
    const { executable, args: cmdArgs } = rt.buildCommand([], { codePath: "/tmp/script.kts" });
    assert.strictEqual(executable, "kotlin");
    assert.deepStrictEqual(cmdArgs, ["/tmp/script.kts"]);
  });

  it("csharp: code mode produces 'dotnet-script <codePath>'", () => {
    const rt = getRuntime("csharp");
    assert.ok(rt);
    const { executable, args: cmdArgs } = rt.buildCommand([], { codePath: "/tmp/script.csx" });
    assert.strictEqual(executable, "dotnet-script");
    assert.deepStrictEqual(cmdArgs, ["/tmp/script.csx"]);
  });
});

describe("buildCommand — compile-then-execute runtimes", () => {
  it("rust: code mode produces compile command with $CODE and $OUT interpolated", () => {
    const rt = getRuntime("rust");
    assert.ok(rt);
    const { executable, args: cmdArgs } = rt.buildCommand([], { codePath: "/tmp/main.rs" });
    assert.strictEqual(executable, "rustc");
    assert.ok(cmdArgs.includes("/tmp/main.rs"), "codePath not interpolated");
    const outArg = cmdArgs[cmdArgs.indexOf("-o") + 1];
    assert.ok(outArg.startsWith("/tmp/main"), `output path unexpected: ${outArg}`);
  });

  it("c: code mode produces gcc compile command", () => {
    const rt = getRuntime("c");
    assert.ok(rt);
    const { executable, args: cmdArgs } = rt.buildCommand([], { codePath: "/tmp/prog.c" });
    assert.strictEqual(executable, "gcc");
    assert.ok(cmdArgs.includes("/tmp/prog.c"));
    assert.ok(cmdArgs.includes("-o"));
  });

  it("cpp: code mode produces g++ compile command", () => {
    const rt = getRuntime("cpp");
    assert.ok(rt);
    const { executable, args: cmdArgs } = rt.buildCommand([], { codePath: "/tmp/prog.cpp" });
    assert.strictEqual(executable, "g++");
    assert.ok(cmdArgs.includes("/tmp/prog.cpp"));
    assert.ok(cmdArgs.includes("-o"));
  });
});

describe("extension lookup", () => {
  it("should return correct extension for each runtime", () => {
    const expected: Record<string, string> = {
      node: ".js", typescript: ".ts", python: ".py",
      ruby: ".rb", php: ".php", perl: ".pl", r: ".R", elixir: ".exs",
      go: ".go", java: ".java", kotlin: ".kts",
      rust: ".rs", c: ".c", cpp: ".cpp", csharp: ".csx",
    };
    for (const [name, ext] of Object.entries(expected)) {
      assert.strictEqual(getRuntimeExtension(name), ext, `Wrong extension for ${name}`);
    }
  });

  it("should return platform-conditional extension for shell", () => {
    const ext = getRuntimeExtension("shell");
    const expected = process.platform === "win32" ? ".cmd" : ".sh";
    assert.strictEqual(ext, expected);
  });
});

describe("normalizeExecutableName", () => {
  it("normalizes Windows absolute paths", () => {
    assert.strictEqual(normalizeExecutableName("C:\\Program Files\\nodejs\\node.exe"), "node.exe");
  });

  it("normalizes quoted paths", () => {
    assert.strictEqual(normalizeExecutableName('"C:\\ruby\\bin\\ruby.exe"'), "ruby.exe");
  });

  it("lowercases result", () => {
    assert.strictEqual(normalizeExecutableName("Rscript"), "rscript");
  });
});
