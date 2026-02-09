import { getParser, clearCache as clearGrammarCache, } from "../treesitter/grammarLoader.js";
import { logger } from "../../util/logger.js";
import { findEnclosingSymbol as findEnclosingSymbolUtil } from "../treesitter/symbolUtils.js";
// Tree-sitter has a default 32KB buffer limit that causes "Invalid argument"
// errors on larger files. We use a 1MB buffer to handle large source files.
// See: https://github.com/tree-sitter/tree-sitter/issues/3473
const TREESITTER_BUFFER_SIZE = 1024 * 1024; // 1 MB
export class BaseAdapter {
    parser = null;
    getParser() {
        if (!this.parser) {
            this.parser = getParser(this.languageId);
        }
        return this.parser;
    }
    parse(content, filePath) {
        const parser = this.getParser();
        if (!parser) {
            this.logParseError(filePath, "Parser not available");
            return null;
        }
        try {
            // Use larger buffer size to handle files >32KB
            const tree = parser.parse(content, undefined, {
                bufferSize: TREESITTER_BUFFER_SIZE,
            });
            if (!tree) {
                this.logParseError(filePath, "Failed to parse file");
                return null;
            }
            if (tree.rootNode.hasError) {
                this.handleParseErrors(filePath, tree);
            }
            return tree;
        }
        catch (error) {
            this.logParseError(filePath, error);
            return null;
        }
    }
    async parseAsync(content, filePath) {
        return this.parse(content, filePath);
    }
    async extractAll(content, filePath) {
        const tree = this.parse(content, filePath);
        if (!tree) {
            return {
                tree: null,
                symbols: [],
                imports: [],
                calls: [],
            };
        }
        const symbols = this.extractSymbols(tree, content, filePath);
        const imports = this.extractImports(tree, content, filePath);
        const calls = this.extractCalls(tree, content, filePath, symbols);
        return {
            tree,
            symbols,
            imports,
            calls,
        };
    }
    handleParseErrors(_filePath, _tree) { }
    logParseError(filePath, error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("Failed to parse file", { filePath, error: message });
    }
    extractRange(node) {
        const start = node.startPosition;
        const end = node.endPosition;
        return {
            startLine: start.row + 1,
            startCol: start.column,
            endLine: end.row + 1,
            endCol: end.column,
        };
    }
    findEnclosingSymbol(node, symbols) {
        return findEnclosingSymbolUtil(node, symbols);
    }
    hasAncestorOfType(node, type) {
        let current = node.parent;
        while (current) {
            if (current.type === type)
                return true;
            current = current.parent;
        }
        return false;
    }
}
export function createClearCacheFunction(languageId) {
    return function clearCache() {
        clearGrammarCache(languageId);
    };
}
//# sourceMappingURL=BaseAdapter.js.map