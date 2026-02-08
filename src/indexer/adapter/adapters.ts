import { TypeScriptAdapter } from "./typescript.js";
import { JavaAdapter } from "./java.js";
import { GoAdapter } from "./go.js";
import { PythonAdapter } from "./python.js";
import { CSharpAdapter } from "./csharp.js";
import { CAdapter } from "./c.js";
import { CppAdapter } from "./cpp.js";
import { PhpAdapter } from "./php.js";
import { RustAdapter } from "./rust.js";
import { KotlinAdapter } from "./kotlin.js";
import { ShellAdapter } from "./shell.js";

export const adapters = [
  {
    extension: ".ts",
    languageId: "typescript",
    factory: () => new TypeScriptAdapter(),
  },
  {
    extension: ".tsx",
    languageId: "typescript",
    factory: () => new TypeScriptAdapter(),
  },
  {
    extension: ".js",
    languageId: "typescript",
    factory: () => new TypeScriptAdapter(),
  },
  {
    extension: ".jsx",
    languageId: "typescript",
    factory: () => new TypeScriptAdapter(),
  },
  {
    extension: ".java",
    languageId: "java",
    factory: () => new JavaAdapter(),
  },
  {
    extension: ".go",
    languageId: "go",
    factory: () => new GoAdapter(),
  },
  {
    extension: ".py",
    languageId: "python",
    factory: () => new PythonAdapter(),
  },
  {
    extension: ".cs",
    languageId: "csharp",
    factory: () => new CSharpAdapter(),
  },
  {
    extension: ".c",
    languageId: "c",
    factory: () => new CAdapter(),
  },
  {
    extension: ".h",
    languageId: "c",
    factory: () => new CAdapter(),
  },
  {
    extension: ".cc",
    languageId: "cpp",
    factory: () => new CppAdapter(),
  },
  {
    extension: ".cpp",
    languageId: "cpp",
    factory: () => new CppAdapter(),
  },
  {
    extension: ".cxx",
    languageId: "cpp",
    factory: () => new CppAdapter(),
  },
  {
    extension: ".hh",
    languageId: "cpp",
    factory: () => new CppAdapter(),
  },
  {
    extension: ".hpp",
    languageId: "cpp",
    factory: () => new CppAdapter(),
  },
  {
    extension: ".hxx",
    languageId: "cpp",
    factory: () => new CppAdapter(),
  },
  {
    extension: ".php",
    languageId: "php",
    factory: () => new PhpAdapter(),
  },
  {
    extension: ".phtml",
    languageId: "php",
    factory: () => new PhpAdapter(),
  },
  {
    extension: ".rs",
    languageId: "rust",
    factory: () => new RustAdapter(),
  },
  {
    extension: ".kt",
    languageId: "kotlin",
    factory: () => new KotlinAdapter(),
  },
  {
    extension: ".kts",
    languageId: "kotlin",
    factory: () => new KotlinAdapter(),
  },
  {
    extension: ".sh",
    languageId: "shell",
    factory: () => new ShellAdapter(),
  },
  {
    extension: ".bash",
    languageId: "shell",
    factory: () => new ShellAdapter(),
  },
];
