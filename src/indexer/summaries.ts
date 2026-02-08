import { ExtractedSymbol } from "./treesitter/extractSymbols.js";

export function generateSummary(
  symbol: ExtractedSymbol,
  fileContent: string,
): string {
  const jsdoc = extractJSDoc(symbol, fileContent);

  if (jsdoc.description) {
    const sentences = jsdoc.description
      .split(/[.!?]/)
      .filter((s) => s.trim().length > 0);
    if (sentences.length > 0) {
      return sentences.slice(0, 2).join(". ").trim();
    }
  }

  const nameWords = splitCamelCase(symbol.name).join(" ");
  const capitalized = nameWords.charAt(0).toUpperCase() + nameWords.slice(1);

  let summary = capitalized;

  if (symbol.signature?.params && symbol.signature.params.length > 0) {
    const paramInfo = generateParamContext(symbol.signature.params);
    if (paramInfo) {
      summary += ` ${paramInfo}`;
    }
  }

  if (symbol.signature?.returns && symbol.kind === "function") {
    const returnType = extractSimpleType(symbol.signature.returns);
    if (returnType && returnType !== "void" && returnType !== "unknown") {
      summary += ` and returns ${returnType}`;
    }
  }

  return summary;
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
  let i = startLine - 1;

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

function splitCamelCase(str: string): string[] {
  const result: string[] = [];
  let currentWord = "";

  for (let i = 0; i < str.length; i++) {
    const char = str[i];

    if (char === "_" || char === "-" || char === ".") {
      if (currentWord) {
        result.push(currentWord);
        currentWord = "";
      }
    } else if (
      i > 0 &&
      char === char.toUpperCase() &&
      str[i - 1] !== char.toUpperCase()
    ) {
      if (currentWord) {
        result.push(currentWord);
        currentWord = char;
      } else {
        currentWord = char;
      }
    } else if (
      i > 0 &&
      char === char.toUpperCase() &&
      i < str.length - 1 &&
      str[i + 1] === str[i + 1].toLowerCase()
    ) {
      if (currentWord) {
        result.push(currentWord);
        currentWord = char;
      } else {
        currentWord = char;
      }
    } else {
      currentWord += char;
    }
  }

  if (currentWord) {
    result.push(currentWord);
  }

  return result;
}

function generateParamContext(
  params: Array<{ name: string; type?: string }>,
): string {
  if (params.length === 0) return "";

  const contextParts: string[] = [];

  for (const param of params) {
    if (param.name.startsWith("...")) {
      continue;
    }

    if (param.name.includes("Id") || param.name.includes("ID")) {
      contextParts.push(`by ${param.name.toLowerCase()}`);
    } else if (
      param.name.includes("Config") ||
      param.name.includes("Options")
    ) {
      contextParts.push(`with ${param.name.toLowerCase()}`);
    } else if (param.name.includes("Data") || param.name.includes("Input")) {
      contextParts.push(`from ${param.name.toLowerCase()}`);
    } else if (param.name.includes("Path") || param.name.includes("File")) {
      contextParts.push(`at ${param.name.toLowerCase()}`);
    }
  }

  return contextParts.join(" ");
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

function getSymbolLines(
  symbol: ExtractedSymbol,
  fileContent: string,
): string[] {
  const lines = fileContent.split("\n");
  const startIndex = Math.max(0, symbol.range.startLine - 1);
  const endIndex = Math.min(lines.length, symbol.range.endLine);
  return lines.slice(startIndex, endIndex);
}
