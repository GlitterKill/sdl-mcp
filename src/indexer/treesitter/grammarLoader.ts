import { createRequire } from "node:module";
import Parser from "tree-sitter";
import { logger } from "../../util/logger.js";
import { GRAMMAR_QUERY_LENGTH } from "../../config/constants.js";

// Lazy synchronous require for native tree-sitter grammars.
// Using createRequire instead of top-level static imports so that
// a missing native binary for one language (e.g. tree-sitter-kotlin
// on Linux) does not crash the entire process at module load time.
const require = createRequire(import.meta.url);

export type SupportedLanguage =
  | "typescript"
  | "python"
  | "go"
  | "java"
  | "csharp"
  | "c"
  | "cpp"
  | "php"
  | "rust"
  | "kotlin"
  | "bash";

const parserCache = new Map<SupportedLanguage, Parser | null>();
const languageCache = new Map<SupportedLanguage, any | null>();

/**
 * Map from language ID to npm package name and optional property path.
 * Property path is used for packages that export sub-languages
 * (e.g. tree-sitter-typescript exports .typescript, tree-sitter-php exports .php).
 */
const GRAMMAR_PACKAGES: Record<
  SupportedLanguage,
  { pkg: string; prop?: string }
> = {
  typescript: { pkg: "tree-sitter-typescript", prop: "typescript" },
  python: { pkg: "tree-sitter-python" },
  go: { pkg: "tree-sitter-go" },
  java: { pkg: "tree-sitter-java" },
  csharp: { pkg: "tree-sitter-c-sharp" },
  c: { pkg: "tree-sitter-c" },
  cpp: { pkg: "tree-sitter-cpp" },
  php: { pkg: "tree-sitter-php", prop: "php" },
  rust: { pkg: "tree-sitter-rust" },
  kotlin: { pkg: "tree-sitter-kotlin" },
  bash: { pkg: "tree-sitter-bash" },
};

function getLanguageModule(language: SupportedLanguage): any | null {
  const cached = languageCache.get(language);
  if (cached !== undefined) {
    return cached;
  }

  let lang: any | null = null;

  try {
    const spec = GRAMMAR_PACKAGES[language];
    if (!spec) {
      lang = null;
    } else {
      const mod = require(spec.pkg);
      lang = spec.prop ? mod[spec.prop] : mod;
    }
  } catch (error) {
    logger.warn(`Grammar not available for ${language} on this platform`, {
      error: error instanceof Error ? error.message : String(error),
    });
    lang = null;
  }

  languageCache.set(language, lang);
  return lang;
}

export function getParser(language: SupportedLanguage): Parser | null {
  const cached = parserCache.get(language);
  if (cached !== undefined) {
    return cached;
  }

  const lang = getLanguageModule(language);
  if (!lang) {
    parserCache.set(language, null);
    return null;
  }

  try {
    const parser = new Parser();
    parser.setLanguage(lang);
    parserCache.set(language, parser);
    logger.debug(`Created parser for ${language}`);
    return parser;
  } catch (error) {
    logger.error(`Failed to create parser for ${language}`, {
      error: error instanceof Error ? error.message : String(error),
    });
    parserCache.set(language, null);
    return null;
  }
}

export function createQuery(
  language: SupportedLanguage,
  queryString: string,
): Parser.Query | null {
  const lang = getLanguageModule(language);
  if (!lang) {
    logger.error(
      `Cannot create query for ${language}: language module not loaded`,
    );
    return null;
  }

  try {
    const query = new Parser.Query(lang, queryString);
    logger.debug(`Created query for ${language}`);
    return query;
  } catch (error) {
    logger.error(`Failed to create query for ${language}`, {
      error: error instanceof Error ? error.message : String(error),
      query: queryString.substring(0, GRAMMAR_QUERY_LENGTH),
    });
    return null;
  }
}

export function clearCache(language?: SupportedLanguage): void {
  if (language) {
    parserCache.delete(language);
    languageCache.delete(language);
    logger.debug(`Cleared parser cache for ${language}`);
  } else {
    parserCache.clear();
    languageCache.clear();
    logger.debug("Cleared all parser caches");
  }
}
