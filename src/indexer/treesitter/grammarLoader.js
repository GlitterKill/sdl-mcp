import { createRequire } from "node:module";
import Parser from "tree-sitter";
import { logger } from "../../util/logger.js";
import { GRAMMAR_QUERY_LENGTH } from "../../config/constants.js";
const require = createRequire(import.meta.url);
const parserCache = new Map();
const languageCache = new Map();
const GRAMMAR_PACKAGES = {
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
function getLanguageModule(language) {
    const cached = languageCache.get(language);
    if (cached !== undefined) {
        return cached;
    }
    let lang = null;
    try {
        const spec = GRAMMAR_PACKAGES[language];
        if (!spec) {
            lang = null;
        }
        else {
            const mod = require(spec.pkg);
            lang = spec.prop ? mod[spec.prop] : mod;
        }
    }
    catch (error) {
        logger.warn(`Grammar not available for ${language} on this platform`, {
            error: error instanceof Error ? error.message : String(error),
        });
        lang = null;
    }
    languageCache.set(language, lang);
    return lang;
}
export function getParser(language) {
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
    }
    catch (error) {
        logger.error(`Failed to create parser for ${language}`, {
            error: error instanceof Error ? error.message : String(error),
        });
        parserCache.set(language, null);
        return null;
    }
}
export function createQuery(language, queryString) {
    const lang = getLanguageModule(language);
    if (!lang) {
        logger.error(`Cannot create query for ${language}: language module not loaded`);
        return null;
    }
    try {
        const query = new Parser.Query(lang, queryString);
        logger.debug(`Created query for ${language}`);
        return query;
    }
    catch (error) {
        logger.error(`Failed to create query for ${language}`, {
            error: error instanceof Error ? error.message : String(error),
            query: queryString.substring(0, GRAMMAR_QUERY_LENGTH),
        });
        return null;
    }
}
export function clearCache(language) {
    if (language) {
        parserCache.delete(language);
        languageCache.delete(language);
        logger.debug(`Cleared parser cache for ${language}`);
    }
    else {
        parserCache.clear();
        languageCache.clear();
        logger.debug("Cleared all parser caches");
    }
}
//# sourceMappingURL=grammarLoader.js.map
