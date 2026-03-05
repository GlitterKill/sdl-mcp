// Built-in JS/TS method names that can never resolve to repo symbols.
// Filtering these from unresolved edges reduces totalCallEdges denominator.
const BUILTIN_IDENTIFIERS = new Set([
  // Array prototype
  "push", "pop", "shift", "unshift", "splice", "slice", "concat",
  "map", "filter", "reduce", "reduceRight", "find", "findIndex",
  "some", "every", "includes", "indexOf", "lastIndexOf",
  "sort", "reverse", "flat", "flatMap", "fill", "copyWithin",
  "forEach", "entries", "keys", "values", "join", "at",
  // String prototype
  "split", "trim", "trimStart", "trimEnd", "replace", "replaceAll",
  "startsWith", "endsWith",
  "toLowerCase", "toUpperCase", "toLocaleLowerCase", "toLocaleUpperCase",
  "match", "matchAll", "search", "padStart", "padEnd",
  "charAt", "charCodeAt", "codePointAt", "repeat", "substring",
  "localeCompare",
  // Object static
  "assign", "freeze", "defineProperty",
  "getOwnPropertyNames", "getPrototypeOf", "create", "fromEntries",
  // Math static
  "floor", "ceil", "round", "max", "min", "abs", "sqrt", "pow", "random", "log",
  // JSON
  "stringify", "parse",
  // Number/Date
  "toFixed", "toPrecision", "toISOString", "getTime", "toLocaleString",
  "parseInt", "parseFloat", "isNaN", "isFinite", "isInteger",
  // Promise
  "then", "catch", "finally",
  // Map/Set/WeakMap/WeakSet instance
  "has", "get", "set", "delete", "clear", "add",
  // Console
  "warn", "error", "info", "debug", "trace",
  // RegExp
  "test", "exec",
  // Node.js fs/path/url/events
  "readFileSync", "writeFileSync", "existsSync", "mkdirSync",
  "readFile", "writeFile", "readdir", "readdirSync", "stat", "statSync",
  "resolve", "dirname", "basename", "extname", "relative", "isAbsolute",
  "fileURLToPath", "pathToFileURL",
  "on", "off", "once", "emit", "removeListener", "removeAllListeners",
  // process
  "exit", "cwd", "env",
  // Database
  "prepare", "run", "all", "transaction", "close",
  // Zod schema builder methods
  "object", "string", "number", "boolean", "array", "enum", "optional",
  "nullable", "default", "describe", "int", "transform", "refine",
  "union", "intersection", "literal", "tuple", "record", "lazy",
  "coerce", "safeParse", "parseAsync", "passthrough", "strict",
  "extend", "merge", "pick", "omit", "partial", "required", "shape",
  "min", "max", "length", "email", "url", "uuid", "regex",
  // tree-sitter AST node methods
  "childForFieldName", "children", "namedChildren", "childCount",
  "namedChild", "child", "firstChild", "lastChild", "nextSibling",
  "previousSibling", "parent", "descendantsOfType", "walk",
  "startPosition", "endPosition",
  // Rust standard library
  "to_string", "unwrap", "unwrap_or", "unwrap_or_else",
  "expect", "is_some", "is_none", "is_ok", "is_err",
  "ok", "err", "as_ref", "as_mut", "as_str", "as_bytes",
  "collect", "iter", "into_iter", "len", "is_empty",
  "contains", "clone", "to_owned", "into", "from",
  "fmt", "display", "write_str", "write_fmt",
  // Testing frameworks
  "it", "beforeEach", "afterEach", "beforeAll", "afterAll",
  // Global functions
  "encodeURIComponent", "decodeURIComponent", "encodeURI", "decodeURI",
  "setTimeout", "clearTimeout", "setInterval", "clearInterval",
  "requestAnimationFrame", "cancelAnimationFrame",
  "atob", "btoa", "fetch",
  // Misc
  "toString", "valueOf", "toJSON", "iterator",
  "isArray", "write", "update", "next", "done", "send", "end",
]);

// Built-in constructors that will never resolve to repo symbols
const BUILTIN_CONSTRUCTORS = new Set([
  "Map", "Set", "WeakMap", "WeakSet", "Error", "TypeError", "RangeError",
  "SyntaxError", "ReferenceError", "Date", "RegExp", "Promise",
  "Array", "Object", "Number", "String", "Boolean", "Symbol",
  "Int8Array", "Uint8Array", "Float32Array", "Float64Array",
  "ArrayBuffer", "SharedArrayBuffer", "DataView", "Proxy", "Reflect",
  "URL", "URLSearchParams", "AbortController", "AbortSignal",
  "TextEncoder", "TextDecoder", "ReadableStream", "WritableStream",
  "Buffer", "EventEmitter", "Headers", "Request", "Response", "FormData",
  // Rust standard types (extracted as constructors)
  "Vec", "HashMap", "HashSet", "BTreeMap", "BTreeSet",
  "Some", "None", "Ok", "Err", "Box", "Rc", "Arc", "Cell", "RefCell",
  "Mutex", "RwLock", "PathBuf", "OsString", "CString",
]);

/** Check if an unresolved call target is a built-in that should be skipped. */
function isBuiltinCall(targetName: string): boolean {
  if (BUILTIN_IDENTIFIERS.has(targetName) || BUILTIN_CONSTRUCTORS.has(targetName)) {
    return true;
  }
  // Handle compound names like "Vec::new", "HashMap::new", "Some(x)"
  if (targetName.includes(":")) {
    const parts = targetName.split(":");
    if (parts.some(p => BUILTIN_CONSTRUCTORS.has(p) || BUILTIN_IDENTIFIERS.has(p))) {
      return true;
    }
  }
  return false;
}

export { BUILTIN_CONSTRUCTORS, BUILTIN_IDENTIFIERS, isBuiltinCall };
