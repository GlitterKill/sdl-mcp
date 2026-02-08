export type { LanguageAdapter } from "./LanguageAdapter.js";

export {
  registerAdapter,
  getAdapterForExtension,
  getSupportedExtensions,
  getLanguageIdForExtension,
} from "./registry.js";

export { TypeScriptAdapter } from "./typescript.js";
export { JavaAdapter } from "./java.js";
export { PythonAdapter } from "./python.js";
export { GoAdapter } from "./go.js";
export { CSharpAdapter } from "./csharp.js";
export { CAdapter } from "./c.js";
export { CppAdapter } from "./cpp.js";
export { PhpAdapter } from "./php.js";
export { RustAdapter } from "./rust.js";
export { KotlinAdapter } from "./kotlin.js";
export { ShellAdapter } from "./shell.js";
