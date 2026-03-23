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
      return generateTypedFunctionSummary(symbol);
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
 * Build a summary for a function/method using typed params and return type.
 * Returns null if no type information is available (the name alone is on the card).
 */
function generateTypedFunctionSummary(symbol: ExtractedSymbol): string | null {
  const params = symbol.signature?.params ?? [];
  const typedParams = params
    .filter((p) => p.type && !p.name.startsWith("..."))
    .map((p) => extractSimpleType(p.type!))
    .filter(
      (t) =>
        t !== "" && t !== "unknown" && t !== "any" && t !== "object" && t !== "Object",
    );

  const returnType = symbol.signature?.returns
    ? extractSimpleType(symbol.signature.returns)
    : null;
  const hasReturn =
    returnType != null &&
    returnType !== "void" &&
    returnType !== "unknown" &&
    returnType !== "any";

  if (typedParams.length === 0 && !hasReturn) {
    return null;
  }

  const words = splitCamelCase(symbol.name);
  const verb = verbify(words[0]);
  const subject = words
    .slice(1)
    .map((w) => w.toLowerCase())
    .join(" ");
  let summary = subject ? `${verb} ${subject}` : verb;

  if (typedParams.length > 0) {
    const unique = [...new Set(typedParams)];
    summary += ` from ${unique.join(" and ")}`;
  }
  if (hasReturn) {
    summary += ` returning ${returnType}`;
  }
  return summary;
}

function generateClassSummary(symbol: ExtractedSymbol): string | null {
  const name = symbol.name;
  for (const [suffix, role] of ROLE_SUFFIXES) {
    if (name.endsWith(suffix) && name.length > suffix.length) {
      const base = splitCamelCase(name.slice(0, -suffix.length)).join(" ").toLowerCase();
      return `Implements the ${role} pattern for ${base}`;
    }
  }
  if (symbol.signature?.generics && symbol.signature.generics.length > 0) {
    const typeParams = symbol.signature.generics.join(", ");
    const base = splitCamelCase(name).join(" ").toLowerCase();
    return `Generic ${base} class parameterized by ${typeParams}`;
  }
  const words = splitCamelCase(name).join(" ").toLowerCase();
  return `Class encapsulating ${words} behavior`;
}

function generateInterfaceSummary(symbol: ExtractedSymbol): string | null {
  const name = symbol.name;
  if (name.length > 1 && name[0] === "I" && name[1] === name[1].toUpperCase() && /[A-Z]/.test(name[1])) {
    const base = splitCamelCase(name.slice(1)).join(" ").toLowerCase();
    return `Contract for ${base}`;
  }
  for (const [suffix, desc] of SUFFIX_PATTERNS) {
    if (name.endsWith(suffix) && name.length > suffix.length) {
      const base = splitCamelCase(name.slice(0, -suffix.length)).join(" ").toLowerCase();
      return `${desc} for ${base}`;
    }
  }
  if (symbol.signature?.generics && symbol.signature.generics.length > 0) {
    const typeParams = symbol.signature.generics.join(", ");
    const base = splitCamelCase(name).join(" ").toLowerCase();
    return `Generic interface defining ${base} contract for ${typeParams}`;
  }
  const words = splitCamelCase(name).join(" ").toLowerCase();
  return `Interface defining ${words} contract`;
}

function generateTypeSummary(symbol: ExtractedSymbol): string | null {
  const name = symbol.name;
  for (const [suffix, desc] of SUFFIX_PATTERNS) {
    if (name.endsWith(suffix) && name.length > suffix.length) {
      const base = splitCamelCase(name.slice(0, -suffix.length)).join(" ").toLowerCase();
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

function generateConstructorSummary(symbol: ExtractedSymbol): string | null {
  const params = symbol.signature?.params;
  if (!params || params.length === 0) return null;
  const typedParams = params.filter((p) => p.type && p.type !== "any" && p.type !== "unknown");
  if (typedParams.length === 0) return null;
  const typeContext = typedParams
    .map((p) => extractSimpleType(p.type!))
    .filter(Boolean)
    .join(" and ");
  if (!typeContext) return null;
  return `Constructs from ${typeContext}`;
}

/**
 * Detects whether a summary is just a reformatted version of the symbol name.
 * Used to clear stale name-only summaries during incremental reindexing.
 */
const NAME_ONLY_NOISE = new Set([
  "class", "interface", "for", "type", "alias",
  "returning", "by", "with", "from", "at", "and", "returns",
]);

export function isNameOnlySummary(
  summary: string,
  symbolName: string,
): boolean {
  // Remove structural noise words BEFORE deconjugation (so "alias" isn't stemmed to "alia")


  const rawSummaryWords = summary
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
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
  return overlap / meaningful.length > 0.8;
}

function deconjugate(word: string): string {
  const reverseIrregulars: Record<string, string> = {
    gets: "get", sets: "set", does: "do", runs: "run", goes: "go",
    checks: "check", determines: "determine", handles: "handle",
  };
  if (reverseIrregulars[word]) return reverseIrregulars[word];
  if (word.endsWith("ies") && word.length > 4)
    return word.slice(0, -3) + "y";
  // For -es endings: sibilants lose -es (pushes→push), others lose just -s (creates→create)
  if (word.endsWith("sses") || word.endsWith("zes") || word.endsWith("xes") ||
      word.endsWith("shes") || word.endsWith("ches")) {
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


function verbify(word: string): string {
  if (!word || word.length === 0) return "Handles";
  const lower = word.toLowerCase();
  // Common irregular verbs in code
  const irregulars: Record<string, string> = {
    get: "Gets", set: "Sets", is: "Checks if", has: "Checks for",
    can: "Checks if can", should: "Determines if should",
    do: "Does", run: "Runs", go: "Goes",
  };
  if (irregulars[lower]) return irregulars[lower];
  if (lower.endsWith("fy")) return capitalize(lower.slice(0, -1)) + "ies";
  if (lower.endsWith("e")) return capitalize(lower) + "s";
  if (lower.endsWith("y") && !lower.endsWith("ay") && !lower.endsWith("ey") && !lower.endsWith("oy"))
    return capitalize(lower.slice(0, -1)) + "ies";
  if (lower.endsWith("s") || lower.endsWith("sh") || lower.endsWith("ch") || lower.endsWith("x") || lower.endsWith("z"))
    return capitalize(lower) + "es";
  return capitalize(lower) + "s";
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function splitCamelCase(str: string): string[] {
  // Split on underscores, hyphens, dots first
  const segments = str.split(/[_\-\.]+/).filter(Boolean);
  const result: string[] = [];

  for (const segment of segments) {
    // Split camelCase and PascalCase with proper acronym handling
    // "MCPServer" → ["MCP", "Server"], "buildSlice" → ["build", "Slice"]
    const words = segment.match(
      /[A-Z]{2,}(?=[A-Z][a-z]|$)|[A-Z]?[a-z]+|[A-Z]+|[0-9]+/g,
    );
    if (words) {
      result.push(...words);
    } else {
      result.push(segment);
    }
  }

  return result;
}


function extractSimpleType(typeAnnotation: string): string {
  const cleaned = typeAnnotation
    .replace(/^:\s*/, "")
    .replace(/<[^>]+>/g, "")
    .trim();

  if (cleaned.includes(" | ")) {
    const types = cleaned.split(" | ").map((t) => t.trim());
    return types[0];
  }

  if (cleaned.includes("&")) {
    const types = cleaned.split("&").map((t) => t.trim());
    return types[0];
  }

  if (cleaned.includes("[]")) {
    return cleaned.replace("[]", "[]");
  }

  if (cleaned.includes("Array<")) {
    return cleaned.replace("Array<", "").replace(">", "[]");
  }

  if (cleaned.includes("Record<")) {
    return "Object";
  }

  if (cleaned.includes("Map<")) {
    return "Map";
  }

  if (cleaned.includes("Set<")) {
    return "Set";
  }

  return cleaned;
}

export function getSummaryQuality(
  summary: string | null,
  source: "jsdoc" | "llm" | "nn-direct" | "nn-adapted" | "heuristic-typed" | "heuristic-fallback" | "unknown",
): number {
  if (!summary) return 0.0;
  switch (source) {
    case "jsdoc": return 1.0;
    case "llm": return 0.8;
    case "nn-direct": return 0.6;
    case "nn-adapted": return 0.5;
    case "heuristic-typed": return 0.4;
    case "heuristic-fallback": return 0.3;
    default: return 0.0;
  }
}

export function classifySummarySource(
  summary: string | null,
  hadJSDoc: boolean,
  symbolKind: string,
): "jsdoc" | "heuristic-typed" | "heuristic-fallback" | "unknown" {
  if (!summary) return "unknown";
  if (hadJSDoc) return "jsdoc";
  if (symbolKind === "function" || symbolKind === "method" || symbolKind === "constructor") {
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
