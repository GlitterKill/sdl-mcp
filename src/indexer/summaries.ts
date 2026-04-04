import { ExtractedSymbol } from "./treesitter/extractSymbols.js";

const ROLE_SUFFIXES: ReadonlyMap<string, string> = new Map([
  ["Provider", "provider"],
  ["Factory", "factory"],
  ["Builder", "builder"],
  ["Handler", "handler"],
  ["Service", "service"],
  ["Repository", "repository"],
  ["Adapter", "adapter"],
  ["Controller", "controller"],
  ["Manager", "manager"],
  ["Middleware", "middleware"],
  ["Resolver", "resolver"],
  ["Validator", "validator"],
  ["Serializer", "serializer"],
  ["Transformer", "transformer"],
]);

const SUFFIX_PATTERNS: ReadonlyMap<string, string> = new Map([
  ["Props", "Props definition"],
  ["Options", "Options definition"],
  ["Config", "Configuration"],
  ["Settings", "Settings definition"],
  ["Params", "Parameters definition"],
  ["Result", "Result type"],
  ["Response", "Response type"],
  ["Output", "Output type"],
  ["Input", "Input type"],
  ["Request", "Request type"],
  ["Args", "Arguments type"],
]);

function splitSnakeCase(name: string): string {
  return name.toLowerCase().split("_").filter(Boolean).join(" ");
}

export function generateSummary(
  symbol: ExtractedSymbol,
  fileContent: string,
): string | null {
  const jsdoc = extractJSDoc(symbol, fileContent);

  if (jsdoc.description) {
    const sentences = jsdoc.description
      .split(/[.!?]/)
      .filter((s) => s.trim().length > 0);
    if (sentences.length > 0) {
      return sentences.slice(0, 2).join(". ").trim();
    }
  }

  // No JSDoc — dispatch to per-kind heuristic generators
  switch (symbol.kind) {
    case "function":
    case "method":
      return generateBehavioralFunctionSummary(symbol, fileContent);
    case "class":
      return generateClassSummary(symbol);
    case "interface":
      return generateInterfaceSummary(symbol);
    case "type":
      return generateTypeSummary(symbol);
    case "variable":
      return generateVariableSummary(symbol);
    case "constructor":
      return generateConstructorSummary(symbol);
    default:
      return null;
  }
}

/**
 * Applies isNameOnlySummary as a final quality gate on generated summaries.
 * Call this wrapper instead of generateSummary directly when you want filtering.
 */
export function generateFilteredSummary(
  symbol: ExtractedSymbol,
  fileContent: string,
): string | null {
  const summary = generateSummary(symbol, fileContent);
  if (summary === null) return null;
  if (isNameOnlySummary(summary, symbol.name)) return null;
  return summary;
}

/**
 * Behavioral signals extracted from a function body via lightweight regex matching.
 * Used to generate summaries that describe behavior rather than restating the signature.
 */
interface BodySignals {
  throws: boolean;
  validates: boolean;
  delegates: string | null;
  iterates: boolean;
  isAsync: boolean;
  hasNetworkIO: boolean;
  hasFileIO: boolean;
  hasDbIO: boolean;
  transforms: boolean;
  aggregates: boolean;
  caches: boolean;
  sorts: boolean;
  merges: boolean;
  earlyReturns: number;
  switchOrChain: boolean;
  recursion: boolean;
  emitsEvents: boolean;
  registersListeners: boolean;
}

const MAX_BODY_SCAN_LINES = 200;

/**
 * Analyze a function body for behavioral patterns using regex/string matching.
 * Skips comment lines. Caps scan at MAX_BODY_SCAN_LINES.
 */
const SKIP_CALLS = new Set([
  "console.log",
  "console.warn",
  "console.error",
  "Math.min",
  "Math.max",
  "Math.abs",
  "Math.floor",
  "Math.ceil",
  "Math.round",
  "Array.isArray",
  "Object.keys",
  "Object.values",
  "Object.entries",
  "JSON.stringify",
  "JSON.parse",
  "String",
  "Number",
  "Boolean",
  "parseInt",
  "parseFloat",
  "Promise.all",
  "Promise.resolve",
]);

export function analyzeBodyPatterns(
  symbol: ExtractedSymbol,
  fileContent: string,
): BodySignals {
  const signals: BodySignals = {
    throws: false,
    validates: false,
    delegates: null,
    iterates: false,
    isAsync: false,
    hasNetworkIO: false,
    hasFileIO: false,
    hasDbIO: false,
    transforms: false,
    aggregates: false,
    caches: false,
    sorts: false,
    merges: false,
    earlyReturns: 0,
    switchOrChain: false,
    recursion: false,
    emitsEvents: false,
    registersListeners: false,
  };

  const rawLines = getSymbolLines(symbol, fileContent);
  // Skip the first line (function signature) and cap at MAX_BODY_SCAN_LINES
  const lines = rawLines.slice(1, MAX_BODY_SCAN_LINES + 1);
  if (lines.length === 0) return signals;

  let inBlockComment = false;
  let elseIfCount = 0;
  const callCounts = new Map<string, number>();

  const nameRegex = new RegExp(`\\b${escapeRegex(symbol.name)}\\s*\\(`);

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // Skip comment lines
    if (inBlockComment) {
      if (line.includes("*/")) inBlockComment = false;
      continue;
    }
    if (line.startsWith("/*")) {
      inBlockComment = true;
      if (line.includes("*/")) inBlockComment = false;
      continue;
    }
    if (line.startsWith("//")) continue;
    if (line.length === 0) continue;

    // Throws
    if (/\bthrow\s+/.test(line)) signals.throws = true;

    // Validation guards: if (!...) throw/return
    if (
      /if\s*\(!/.test(line) &&
      (/throw\b/.test(line) || /return\b/.test(line))
    ) {
      signals.validates = true;
    }
    if (/if\s*\(/.test(line) && /throw\s+new\b/.test(line)) {
      signals.validates = true;
    }

    // Async
    if (/\bawait\s/.test(line)) signals.isAsync = true;

    // Iteration
    if (
      /\.forEach\s*\(/.test(line) ||
      /\.map\s*\(/.test(line) ||
      /\.filter\s*\(/.test(line) ||
      /\.reduce\s*\(/.test(line) ||
      /\bfor\s*\(/.test(line) ||
      /\bwhile\s*\(/.test(line) ||
      /\bfor\s+of\b/.test(line) ||
      /\bfor\s+in\b/.test(line)
    ) {
      signals.iterates = true;
    }

    // Transform patterns
    if (
      /\.map\s*\(/.test(line) ||
      /\.flatMap\s*\(/.test(line) ||
      /Object\.assign\s*\(/.test(line) ||
      /\{\.\.\./.test(line) ||
      /Array\.from\s*\(/.test(line)
    ) {
      signals.transforms = true;
    }

    // Aggregation
    if (/\.reduce\s*\(/.test(line) || /Math\.(min|max|abs)\s*\(/.test(line)) {
      signals.aggregates = true;
    }

    // Sort
    if (/\.sort\s*\(/.test(line) || /\.toSorted\s*\(/.test(line)) {
      signals.sorts = true;
    }

    // Merge
    if (
      /Object\.assign\s*\(/.test(line) ||
      /deepMerge\s*\(/i.test(line) ||
      /\{\.\.\..*,\s*\.\.\./.test(line)
    ) {
      signals.merges = true;
    }

    // Cache
    if (
      /cache\.(get|set|has)\s*\(/i.test(line) ||
      /\.memoize\s*\(/i.test(line) ||
      /new\s+WeakMap/i.test(line) ||
      /new\s+WeakRef/i.test(line)
    ) {
      signals.caches = true;
    }

    // Network I/O
    if (
      /\bfetch\s*\(/.test(line) ||
      /axios\./.test(line) ||
      /http\.request\s*\(/.test(line) ||
      /http\.get\s*\(/.test(line) ||
      /http\.post\s*\(/.test(line)
    ) {
      signals.hasNetworkIO = true;
    }

    // Filesystem I/O
    if (
      /fs\.(readFile|writeFile|appendFile|unlink|mkdir|rmdir|existsSync|readFileSync|writeFileSync)/.test(
        line,
      ) ||
      /\b(readFileSync|writeFileSync)\s*\(/.test(line)
    ) {
      signals.hasFileIO = true;
    }

    // Database I/O
    if (
      /\b(db|pool|connection|client|conn)\.(query|execute)\s*\(/.test(line) ||
      (/\.query\s*\(/.test(line) &&
        /\b(SELECT|INSERT|UPDATE|DELETE|MERGE|MATCH|CREATE)\b/i.test(line))
    ) {
      signals.hasDbIO = true;
    }

    // Events
    if (
      /\.emit\s*\(/.test(line) ||
      /\.dispatch\s*\(/.test(line) ||
      /\.trigger\s*\(/.test(line) ||
      /\.publish\s*\(/.test(line)
    ) {
      signals.emitsEvents = true;
    }
    if (
      /\.on\s*\(\s*['"`]/.test(line) ||
      /\.addEventListener\s*\(/.test(line) ||
      /\.subscribe\s*\(/.test(line)
    ) {
      signals.registersListeners = true;
    }

    // Early returns
    if (/^\s*return\b/.test(rawLine)) signals.earlyReturns++;

    // Switch/chain detection
    if (/\bswitch\s*\(/.test(line)) signals.switchOrChain = true;
    if (/\belse\s+if\b/.test(line)) elseIfCount++;

    // Recursion: body calls own name
    if (nameRegex.test(line)) signals.recursion = true;

    // Track call targets for delegation detection
    const callMatch = line.match(
      /(?:this\.)?([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*)\s*\(/,
    );
    if (
      callMatch &&
      !/^(function |const |if |while |for |switch )/.test(line)
    ) {
      const target = callMatch[1];
      if (!SKIP_CALLS.has(target)) {
        callCounts.set(target, (callCounts.get(target) ?? 0) + 1);
      }
    }
  }

  // Switch/chain: flag if >2 else-if branches
  if (elseIfCount > 2) signals.switchOrChain = true;

  // Delegation: if one call dominates a short body AND no more-specific
  // behavioral signal was detected (otherwise .map/.sort/.forEach etc.
  // would be misclassified as delegation).
  const hasSpecificSignal =
    signals.iterates ||
    signals.transforms ||
    signals.aggregates ||
    signals.sorts ||
    signals.merges ||
    signals.caches ||
    signals.hasNetworkIO ||
    signals.hasFileIO ||
    signals.hasDbIO ||
    signals.emitsEvents ||
    signals.registersListeners ||
    signals.recursion ||
    signals.validates;
  if (callCounts.size > 0 && lines.length <= 10 && !hasSpecificSignal) {
    const totalCalls = [...callCounts.values()].reduce((a, b) => a + b, 0);
    const [topTarget, topCount] = [...callCounts.entries()].sort(
      (a, b) => b[1] - a[1],
    )[0];
    if (topCount >= 1 && totalCalls <= 3 && topTarget !== symbol.name) {
      signals.delegates = topTarget;
    }
  }

  return signals;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Prepends an appropriate article ("a" or "an") before the subject phrase.
 */
function prefixArticle(subject: string): string {
  const firstChar = subject.charAt(0).toLowerCase();
  const article = "aeiou".includes(firstChar) ? "an" : "a";
  return `${article} ${subject}`;
}

/**
 * Build a summary for a function/method using behavioral analysis of the function body.
 * Falls back to null instead of producing tautological name+type summaries.
 */

/**
 * Extract a richer subject than just splitting the function name.
 * Priority: return type > first meaningful param type > camelCase name parts.
 */
function extractEnrichedSubject(symbol: ExtractedSymbol): string {
  // Try return type (strip Promise<> wrapper, generics)
  const rt = symbol.signature?.returns;
  if (
    rt &&
    rt !== "void" &&
    rt !== "unknown" &&
    rt !== "any" &&
    rt !== "undefined"
  ) {
    const promiseMatch = /^Promise<(.+)>/.exec(rt);
    const inner = promiseMatch ? promiseMatch[1] : rt;
    const unwrapped = inner
      .replace(/<[^>]+>/g, "")
      .replace(/\[\]/g, "")
      .trim();
    if (
      unwrapped &&
      unwrapped.length > 2 &&
      unwrapped.length < 40 &&
      /^[A-Z]/.test(unwrapped)
    ) {
      return splitCamelCase(unwrapped).join(" ").toLowerCase();
    }
  }

  // Try first param type if it's a domain type (PascalCase)
  const params = symbol.signature?.params ?? [];
  if (params.length > 0) {
    const firstType = params[0].type?.replace(/^:\s*/, "").trim();
    if (
      firstType &&
      /^[A-Z][a-zA-Z]+/.test(firstType) &&
      firstType.length < 30
    ) {
      const cleaned = firstType.replace(/<[^>]+>/g, "").replace(/\[\]/g, "");
      return splitCamelCase(cleaned).join(" ").toLowerCase();
    }
  }

  // No enriched subject available — return empty string.
  // The caller will fall back to restWords and set subjectIsFromName = true.
  return "";
}

/**
 * Count how many behavioral signals fired for a function body.
 */
function countActiveSignals(signals: BodySignals): number {
  let count = 0;
  if (signals.throws) count++;
  if (signals.validates) count++;
  if (signals.delegates) count++;
  if (signals.iterates) count++;
  if (signals.hasNetworkIO) count++;
  if (signals.hasFileIO) count++;
  if (signals.hasDbIO) count++;
  if (signals.transforms) count++;
  if (signals.aggregates) count++;
  if (signals.caches) count++;
  if (signals.sorts) count++;
  if (signals.merges) count++;
  if (signals.switchOrChain) count++;
  if (signals.recursion) count++;
  if (signals.emitsEvents) count++;
  if (signals.registersListeners) count++;
  return count;
}
// Built-in method names filtered from delegation summaries to avoid misleading output
const BUILTIN_DELEGATES = new Set([
  "test",
  "has",
  "get",
  "set",
  "push",
  "pop",
  "delete",
  "add",
  "next",
  "call",
  "apply",
  "bind",
  "toString",
  "valueOf",
  "then",
  "catch",
  "finally",
  "exec",
  "match",
  "replace",
  "split",
  "join",
  "includes",
  "indexOf",
  "slice",
  "keys",
  "values",
  "entries",
  "log",
  "warn",
  "error",
  "info",
  "debug",
  // Common built-in methods that produce misleading delegation summaries
  "toLowerCase",
  "toUpperCase",
  "trim",
  "startsWith",
  "endsWith",
  "concat",
  "map",
  "filter",
  "reduce",
  "forEach",
  "find",
  "findIndex",
  "some",
  "every",
  "sort",
  "reverse",
  "flat",
  "flatMap",
  "fill",
  "from",
  "of",
  "parse",
  "stringify",
  "resolve",
  "reject",
  "all",
  "race",
  "now",
  "floor",
  "ceil",
  "round",
  "max",
  "min",
  "abs",
  "random",
  "assign",
  "freeze",
  "defineProperty",
  "hasOwnProperty",
  "isArray",
  "write",
  "read",
  "close",
  "open",
  "emit",
  "on",
  "off",
  "once",
  "addEventListener",
  "removeEventListener",
  "dispatch",
  "send",
  "end",
  "destroy",
  "pipe",
  "Date.now",
  "Math.floor",
  "Math.ceil",
  "Math.round",
  "Math.max",
  "Math.min",
  "Math.abs",
  "Math.random",
  "JSON.parse",
  "JSON.stringify",
  "Object.assign",
  "Object.keys",
  "Object.values",
  "Object.entries",
  "Array.isArray",
  "Array.from",
  "console.log",
  "console.error",
  "console.warn",
  "console.debug",
  "unshift",
  "shift",
  "splice",
]);

/**
 * Generate a summary based on the function name prefix (verb).
 * Called as a fallback after behavioral signal-based templates, so only fires
 * when behavioral analysis doesn't have a more specific match.
 */
function generatePrefixSummary(
  firstWord: string,
  subject: string,
  signals: BodySignals,
  returnSuffix: string,
): string | null {
  if (firstWord === "get") {
    const ioDetail = signals.hasDbIO
      ? " from database"
      : signals.hasNetworkIO
        ? " from network"
        : signals.hasFileIO
          ? " from filesystem"
          : signals.caches
            ? " (cached)"
            : "";
    return `Retrieves ${subject}${ioDetail}${returnSuffix}`;
  }
  if (firstWord === "set") return `Sets ${subject}`;
  if (firstWord === "find") {
    const searchDetail = signals.iterates
      ? " by searching through candidates"
      : "";
    return `Finds ${subject}${searchDetail}${returnSuffix}`;
  }
  if (firstWord === "create") return `Creates a new ${subject}${returnSuffix}`;
  if (firstWord === "make") return `Constructs ${subject}${returnSuffix}`;
  if (firstWord === "build" || firstWord === "compose") {
    return `Builds ${subject}${signals.iterates ? " from components" : ""}${returnSuffix}`;
  }
  if (
    firstWord === "compute" ||
    firstWord === "calculate" ||
    firstWord === "calc"
  ) {
    return `Computes ${subject}${signals.aggregates ? " by aggregating values" : ""}${returnSuffix}`;
  }
  if (firstWord === "resolve") {
    return `Resolves ${subject}${signals.isAsync ? " asynchronously" : ""}${returnSuffix}`;
  }
  if (
    firstWord === "check" ||
    firstWord === "verify" ||
    firstWord === "assert"
  ) {
    return `Checks ${subject}${signals.throws ? ", throws on failure" : ""}${returnSuffix}`;
  }
  if (firstWord === "ensure" || firstWord === "require") {
    return `Ensures ${subject} is valid${signals.throws ? " or throws" : ""}`;
  }
  if (firstWord === "parse" || firstWord === "decode") {
    return `Parses ${subject}${signals.validates ? " with validation" : ""}${returnSuffix}`;
  }
  if (
    firstWord === "format" ||
    firstWord === "render" ||
    firstWord === "stringify"
  ) {
    return `Formats ${subject} for output${returnSuffix}`;
  }
  if (firstWord === "normalize" || firstWord === "clean") {
    return `Normalizes ${subject} to canonical form${returnSuffix}`;
  }
  if (
    firstWord === "init" ||
    firstWord === "initialize" ||
    firstWord === "setup"
  ) {
    return `Initializes ${subject}`;
  }
  if (firstWord === "register" || firstWord === "subscribe") {
    return `Registers ${subject}${signals.registersListeners ? " as event listener" : ""}`;
  }
  if (
    firstWord === "remove" ||
    firstWord === "delete" ||
    firstWord === "destroy" ||
    firstWord === "unregister"
  ) {
    return `Removes ${subject}`;
  }
  if (firstWord === "update" || firstWord === "patch") {
    return `Updates ${subject}${signals.hasDbIO ? " in database" : ""}`;
  }
  if (firstWord === "load" || firstWord === "read" || firstWord === "fetch") {
    const ioDetail = signals.hasDbIO
      ? " from database"
      : signals.hasNetworkIO
        ? " from network"
        : signals.hasFileIO
          ? " from disk"
          : "";
    return `Loads ${subject}${ioDetail}${returnSuffix}`;
  }
  if (
    firstWord === "save" ||
    firstWord === "write" ||
    firstWord === "store" ||
    firstWord === "persist"
  ) {
    const ioDetail = signals.hasDbIO
      ? " to database"
      : signals.hasFileIO
        ? " to disk"
        : "";
    return `Saves ${subject}${ioDetail}`;
  }
  if (
    firstWord === "emit" ||
    firstWord === "fire" ||
    firstWord === "dispatch" ||
    firstWord === "publish" ||
    firstWord === "send" ||
    firstWord === "notify"
  ) {
    return `Emits ${subject} event`;
  }
  if (
    firstWord === "map" ||
    firstWord === "convert" ||
    firstWord === "transform"
  ) {
    return `Transforms ${subject}${returnSuffix}`;
  }
  if (
    firstWord === "filter" ||
    firstWord === "select" ||
    firstWord === "exclude"
  ) {
    return `Filters ${subject}${signals.iterates ? " from collection" : ""}${returnSuffix}`;
  }
  if (firstWord === "sort" || firstWord === "order" || firstWord === "rank") {
    return `Sorts ${subject}${returnSuffix}`;
  }
  if (
    firstWord === "merge" ||
    firstWord === "combine" ||
    firstWord === "join" ||
    firstWord === "concat"
  ) {
    return `Merges ${subject}${returnSuffix}`;
  }
  if (
    firstWord === "split" ||
    firstWord === "separate" ||
    firstWord === "partition"
  ) {
    return `Splits ${subject}${returnSuffix}`;
  }
  if (firstWord === "validate" || firstWord === "sanitize") {
    return `Validates ${subject}${signals.throws ? ", throws on invalid input" : ""}${returnSuffix}`;
  }
  if (firstWord === "extract" || firstWord === "derive") {
    return `Extracts ${subject}${returnSuffix}`;
  }
  if (
    firstWord === "apply" ||
    firstWord === "execute" ||
    firstWord === "run" ||
    firstWord === "invoke"
  ) {
    return `Executes ${subject}${signals.isAsync ? " asynchronously" : ""}`;
  }
  if (
    firstWord === "enable" ||
    firstWord === "activate" ||
    firstWord === "start"
  ) {
    return `Enables ${subject}`;
  }
  if (
    firstWord === "disable" ||
    firstWord === "deactivate" ||
    firstWord === "stop"
  ) {
    return `Disables ${subject}`;
  }
  if (firstWord === "reset") return `Resets ${subject} to initial state`;
  if (firstWord === "clear" || firstWord === "flush" || firstWord === "purge") {
    return `Clears ${subject}`;
  }
  if (firstWord === "compare" || firstWord === "diff") {
    return `Compares ${subject}${returnSuffix}`;
  }
  if (
    firstWord === "count" ||
    firstWord === "measure" ||
    firstWord === "estimate"
  ) {
    return `Counts ${subject}${returnSuffix}`;
  }
  if (firstWord === "log" || firstWord === "trace" || firstWord === "record") {
    return `Records ${subject}`;
  }
  if (
    firstWord === "clone" ||
    firstWord === "copy" ||
    firstWord === "duplicate"
  ) {
    return `Creates a copy of ${subject}${returnSuffix}`;
  }
  if (firstWord === "await" || firstWord === "wait") {
    return `Waits for ${subject} to complete${returnSuffix}`;
  }
  return null;
}

function generateBehavioralFunctionSummary(
  symbol: ExtractedSymbol,
  fileContent: string,
): string | null {
  const signals = analyzeBodyPatterns(symbol, fileContent);
  const words = splitCamelCase(symbol.name);
  const firstWord = words[0]?.toLowerCase() ?? "";
  const restWords = words.slice(1).map((w) => w.toLowerCase());

  // For "handle*" functions, use the rest as a noun phrase describing what's handled
  const HANDLER_PREFIXES = new Set(["handle", "process", "on"]);
  const isHandler = HANDLER_PREFIXES.has(firstWord);
  const enrichedSubject = extractEnrichedSubject(symbol);
  const subject = enrichedSubject || restWords.join(" ");
  const subjectIsFromName = !enrichedSubject;

  // 0. Handler pattern — use "Handles X" with behavioral detail suffix
  if (isHandler && subject) {
    const details: string[] = [];
    if (signals.validates) details.push("with validation");
    if (signals.transforms) details.push("with transformation");
    if (signals.hasDbIO) details.push("via database");
    if (signals.hasNetworkIO) details.push("via network");
    if (signals.hasFileIO) details.push("via filesystem");
    if (signals.caches) details.push("with caching");
    const suffix =
      details.length > 0 ? " " + details.slice(0, 2).join(" and ") : "";
    return `Handles ${subject}${suffix}`;
  }

  // 0a. Prefix-based semantic patterns for common naming conventions
  const returnType = symbol.signature?.returns;
  const returnSuffix =
    returnType &&
    returnType !== "void" &&
    returnType !== "any" &&
    returnType !== "unknown"
      ? `. Returns ${returnType}`
      : "";

  if (firstWord === "is" && subject) {
    // "isWindowsPathLike" → "Returns true if the value is a windows path like"
    const detail = signals.validates ? " (with validation guards)" : "";
    return `Returns true if the value is ${prefixArticle(subject)}${detail}${returnSuffix}`;
  }

  if (firstWord === "has" && subject) {
    return `Checks whether ${subject} exists or is present${returnSuffix}`;
  }

  if (firstWord === "to" && subject) {
    // "toAbsolutePath" → "Converts input to absolute path"
    const inputHint = symbol.signature?.params?.[0]?.type
      ?.replace(/^:\s*/, "")
      .trim();
    const fromPart =
      inputHint && inputHint !== "any" && inputHint !== "unknown"
        ? ` ${inputHint}`
        : " input";
    return `Converts${fromPart} to ${subject}${returnSuffix}`;
  }

  // Fix A: Multi-signal composite summaries for complex functions
  // When 3+ behavioral signals fire, combine them instead of picking one
  const activeCount = countActiveSignals(signals);
  const bodyLength = symbol.range.endLine - symbol.range.startLine;

  if (activeCount >= 3 && subject) {
    const phrases: string[] = [];
    if (signals.hasDbIO) phrases.push("queries database");
    if (signals.hasNetworkIO) phrases.push("calls network");
    if (signals.hasFileIO) phrases.push("accesses filesystem");
    if (signals.validates) phrases.push("validates input");
    if (signals.aggregates) phrases.push("aggregates results");
    if (signals.transforms) phrases.push("transforms data");
    if (signals.iterates && !signals.transforms)
      phrases.push("iterates elements");
    if (signals.sorts) phrases.push("sorts output");
    if (signals.merges) phrases.push("merges data");
    if (signals.caches) phrases.push("with caching");
    if (signals.recursion) phrases.push("recursively");
    if (signals.switchOrChain) phrases.push("with branching");
    if (signals.emitsEvents) phrases.push("emits events");
    if (phrases.length >= 2) {
      return `Processes ${subject}: ${phrases.slice(0, 3).join(", ")}`;
    }
  }

  // Length gate: functions >100 lines with only 1 generic signal
  // should return null — the name alone is more honest than a vague summary
  if (bodyLength > 100 && activeCount <= 1) {
    return null;
  }
  // Template priority (first match wins):

  // 1. Delegation (filter out common built-in method names that produce misleading summaries)
  if (signals.delegates && !BUILTIN_DELEGATES.has(signals.delegates)) {
    return subject
      ? `Delegates to ${signals.delegates} for ${subject}`
      : `Delegates to ${signals.delegates}`;
  }

  // 2. Validation
  if (
    signals.validates &&
    !signals.iterates &&
    !signals.transforms &&
    !signals.recursion
  ) {
    const throwClause = signals.throws ? ", throws on failure" : "";
    if (subject && !subjectIsFromName) {
      return `Validates ${subject}${throwClause}`;
    }
    // Fall through to prefix-based patterns (e.g. "validate*" name prefix)
  }

  // 3. I/O patterns
  if (signals.hasNetworkIO) {
    return subject && !subjectIsFromName
      ? `Fetches ${subject} via network`
      : "Performs network request";
  }
  if (signals.hasFileIO) {
    return subject && !subjectIsFromName
      ? `Reads/writes ${subject} on disk`
      : "Performs filesystem I/O";
  }
  if (signals.hasDbIO) {
    return subject && !subjectIsFromName
      ? `Queries ${subject} from database`
      : "Performs database query";
  }

  // 4. Cache
  if (signals.caches) {
    return subject && !subjectIsFromName ? `Caches ${subject}` : null;
  }

  // 5. Events
  if (signals.emitsEvents) {
    return subject && !subjectIsFromName ? `Emits ${subject} event` : null;
  }
  if (signals.registersListeners) {
    return subject && !subjectIsFromName ? `Subscribes to ${subject}` : null;
  }

  // 6. Aggregation
  if (signals.aggregates && !signals.transforms) {
    return subject && !subjectIsFromName ? `Aggregates ${subject}` : null;
  }

  // 7. Transform
  if (signals.transforms && signals.iterates) {
    return subject && !subjectIsFromName ? `Transforms each ${subject}` : null;
  }
  if (signals.transforms && !signals.iterates) {
    return subject && !subjectIsFromName ? `Transforms ${subject}` : null;
  }

  // 8. Sort
  if (signals.sorts) {
    return subject && !subjectIsFromName ? `Sorts ${subject}` : null;
  }

  // 9. Merge
  if (signals.merges) {
    return subject && !subjectIsFromName ? `Merges ${subject}` : null;
  }

  // 10. Dispatch/routing
  if (signals.switchOrChain && signals.earlyReturns > 3) {
    return subject && !subjectIsFromName
      ? `Dispatches ${subject} across branches`
      : "Routes by condition";
  }

  // 11. Recursion
  if (signals.recursion) {
    return subject && !subjectIsFromName
      ? `Recursively processes ${subject}`
      : "Recursive computation";
  }

  // 12. Iteration without transform
  if (signals.iterates && !signals.transforms) {
    return subject && !subjectIsFromName ? `Iterates over ${subject}` : null;
  }

  // 13. Throws without validation context
  if (signals.throws && subject && !subjectIsFromName) {
    return `Validates ${subject}, throws on failure`;
  }

  // If no behavioral signals fired, a type-signature summary is tautological
  if (activeCount === 0) {
    return null;
  }

  // 14. Action-verb prefix patterns — provide semantic summaries when behavioral
  // templates above didn't produce a match. Only fires when at least one
  // behavioral signal exists (empty-body functions return null above).
  if (subject) {
    const prefixSummary = generatePrefixSummary(
      firstWord,
      subject,
      signals,
      returnSuffix,
    );
    if (prefixSummary !== null) {
      return prefixSummary;
    }
  }

  // DF-1: For functions with typed params/returns, include type info instead of null
  if (symbol.signature?.params && symbol.signature.params.length > 0) {
    const paramTypes = symbol.signature.params
      .filter((p) => p.type && p.type !== ": any" && p.type !== ": unknown")
      .map((p) => `${p.name}${p.type}`)
      .slice(0, 3);
    const returnInfo =
      symbol.signature.returns && symbol.signature.returns !== "void"
        ? ` → ${symbol.signature.returns}`
        : "";
    if (paramTypes.length > 0 || returnInfo) {
      const desc = subject || words.join(" ").toLowerCase();
      if (desc && desc.length >= 3) {
        const paramStr =
          paramTypes.length > 0 ? ` (${paramTypes.join(", ")})` : "";
        return `${desc.charAt(0).toUpperCase() + desc.slice(1)}${paramStr}${returnInfo}`;
      }
    }
  }

  // NO MATCH: return null (better than a tautological name+type restatement)
  return null;
}

function generateClassSummary(symbol: ExtractedSymbol): string | null {
  const name = symbol.name;
  for (const [suffix, role] of ROLE_SUFFIXES) {
    if (name.endsWith(suffix) && name.length > suffix.length) {
      const base = splitCamelCase(name.slice(0, -suffix.length))
        .join(" ")
        .toLowerCase();
      return `Implements the ${role} pattern for ${base}`;
    }
  }
  if (symbol.signature?.generics && symbol.signature.generics.length > 0) {
    const typeParams = symbol.signature.generics.join(", ");
    const base = splitCamelCase(name).join(" ").toLowerCase();
    return `Generic ${base} class parameterized by ${typeParams}`;
  }
  // Avoid tautological summary; name alone is better than noise
  const classParams = symbol.signature?.params;
  if (classParams && classParams.length > 0) {
    const paramNames = classParams.map((p) => p.name).join(", ");
    return `Manages ${splitCamelCase(name).join(" ").toLowerCase()} state (params: ${paramNames})`;
  }
  return null;
}

function generateInterfaceSummary(symbol: ExtractedSymbol): string | null {
  const name = symbol.name;
  if (
    name.length > 1 &&
    name[0] === "I" &&
    name[1] === name[1].toUpperCase() &&
    /[A-Z]/.test(name[1])
  ) {
    const base = splitCamelCase(name.slice(1)).join(" ").toLowerCase();
    return `Contract for ${base}`;
  }
  for (const [suffix, desc] of SUFFIX_PATTERNS) {
    if (name.endsWith(suffix) && name.length > suffix.length) {
      const base = splitCamelCase(name.slice(0, -suffix.length))
        .join(" ")
        .toLowerCase();
      return `${desc} for ${base}`;
    }
  }
  if (symbol.signature?.generics && symbol.signature.generics.length > 0) {
    const typeParams = symbol.signature.generics.join(", ");
    const base = splitCamelCase(name).join(" ").toLowerCase();
    return `Generic interface defining ${base} contract for ${typeParams}`;
  }
  // Suppress tautological summary; name alone is clearer
  return null;
}

function generateTypeSummary(symbol: ExtractedSymbol): string | null {
  const name = symbol.name;
  for (const [suffix, desc] of SUFFIX_PATTERNS) {
    if (name.endsWith(suffix) && name.length > suffix.length) {
      const base = splitCamelCase(name.slice(0, -suffix.length))
        .join(" ")
        .toLowerCase();
      return `${desc} for ${base}`;
    }
  }
  if (symbol.signature?.generics && symbol.signature.generics.length > 0) {
    const typeParams = symbol.signature.generics.join(", ");
    const base = splitCamelCase(name).join(" ").toLowerCase();
    return `Generic type alias for ${base} over ${typeParams}`;
  }
  const words = splitCamelCase(name).join(" ").toLowerCase();
  return `Type alias for ${words}`;
}

function generateVariableSummary(symbol: ExtractedSymbol): string | null {
  const name = symbol.name;
  if (/^[A-Z][A-Z0-9_]+$/.test(name)) {
    return `Constant defining ${splitSnakeCase(name)}`;
  }
  if (name.endsWith("Schema") && name.length > 6) {
    const base = splitCamelCase(name.slice(0, -6)).join(" ").toLowerCase();
    return `Validation schema for ${base}`;
  }
  if (name.endsWith("Validator") && name.length > 9) {
    const base = splitCamelCase(name.slice(0, -9)).join(" ").toLowerCase();
    return `Validator for ${base}`;
  }
  if (/^[Dd]efault/.test(name)) {
    const rest = name.replace(/^[Dd]efault_?/, "");
    if (rest.length > 0) {
      const words = splitCamelCase(rest).join(" ").toLowerCase();
      return `Default ${words} value`;
    }
  }
  return null;
}

function generateConstructorSummary(_symbol: ExtractedSymbol): string | null {
  // Constructor type info is already on the card's signature.
  // Returning null avoids tautological "Constructs from TypeA and TypeB" summaries.
  return null;
}

/**
 * Detects whether a summary is just a reformatted version of the symbol name.
 * Used to clear stale name-only summaries during incremental reindexing.
 */
const NAME_ONLY_NOISE = new Set([
  "class",
  "interface",
  "for",
  "type",
  "alias",
  "returning",
  "by",
  "with",
  "from",
  "at",
  "and",
  "returns",
  "constructs",
  "defining",
  "contract",
  "behavior",
  "encapsulating",
  "pattern",
  "implements",
  "the",
  "a",
  "an",
  "of",
  "to",
  "in",
  "on",
]);

const TYPE_NOISE = new Set([
  "string",
  "number",
  "boolean",
  "object",
  "array",
  "map",
  "set",
  "promise",
  "partial",
  "readonly",
  "record",
  "void",
  "null",
  "undefined",
  "any",
  "unknown",
  "mixed",
  "never",
  "bigint",
]);

export function isNameOnlySummary(
  summary: string,
  symbolName: string,
): boolean {
  // Remove structural noise words BEFORE deconjugation (so "alias" isn't stemmed to "alia")

  const rawSummaryWords = summary.toLowerCase().split(/\s+/).filter(Boolean);
  const meaningful = rawSummaryWords
    .filter((w) => !NAME_ONLY_NOISE.has(w))
    .map(deconjugate);

  const nameWords = new Set(
    splitCamelCase(symbolName).map((w) => deconjugate(w.toLowerCase())),
  );

  if (meaningful.length === 0 || nameWords.size === 0) return true;

  let overlap = 0;
  for (const word of meaningful) {
    if (nameWords.has(word)) overlap++;
  }
  if (overlap / meaningful.length >= 0.8) return true;

  // Detect "name words + type noise" pattern (e.g. "Builds tool from string and Partial")
  const meaningfulWithoutTypes = meaningful.filter((w) => !TYPE_NOISE.has(w));

  if (meaningfulWithoutTypes.length > 0) {
    let overlapNoTypes = 0;
    for (const word of meaningfulWithoutTypes) {
      if (nameWords.has(word)) overlapNoTypes++;
    }
    if (overlapNoTypes / meaningfulWithoutTypes.length >= 0.8) return true;
  } else {
    // ALL meaningful words were either name words or type noise
    return true;
  }

  return false;
}

function deconjugate(word: string): string {
  const reverseIrregulars: Record<string, string> = {
    gets: "get",
    sets: "set",
    does: "do",
    runs: "run",
    goes: "go",
    checks: "check",
    determines: "determine",
    handles: "handle",
  };
  if (reverseIrregulars[word]) return reverseIrregulars[word];
  if (word.endsWith("ies") && word.length > 4) return word.slice(0, -3) + "y";
  // For -es endings: sibilants lose -es (pushes→push), others lose just -s (creates→create)
  if (
    word.endsWith("sses") ||
    word.endsWith("zes") ||
    word.endsWith("xes") ||
    word.endsWith("shes") ||
    word.endsWith("ches")
  ) {
    return word.slice(0, -2);
  }
  if (word.endsWith("s") && !word.endsWith("ss") && word.length > 2)
    return word.slice(0, -1);
  return word;
}

export function extractInvariants(
  symbol: ExtractedSymbol,
  fileContent: string,
): string[] {
  const invariants: string[] = [];

  const jsdoc = extractJSDoc(symbol, fileContent);

  for (const param of jsdoc.params) {
    if (
      param.description.toLowerCase().includes("must") ||
      param.description.toLowerCase().includes("required") ||
      param.description.toLowerCase().includes("should be") ||
      param.description.toLowerCase().includes("cannot be")
    ) {
      invariants.push(`@param ${param.name}: ${param.description}`);
    }
  }

  for (const throws of jsdoc.throws) {
    invariants.push(`@throws ${throws}`);
  }

  const lines = getSymbolLines(symbol, fileContent);

  for (const line of lines) {
    if (line.includes("assert(")) {
      const match = line.match(/assert\(([^)]+)\)/);
      if (match) {
        invariants.push(`Asserts: ${match[1]}`);
      }
    }

    if (line.includes("if (!") || line.includes("if (! ")) {
      const match = line.match(/if\s*\(!([^)]+)\)\s*(?:\{|throw|return)/);
      if (match) {
        invariants.push(`Requires: ${match[1].trim()}`);
      }
    }

    if (
      line.includes("if (") &&
      (line.includes("throw new") || line.includes("return false"))
    ) {
      const match = line.match(/if\s*\(([^)]+)\)\s*(?:\{|throw|return)/);
      if (match) {
        const condition = match[1].trim();
        if (
          condition.includes("!") ||
          condition.includes("undefined") ||
          condition.includes("null")
        ) {
          invariants.push(`Requires: ${condition}`);
        }
      }
    }
  }

  return [...new Set(invariants)];
}

export function extractSideEffects(
  symbol: ExtractedSymbol,
  fileContent: string,
): string[] {
  const sideEffects: string[] = [];
  const lines = getSymbolLines(symbol, fileContent);

  const networkPatterns = [
    /fetch\s*\(/,
    /axios\./,
    /http\.request\s*\(/,
    /http\.get\s*\(/,
    /http\.post\s*\(/,
    /XMLHttpRequest/,
  ];

  const filesystemPatterns = [
    /fs\.readFile/,
    /fs\.writeFile/,
    /fs\.appendFile/,
    /fs\.unlink/,
    /fs\.mkdir/,
    /fs\.rmdir/,
    /fs\.existsSync/,
    /fs\.readFileSync/,
    /fs\.writeFileSync/,
    /readFileSync/,
    /writeFileSync/,
  ];

  const databasePatterns = [
    /db\.query\s*\(/,
    /db\.execute\s*\(/,
    /pool\.query\s*\(/,
    /pool\.execute\s*\(/,
    /connection\.query/,
    /connection\.execute/,
    /client\.query/,
    /\.query\s*\(/,
  ];

  const globalStatePatterns = [
    /globalThis\./,
    /window\./,
    /document\./,
    /localStorage\./,
    /sessionStorage\./,
    /process\./,
  ];

  const envPatterns = [/process\.env/, /process\.cwd/, /import\.meta\.env/];

  for (const line of lines) {
    for (const pattern of networkPatterns) {
      if (pattern.test(line)) {
        sideEffects.push("Network I/O");
        break;
      }
    }

    for (const pattern of filesystemPatterns) {
      if (pattern.test(line)) {
        sideEffects.push("Filesystem I/O");
        break;
      }
    }

    for (const pattern of databasePatterns) {
      if (pattern.test(line)) {
        sideEffects.push("Database query");
        break;
      }
    }

    for (const pattern of globalStatePatterns) {
      if (pattern.test(line) && !line.includes("//") && !line.includes("/*")) {
        if (
          line.includes("window.") &&
          !line.includes("window.addEventListener")
        ) {
          sideEffects.push("Global state mutation (window)");
        } else if (line.includes("document.") && line.includes("=")) {
          sideEffects.push("DOM mutation");
        } else if (
          line.includes("globalThis.") ||
          line.includes("localStorage.") ||
          line.includes("sessionStorage.")
        ) {
          sideEffects.push("Global state mutation");
        }
        break;
      }
    }

    for (const pattern of envPatterns) {
      if (pattern.test(line)) {
        sideEffects.push("Environment access");
        break;
      }
    }
  }

  return [...new Set(sideEffects)];
}

interface JSDoc {
  description: string;
  params: Array<{ name: string; description: string }>;
  returns: string;
  throws: string[];
}

function extractJSDoc(symbol: ExtractedSymbol, fileContent: string): JSDoc {
  const lines = fileContent.split("\n");
  const startLine = symbol.range.startLine;

  const jsdocLines: string[] = [];
  let i = startLine - 2;

  while (i >= 0 && i < lines.length) {
    const line = lines[i].trim();

    if (line.startsWith("/**")) {
      jsdocLines.unshift(line);
      break;
    }

    if (line.startsWith("*") || line.startsWith("*/")) {
      jsdocLines.unshift(line);
      i--;
      continue;
    }

    if (line.length === 0) {
      i--;
      continue;
    }

    break;
  }

  const jsdocText = jsdocLines
    .map((l) =>
      l
        .replace(/^\s*\/\*\*?/, "")
        .replace(/\s*\*\/$/, "")
        .replace(/^\s*\*\s?/, ""),
    )
    .join("\n");

  const jsdoc: JSDoc = {
    description: "",
    params: [],
    returns: "",
    throws: [],
  };

  let currentSection: "description" | "param" | "returns" | "throws" =
    "description";
  const lines_ = jsdocText.split("\n");

  for (const line of lines_) {
    const trimmed = line.trim();

    if (trimmed.startsWith("@param")) {
      currentSection = "param";
      const match = trimmed.match(/@param\s+(\{[^}]+\})?\s*(\w+)\s+(.+)/);
      if (match) {
        jsdoc.params.push({ name: match[2], description: match[3].trim() });
      }
    } else if (
      trimmed.startsWith("@returns") ||
      trimmed.startsWith("@return")
    ) {
      currentSection = "returns";
      const match = trimmed.match(/@(?:returns?)\s+(.+)/);
      if (match) {
        jsdoc.returns = match[1].trim();
      }
    } else if (trimmed.startsWith("@throws")) {
      currentSection = "throws";
      const match = trimmed.match(/@throws\s+(.+)/);
      if (match) {
        jsdoc.throws.push(match[1].trim());
      }
    } else if (trimmed.startsWith("@")) {
      currentSection = "description";
    } else if (currentSection === "description" && trimmed) {
      jsdoc.description += (jsdoc.description ? " " : "") + trimmed;
    }
  }

  return jsdoc;
}

export function splitCamelCase(str: string): string[] {
  // Split on underscores, hyphens, dots first
  const segments = str.split(/[_\-\.]+/).filter(Boolean);
  const result: string[] = [];

  for (const segment of segments) {
    // Split camelCase and PascalCase with proper acronym handling
    // "MCPServer" → ["MCP", "Server"], "buildSlice" → ["build", "Slice"]
    const words = segment.match(
      /[A-Z]+\d+[A-Z]+(?=[A-Z][a-z]|[^a-zA-Z0-9]|$)|[A-Z]{2,}(?=[A-Z][a-z]|$)|[A-Z]?[a-z]+|[A-Z]+|[0-9]+/g,
    );
    if (words) {
      result.push(...words);
    } else {
      result.push(segment);
    }
  }

  return result;
}

export function getSummaryQuality(
  summary: string | null,
  source:
    | "jsdoc"
    | "llm"
    | "nn-direct"
    | "nn-adapted"
    | "heuristic-body"
    | "heuristic-typed"
    | "heuristic-fallback"
    | "unknown",
): number {
  if (!summary) return 0.0;
  switch (source) {
    case "jsdoc":
      return 1.0;
    case "llm":
      return 0.8;
    case "nn-direct":
      return 0.6;
    case "nn-adapted":
      return 0.5;
    case "heuristic-body":
      return 0.55;
    case "heuristic-typed":
      return 0.4;
    case "heuristic-fallback":
      return 0.3;
    default:
      return 0.0;
  }
}

const BODY_TEMPLATE_PREFIXES = [
  "Delegates to",
  "Validates",
  "Fetches",
  "Caches",
  "Emits",
  "Aggregates",
  "Transforms",
  "Sorts",
  "Merges",
  "Dispatches",
  "Recursively",
  "Iterates over",
  "Reads/writes",
  "Performs",
  "Subscribes to",
  "Routes by",
  "Memoizes",
  "Queries",
  "Registers event",
];

export function classifySummarySource(
  summary: string | null,
  hadJSDoc: boolean,
  symbolKind: string,
):
  | "jsdoc"
  | "heuristic-body"
  | "heuristic-typed"
  | "heuristic-fallback"
  | "unknown" {
  if (!summary) return "unknown";
  if (hadJSDoc) return "jsdoc";
  // Detect body-derived behavioral templates
  if (
    (symbolKind === "function" || symbolKind === "method") &&
    BODY_TEMPLATE_PREFIXES.some((p) => summary.startsWith(p))
  ) {
    return "heuristic-body";
  }
  if (symbolKind === "function" || symbolKind === "method") {
    return "heuristic-typed";
  }
  return "heuristic-fallback";
}

/**
 * Returns true if the symbol has a JSDoc/doc-comment that extractJSDoc can parse.
 * Used by process-file to determine summarySource classification.
 */
export function hasJSDoc(
  symbol: ExtractedSymbol,
  fileContent: string,
): boolean {
  const jsdoc = extractJSDoc(symbol, fileContent);
  return jsdoc.description.length > 0;
}

function getSymbolLines(
  symbol: ExtractedSymbol,
  fileContent: string,
): string[] {
  const lines = fileContent.split("\n");
  const startIndex = Math.max(0, symbol.range.startLine - 1);
  const endIndex = Math.min(lines.length, symbol.range.endLine);
  return lines.slice(startIndex, endIndex);
}
