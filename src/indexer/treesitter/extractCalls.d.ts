import { Tree } from "tree-sitter";
import { findEnclosingSymbol } from "./symbolUtils.js";
export interface ExtractedSymbol {
    nodeId: string;
    kind: "function" | "class" | "interface" | "type" | "method" | "constructor" | "variable" | "module";
    name: string;
    exported: boolean;
    range: {
        startLine: number;
        startCol: number;
        endLine: number;
        endCol: number;
    };
    signature?: {
        params: Array<{
            name: string;
            type?: string;
        }>;
        returns?: string;
        generics?: string[];
    };
    visibility?: "public" | "private" | "protected" | "internal";
}
export interface ExtractedCall {
    callerNodeId: string;
    calleeIdentifier: string;
    isResolved: boolean;
    callType: "function" | "method" | "constructor" | "dynamic" | "computed" | "tagged-template";
    calleeSymbolId?: string;
    candidateCount?: number;
    range: {
        startLine: number;
        startCol: number;
        endLine: number;
        endCol: number;
    };
}
export declare function extractCalls(tree: Tree, extractedSymbols: ExtractedSymbol[]): ExtractedCall[];
export { findEnclosingSymbol as findEnclosingSymbol };
