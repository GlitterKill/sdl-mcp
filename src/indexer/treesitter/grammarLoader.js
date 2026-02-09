import Parser from "tree-sitter";
import TypeScript from "tree-sitter-typescript";
import Python from "tree-sitter-python";
import Go from "tree-sitter-go";
import Java from "tree-sitter-java";
import CSharp from "tree-sitter-c-sharp";
import C from "tree-sitter-c";
import Cpp from "tree-sitter-cpp";
import PHP from "tree-sitter-php";
import Rust from "tree-sitter-rust";
import Kotlin from "tree-sitter-kotlin";
import Bash from "tree-sitter-bash";
import { logger } from "../../util/logger.js";
import { GRAMMAR_QUERY_LENGTH } from "../../config/constants.js";
const parserCache = new Map();
const languageCache = new Map();
function getLanguageModule(language) {
    const cached = languageCache.get(language);
    if (cached !== undefined) {
        return cached;
    }
    let lang = null;
    try {
        switch (language) {
            case "typescript":
                lang = TypeScript.typescript;
                break;
            case "python":
                lang = Python;
                break;
            case "go":
                lang = Go;
                break;
            case "java":
                lang = Java;
                break;
            case "csharp":
                lang = CSharp;
                break;
            case "c":
                lang = C;
                break;
            case "cpp":
                lang = Cpp;
                break;
            case "php":
                lang = PHP.php;
                break;
            case "rust":
                lang = Rust;
                break;
            case "kotlin":
                lang = Kotlin;
                break;
            case "bash":
                lang = Bash;
                break;
        }
    }
    catch (error) {
        logger.error(`Failed to load language module for ${language}`, {
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