import { extname } from "path";

import Parser from "tree-sitter";
import type { QueryCapture, SyntaxNode, Tree } from "tree-sitter";

import {
  createQueryForExtensionOrThrow,
  parseFile as parseTypeScriptFile,
} from "../../../indexer/treesitter/tsTreesitter.js";
import {
  createQueryOrThrow,
  getParser,
  type SupportedLanguage,
} from "../../../indexer/treesitter/grammarLoader.js";
import {
  getAdapterForExtension,
  getAdapterInfo,
  getStructuralMatcherEntries,
  getStructuralMatcherForExtension,
} from "../../../indexer/adapter/registry.js";
import { ValidationError } from "../../../domain/errors.js";

export interface StructuralQueryInput {
  language?: string;
  treeSitterQuery: string;
  capture?: string;
  requiredCaptures?: Record<string, string>;
  replacement?: string;
}

export interface StructuralRange {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

export interface StructuralCapture {
  name: string;
  text: string;
  nodeType: string;
  startByte: number;
  endByte: number;
  start: number;
  end: number;
  range: StructuralRange;
}

export interface StructuralSourceEdit {
  start: number;
  end: number;
  replacement: string;
  captures: StructuralCapture[];
}

export interface IdentifierEditInput {
  content: string;
  relPath: string;
  literal: string;
  replacement: string;
  global?: boolean;
  maxMatches?: number;
}

export interface StructuralQueryCache {
  languageId?: string;
  get(relPath: string): Parser.Query | null;
}

export interface StructuralEditInput {
  content: string;
  relPath: string;
  structural: StructuralQueryInput;
  replacement?: string;
  global?: boolean;
  maxMatches?: number;
  deadlineMs?: number;
  languageIdOverride?: string;
  queryCache?: StructuralQueryCache;
}

interface BuiltInStructuralLanguage {
  publicLanguageId: string;
  grammarLanguage: SupportedLanguage;
  extensions: readonly string[];
  identifierNodeTypes: readonly string[];
}

interface StructuralLanguageDescriptor {
  publicLanguageId: string;
  extension: string;
  source: "builtin" | "plugin";
  queryCacheKey: string;
  identifierNodeTypes: ReadonlySet<string>;
  parse(content: string, relPath: string): Tree | null;
  createQuery(queryString: string): Parser.Query;
}

const STRUCTURAL_QUERY_TIMEOUT_MICROS = 250_000;
export const STRUCTURAL_QUERY_TIME_BUDGET_ERROR =
  "structural-query-time-budget";
const DEFAULT_TARGET_CAPTURE = "target";
const TREESITTER_BUFFER_SIZE = 1024 * 1024;
const DEFAULT_STRUCTURAL_MAX_MATCHES = 5_000;
const TREESITTER_QUERY_MATCH_LIMIT = 65_536;
const STRUCTURAL_QUERY_WINDOW_BYTES = 64 * 1024;
const STRUCTURAL_QUERY_WINDOW_OVERLAP_BYTES = 4 * 1024;

function assertStructuralBudget(deadlineMs: number | undefined): void {
  if (deadlineMs !== undefined && Date.now() >= deadlineMs) {
    throw new ValidationError(STRUCTURAL_QUERY_TIME_BUDGET_ERROR);
  }
}

const BUILT_IN_STRUCTURAL_LANGUAGES: readonly BuiltInStructuralLanguage[] = [
  {
    publicLanguageId: "typescript",
    grammarLanguage: "typescript",
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
    identifierNodeTypes: [
      "identifier",
      "property_identifier",
      "private_property_identifier",
      "shorthand_property_identifier",
      "type_identifier",
      "jsx_identifier",
    ],
  },
  {
    publicLanguageId: "python",
    grammarLanguage: "python",
    extensions: [".py", ".pyw"],
    identifierNodeTypes: ["identifier"],
  },
  {
    publicLanguageId: "go",
    grammarLanguage: "go",
    extensions: [".go"],
    identifierNodeTypes: [
      "identifier",
      "package_identifier",
      "type_identifier",
      "field_identifier",
    ],
  },
  {
    publicLanguageId: "java",
    grammarLanguage: "java",
    extensions: [".java"],
    identifierNodeTypes: ["identifier", "type_identifier"],
  },
  {
    publicLanguageId: "csharp",
    grammarLanguage: "csharp",
    extensions: [".cs"],
    identifierNodeTypes: ["identifier"],
  },
  {
    publicLanguageId: "c",
    grammarLanguage: "c",
    extensions: [".c", ".h"],
    identifierNodeTypes: ["identifier", "type_identifier", "field_identifier"],
  },
  {
    publicLanguageId: "cpp",
    grammarLanguage: "cpp",
    extensions: [".cc", ".cpp", ".cxx", ".hh", ".hpp", ".hxx"],
    identifierNodeTypes: [
      "identifier",
      "type_identifier",
      "namespace_identifier",
      "field_identifier",
    ],
  },
  {
    publicLanguageId: "php",
    grammarLanguage: "php",
    extensions: [".php", ".phtml"],
    identifierNodeTypes: ["name", "variable_name", "namespace_name"],
  },
  {
    publicLanguageId: "rust",
    grammarLanguage: "rust",
    extensions: [".rs"],
    identifierNodeTypes: ["identifier", "type_identifier", "field_identifier"],
  },
  {
    publicLanguageId: "kotlin",
    grammarLanguage: "kotlin",
    extensions: [".kt", ".kts"],
    identifierNodeTypes: ["simple_identifier", "type_identifier"],
  },
  {
    publicLanguageId: "shell",
    grammarLanguage: "bash",
    extensions: [".sh", ".bash", ".zsh"],
    identifierNodeTypes: ["variable_name", "command_name"],
  },
  // Lazy language-pack descriptors reuse the shared grammar loader. A pack must
  // still register or install its parser before AST-aware matching can parse it.
  {
    publicLanguageId: "powershell",
    grammarLanguage: "powershell",
    extensions: [".ps1", ".psm1", ".psd1"],
    identifierNodeTypes: [
      "variable",
      "braced_variable",
      "command_name",
      "function_name",
      "member_name",
      "simple_name",
      "type_identifier",
    ],
  },
  {
    publicLanguageId: "ruby",
    grammarLanguage: "ruby",
    extensions: [".rb", ".rake"],
    identifierNodeTypes: [
      "identifier",
      "constant",
      "instance_variable",
      "class_variable",
      "global_variable",
    ],
  },
  {
    publicLanguageId: "lua",
    grammarLanguage: "lua",
    extensions: [".lua"],
    identifierNodeTypes: ["identifier"],
  },
  {
    publicLanguageId: "dart",
    grammarLanguage: "dart",
    extensions: [".dart"],
    identifierNodeTypes: ["identifier", "type_identifier"],
  },
  {
    publicLanguageId: "swift",
    grammarLanguage: "swift",
    extensions: [".swift"],
    identifierNodeTypes: ["identifier", "simple_identifier", "type_identifier"],
  },
  {
    publicLanguageId: "groovy",
    grammarLanguage: "groovy",
    extensions: [".groovy", ".gradle", ".gvy", ".gy", ".gsh"],
    identifierNodeTypes: ["identifier", "type_identifier"],
  },
  {
    publicLanguageId: "perl",
    grammarLanguage: "perl",
    extensions: [".pl", ".pm", ".t", ".pod"],
    identifierNodeTypes: [
      "identifier",
      "bareword",
      "function",
      "varname",
      "container_variable",
      "keyval_container_variable",
    ],
  },
  {
    publicLanguageId: "r",
    grammarLanguage: "r",
    extensions: [".R", ".r"],
    identifierNodeTypes: ["identifier"],
  },
  {
    publicLanguageId: "elixir",
    grammarLanguage: "elixir",
    extensions: [".ex", ".exs"],
    identifierNodeTypes: ["identifier", "operator_identifier"],
  },
  {
    publicLanguageId: "fsharp",
    grammarLanguage: "fsharp",
    extensions: [".fs", ".fsi", ".fsx"],
    identifierNodeTypes: [
      "identifier",
      "identifier_pattern",
      "op_identifier",
      "type_name",
    ],
  },
  {
    publicLanguageId: "fortran",
    grammarLanguage: "fortran",
    extensions: [".f90", ".f95", ".f03", ".f08", ".f", ".for", ".f77"],
    identifierNodeTypes: [
      "identifier",
      "method_name",
      "module_name",
      "name",
      "type_name",
    ],
  },
  {
    publicLanguageId: "haskell",
    grammarLanguage: "haskell",
    extensions: [".hs", ".lhs"],
    identifierNodeTypes: [
      "variable",
      "constructor",
      "field_name",
      "import_name",
    ],
  },
];

const BUILT_IN_BY_EXTENSION = new Map<string, BuiltInStructuralLanguage>();
for (const descriptor of BUILT_IN_STRUCTURAL_LANGUAGES) {
  for (const extension of descriptor.extensions) {
    BUILT_IN_BY_EXTENSION.set(extension.toLowerCase(), descriptor);
  }
}

function extensionForPath(relPath: string): string {
  return extname(relPath).toLowerCase();
}

function isTypeScriptFamilyExtension(extension: string): boolean {
  return (
    BUILT_IN_BY_EXTENSION.get(extension)?.publicLanguageId === "typescript"
  );
}

function parseWithBuiltInGrammar(
  content: string,
  extension: string,
  descriptor: BuiltInStructuralLanguage,
): Tree | null {
  if (isTypeScriptFamilyExtension(extension)) {
    return parseTypeScriptFile(content, extension)?.tree ?? null;
  }

  const parser = getParser(descriptor.grammarLanguage);
  if (!parser) return null;

  try {
    const tree = parser.parse(content, undefined, {
      bufferSize: TREESITTER_BUFFER_SIZE,
    });
    return tree && !tree.rootNode.hasError ? tree : null;
  } catch {
    return null;
  }
}

function builtInDescriptorForExtension(
  extension: string,
): StructuralLanguageDescriptor | null {
  const builtIn = BUILT_IN_BY_EXTENSION.get(extension);
  if (!builtIn) return null;

  return {
    publicLanguageId: builtIn.publicLanguageId,
    extension,
    source: "builtin",
    queryCacheKey: `builtin:${builtIn.publicLanguageId}:${
      isTypeScriptFamilyExtension(extension) &&
      (extension === ".tsx" || extension === ".jsx")
        ? "tsx"
        : builtIn.grammarLanguage
    }`,
    identifierNodeTypes: new Set(builtIn.identifierNodeTypes),
    parse: (content) => parseWithBuiltInGrammar(content, extension, builtIn),
    createQuery: (queryString) =>
      isTypeScriptFamilyExtension(extension)
        ? createQueryForExtensionOrThrow(extension, queryString)
        : createQueryOrThrow(builtIn.grammarLanguage, queryString),
  };
}

function pluginDescriptorForExtension(
  extension: string,
): StructuralLanguageDescriptor | null {
  const adapterInfo = getAdapterInfo(extension);
  if (adapterInfo.source !== "plugin" || !adapterInfo.languageId) {
    return null;
  }

  const structuralMatcher = getStructuralMatcherForExtension(extension);
  const adapter = getAdapterForExtension(extension);
  if (!structuralMatcher || !adapter) return null;

  return {
    publicLanguageId: adapterInfo.languageId,
    extension,
    source: "plugin",
    queryCacheKey: `plugin:${adapterInfo.pluginName ?? "anonymous"}:${extension}`,
    identifierNodeTypes: new Set(structuralMatcher.identifierNodeTypes),
    parse: (content, relPath) => {
      const tree = adapter.parse(content, relPath);
      return tree && !tree.rootNode.hasError ? tree : null;
    },
    createQuery: structuralMatcher.createQuery,
  };
}

function descriptorForPath(
  relPath: string,
): StructuralLanguageDescriptor | null {
  const extension = extensionForPath(relPath);
  const adapterInfo = getAdapterInfo(extension);

  // If a plugin overrides an extension, the plugin must explicitly opt in to
  // structural matching. Falling back to the built-in descriptor would parse
  // with the wrong language contract.
  if (adapterInfo.source === "plugin") {
    return pluginDescriptorForExtension(extension);
  }

  return builtInDescriptorForExtension(extension);
}

export function getStructuralLanguageForPath(relPath: string): string | null {
  return descriptorForPath(relPath)?.publicLanguageId ?? null;
}

export function getStructuralLanguageIds(): string[] {
  const languageIds = new Set<string>(
    BUILT_IN_STRUCTURAL_LANGUAGES.map((language) => language.publicLanguageId),
  );
  for (const entry of getStructuralMatcherEntries()) {
    languageIds.add(entry.languageId);
  }
  return Array.from(languageIds).sort();
}

export function isStructuralLanguageSupported(languageId: string): boolean {
  return getStructuralLanguageIds().includes(languageId);
}

export function getStructuralExtensions(languageId?: string): string[] {
  const extensions = new Set<string>();
  for (const descriptor of BUILT_IN_STRUCTURAL_LANGUAGES) {
    if (languageId && descriptor.publicLanguageId !== languageId) continue;
    for (const extension of descriptor.extensions) {
      extensions.add(extension);
    }
  }
  for (const entry of getStructuralMatcherEntries()) {
    if (languageId && entry.languageId !== languageId) continue;
    extensions.add(entry.extension);
  }
  return Array.from(extensions).sort();
}

function descriptorsForLanguage(
  languageId: string,
): StructuralLanguageDescriptor[] {
  const descriptors: StructuralLanguageDescriptor[] = [];
  const seen = new Set<string>();
  for (const extension of getStructuralExtensions(languageId)) {
    const descriptor = descriptorForPath(`file${extension}`);
    if (
      descriptor?.publicLanguageId === languageId &&
      !seen.has(descriptor.queryCacheKey)
    ) {
      descriptors.push(descriptor);
      seen.add(descriptor.queryCacheKey);
    }
  }
  return descriptors;
}

function compileStructuralQuery(
  descriptor: StructuralLanguageDescriptor,
  queryString: string,
): Parser.Query {
  try {
    return descriptor.createQuery(queryString);
  } catch (error) {
    throw new ValidationError(
      `Invalid structural tree-sitter query (${descriptor.publicLanguageId}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export function structuralLanguageMismatchReason(
  relPath: string,
  expectedLanguageId: string | undefined,
): string | undefined {
  if (!expectedLanguageId) return undefined;
  const actualLanguageId = getStructuralLanguageForPath(relPath);
  if (actualLanguageId === null) return "structural-unsupported-extension";
  if (actualLanguageId !== expectedLanguageId) {
    return `structural-language-mismatch:${actualLanguageId}->${expectedLanguageId}`;
  }
  return undefined;
}

export function createStructuralQueryCache(
  structural: StructuralQueryInput,
  languageIdOverride?: string,
): StructuralQueryCache {
  const languageId = languageIdOverride ?? structural.language;
  if (languageId && !isStructuralLanguageSupported(languageId)) {
    throw new ValidationError(`Unsupported structural language: ${languageId}`);
  }

  const cache = new Map<string, Parser.Query>();
  const incompatible = new Map<string, Error>();
  const cacheKeyFor = (descriptor: StructuralLanguageDescriptor): string =>
    `${descriptor.queryCacheKey}:${structural.treeSitterQuery}`;
  const getOrCreate = (
    descriptor: StructuralLanguageDescriptor,
  ): Parser.Query | null => {
    const cacheKey = cacheKeyFor(descriptor);
    const cachedFailure = incompatible.get(cacheKey);
    if (cachedFailure) throw cachedFailure;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const query = compileStructuralQuery(
      descriptor,
      structural.treeSitterQuery,
    );
    cache.set(cacheKey, query);
    return query;
  };

  const warmedLanguages = new Set<string>();
  const warmLanguageDescriptors = (targetLanguageId: string): void => {
    if (warmedLanguages.has(targetLanguageId)) return;

    const descriptors = descriptorsForLanguage(targetLanguageId);
    if (descriptors.length === 0) {
      throw new ValidationError(
        `Unsupported structural language: ${targetLanguageId}`,
      );
    }

    const failures: Error[] = [];
    for (const descriptor of descriptors) {
      try {
        getOrCreate(descriptor);
      } catch (error) {
        const failure =
          error instanceof Error ? error : new Error(String(error));
        incompatible.set(cacheKeyFor(descriptor), failure);
        failures.push(failure);
      }
    }

    if (failures.length === descriptors.length) {
      throw failures[0];
    }

    warmedLanguages.add(targetLanguageId);
  };

  if (languageId) {
    warmLanguageDescriptors(languageId);
  }

  return {
    ...(languageId ? { languageId } : {}),
    get(relPath: string): Parser.Query | null {
      const descriptor = descriptorForPath(relPath);
      if (!descriptor) return null;
      if (languageId && descriptor.publicLanguageId !== languageId) return null;
      warmLanguageDescriptors(descriptor.publicLanguageId);
      return getOrCreate(descriptor);
    },
  };
}

function buildQueryByteWindows(
  content: string,
): Array<{ startByte: number; endByte: number }> {
  const totalBytes = Buffer.byteLength(content, "utf-8");
  if (totalBytes <= STRUCTURAL_QUERY_WINDOW_BYTES) {
    return [{ startByte: 0, endByte: totalBytes }];
  }

  const windows: Array<{ startByte: number; endByte: number }> = [];
  let currentStartByte = 0;
  let currentEndTarget = STRUCTURAL_QUERY_WINDOW_BYTES;
  let byteOffset = 0;

  for (const char of content) {
    byteOffset += Buffer.byteLength(char, "utf-8");
    if (byteOffset < currentEndTarget) {
      continue;
    }

    windows.push({ startByte: currentStartByte, endByte: byteOffset });
    currentStartByte = Math.max(
      0,
      byteOffset - STRUCTURAL_QUERY_WINDOW_OVERLAP_BYTES,
    );
    currentEndTarget = currentStartByte + STRUCTURAL_QUERY_WINDOW_BYTES;
  }

  const lastWindow = windows.at(-1);
  if (!lastWindow || lastWindow.endByte < totalBytes) {
    windows.push({ startByte: currentStartByte, endByte: totalBytes });
  }

  return windows;
}

function captureFromNode(name: string, node: SyntaxNode): StructuralCapture {
  return {
    name,
    text: node.text,
    nodeType: node.type,
    startByte: node.startIndex,
    endByte: node.endIndex,
    start: node.startIndex,
    end: node.endIndex,
    range: {
      startLine: node.startPosition.row + 1,
      startCol: node.startPosition.column,
      endLine: node.endPosition.row + 1,
      endCol: node.endPosition.column,
    },
  };
}

function dedupeCaptures(captures: StructuralCapture[]): StructuralCapture[] {
  const seen = new Set<string>();
  const deduped: StructuralCapture[] = [];
  for (const capture of captures) {
    const key = `${capture.name}:${capture.startByte}:${capture.endByte}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(capture);
  }
  return deduped;
}

function replacementWithCaptures(
  replacement: string,
  captures: StructuralCapture[],
): string {
  const byName = new Map<string, StructuralCapture>();
  for (const capture of captures) {
    byName.set(capture.name, capture);
  }
  return replacement.replace(
    /\$(\{([A-Za-z_][A-Za-z0-9_-]*)\}|[A-Za-z_][A-Za-z0-9_-]*)/g,
    (token, marker: string, bracedName?: string) => {
      const name = bracedName ?? marker;
      return byName.get(name)?.text ?? token;
    },
  );
}

function structuralReplacement(
  query: StructuralQueryInput,
  fallbackReplacement: string | undefined,
): string {
  const replacement = query.replacement ?? fallbackReplacement;
  if (replacement === undefined) {
    throw new ValidationError(
      "structural targeting requires query.replacement or query.structural.replacement",
    );
  }
  return replacement;
}

function pushIdentifierEdits(
  node: SyntaxNode,
  identifierNodeTypes: ReadonlySet<string>,
  literal: string,
  replacement: string,
  edits: StructuralSourceEdit[],
  maxMatches: number,
): void {
  if (edits.length >= maxMatches) return;
  if (identifierNodeTypes.has(node.type) && node.text === literal) {
    const capture = captureFromNode("target", node);
    edits.push({
      start: capture.start,
      end: capture.end,
      replacement,
      captures: [capture],
    });
    if (edits.length >= maxMatches) return;
  }

  for (const child of node.namedChildren) {
    pushIdentifierEdits(
      child,
      identifierNodeTypes,
      literal,
      replacement,
      edits,
      maxMatches,
    );
    if (edits.length >= maxMatches) return;
  }
}

export function collectIdentifierSourceEdits(
  input: IdentifierEditInput,
): StructuralSourceEdit[] {
  const descriptor = descriptorForPath(input.relPath);
  if (!descriptor) {
    return [];
  }

  const tree = descriptor.parse(input.content, input.relPath);
  if (!tree) {
    return [];
  }

  const maxMatches =
    input.global === false ? 1 : (input.maxMatches ?? Number.MAX_SAFE_INTEGER);
  const edits: StructuralSourceEdit[] = [];
  pushIdentifierEdits(
    tree.rootNode,
    descriptor.identifierNodeTypes,
    input.literal,
    input.replacement,
    edits,
    maxMatches,
  );
  return edits;
}

function capturesByName(
  captures: StructuralCapture[],
): Map<string, StructuralCapture[]> {
  const grouped = new Map<string, StructuralCapture[]>();
  for (const capture of captures) {
    const group = grouped.get(capture.name) ?? [];
    group.push(capture);
    grouped.set(capture.name, group);
  }
  return grouped;
}

function requiredCapturesMatch(
  captures: StructuralCapture[],
  requiredCaptures: Record<string, string> | undefined,
): boolean {
  if (!requiredCaptures) return true;
  const grouped = capturesByName(captures);
  for (const [name, expectedText] of Object.entries(requiredCaptures)) {
    const candidates = grouped.get(name) ?? [];
    if (!candidates.some((capture) => capture.text === expectedText)) {
      return false;
    }
  }
  return true;
}

function captureName(capture: QueryCapture): string {
  return capture.name.replace(/^@/, "");
}

export function collectStructuralSourceEdits(
  input: StructuralEditInput,
): StructuralSourceEdit[] {
  const languageId = input.languageIdOverride ?? input.structural.language;
  if (languageId && !isStructuralLanguageSupported(languageId)) {
    throw new ValidationError(`Unsupported structural language: ${languageId}`);
  }

  const descriptor = descriptorForPath(input.relPath);
  if (!descriptor) {
    return [];
  }
  if (languageId && descriptor.publicLanguageId !== languageId) {
    return [];
  }

  assertStructuralBudget(input.deadlineMs);
  const tree = descriptor.parse(input.content, input.relPath);
  if (!tree) {
    return [];
  }

  const replacement = structuralReplacement(
    input.structural,
    input.replacement,
  );
  const targetCapture = input.structural.capture ?? DEFAULT_TARGET_CAPTURE;
  const maxMatches =
    input.global === false
      ? 1
      : (input.maxMatches ?? DEFAULT_STRUCTURAL_MAX_MATCHES);
  const queryMatchLimit = Math.max(
    1,
    Math.min(maxMatches + 1, TREESITTER_QUERY_MATCH_LIMIT),
  );
  const query = (() => {
    try {
      if (input.queryCache) {
        return input.queryCache.get(input.relPath);
      }
      return descriptor.createQuery(input.structural.treeSitterQuery);
    } catch (error) {
      throw new ValidationError(
        `Invalid structural tree-sitter query for ${input.relPath} (${descriptor.publicLanguageId}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  })();
  if (!query) return [];

  const remainingBudgetMicros = (): number => {
    if (input.deadlineMs === undefined) {
      return STRUCTURAL_QUERY_TIMEOUT_MICROS;
    }
    assertStructuralBudget(input.deadlineMs);
    const remainingMs = input.deadlineMs - Date.now();
    return Math.max(
      1_000,
      Math.min(STRUCTURAL_QUERY_TIMEOUT_MICROS, remainingMs * 1_000),
    );
  };

  const runQueryWindow = (startByte: number, endByte: number) => {
    try {
      return query.matches(tree.rootNode, {
        startIndex: startByte,
        endIndex: endByte,
        matchLimit: queryMatchLimit,
        timeoutMicros: remainingBudgetMicros(),
      });
    } catch (error) {
      if (
        error instanceof ValidationError &&
        error.message === STRUCTURAL_QUERY_TIME_BUDGET_ERROR
      ) {
        throw error;
      }
      throw new ValidationError(
        `Invalid structural tree-sitter query for ${input.relPath} (${descriptor.publicLanguageId}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };
  const edits: StructuralSourceEdit[] = [];
  const seenTargets = new Set<string>();

  for (const { startByte, endByte } of buildQueryByteWindows(input.content)) {
    for (const match of runQueryWindow(startByte, endByte)) {
      const captures = dedupeCaptures(
        match.captures.map((capture) =>
          captureFromNode(captureName(capture), capture.node),
        ),
      );
      if (!requiredCapturesMatch(captures, input.structural.requiredCaptures)) {
        continue;
      }
      const target = captures.find((capture) => capture.name === targetCapture);
      if (!target) continue;
      const targetKey = `${target.startByte}:${target.endByte}`;
      if (seenTargets.has(targetKey)) continue;
      seenTargets.add(targetKey);
      edits.push({
        start: target.start,
        end: target.end,
        replacement: replacementWithCaptures(replacement, captures),
        captures,
      });
      if (edits.length >= maxMatches) break;
    }
    if (edits.length >= maxMatches) break;
  }

  return edits;
}
