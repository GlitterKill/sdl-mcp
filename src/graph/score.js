import { tokenize } from "../util/tokenize.js";
import * as db from "../db/queries.js";
export function calculateQueryOverlap(symbol, query, queryTokens) {
    const tokens = queryTokens ?? tokenize(query);
    if (tokens.length === 0)
        return 0;
    const symbolName = symbol.name.toLowerCase();
    const file = db.getFile(symbol.file_id);
    const filePath = file?.rel_path.toLowerCase() || "";
    let matches = 0;
    for (const token of tokens) {
        if (symbolName.includes(token) || filePath.includes(token)) {
            matches++;
        }
    }
    return matches / tokens.length;
}
export function calculateStacktraceLocality(symbol, stackTrace) {
    if (!stackTrace)
        return 0;
    const lines = stackTrace.split("\n");
    const file = db.getFile(symbol.file_id);
    const filePath = file?.rel_path || "";
    const symbolRange = {
        startLine: symbol.range_start_line,
        endLine: symbol.range_end_line,
    };
    for (const line of lines) {
        if (line.includes(filePath)) {
            const lineMatch = line.match(/:(\d+)(?::(\d+))?/);
            if (lineMatch) {
                const lineNum = parseInt(lineMatch[1], 10);
                if (lineNum >= symbolRange.startLine &&
                    lineNum <= symbolRange.endLine) {
                    return 1;
                }
            }
            return 0.5;
        }
    }
    return 0;
}
export function calculateHotness(metrics) {
    if (!metrics)
        return 0;
    const normalizeLog = (value, max) => {
        if (value <= 0)
            return 0;
        return Math.min(Math.log(value + 1) / Math.log(max + 1), 1);
    };
    const normalizeLinear = (value, max) => {
        return Math.min(value / max, 1);
    };
    const fanInScore = normalizeLog(metrics.fan_in, 100);
    const fanOutScore = normalizeLog(metrics.fan_out, 50);
    const churnScore = normalizeLinear(metrics.churn_30d, 20);
    return 0.5 * fanInScore + 0.3 * fanOutScore + 0.2 * churnScore;
}
export function scoreSymbol(symbol, context) {
    const factors = new Map();
    const file = db.getFile(symbol.file_id);
    factors.set("query", calculateQueryOverlapWithFile(symbol, context.query, context.queryTokens, file ?? undefined));
    factors.set("stacktrace", calculateStacktraceLocalityWithFile(symbol, context.stackTrace || "", file ?? undefined));
    factors.set("structure", calculateStructuralSpecificity(file ?? undefined));
    const weights = new Map([
        ["query", 0.35],
        ["stacktrace", 0.25],
        ["hotness", 0.2],
        ["structure", 0.2],
    ]);
    const metrics = db.getMetrics(symbol.symbol_id);
    factors.set("hotness", calculateHotness(metrics));
    return combineScores(factors, weights);
}
export function scoreSymbolWithMetrics(symbol, context, metrics, file) {
    const factors = new Map();
    factors.set("query", calculateQueryOverlapWithFile(symbol, context.query, context.queryTokens, file));
    factors.set("stacktrace", calculateStacktraceLocalityWithFile(symbol, context.stackTrace || "", file));
    factors.set("structure", calculateStructuralSpecificity(file));
    const weights = new Map([
        ["query", 0.35],
        ["stacktrace", 0.25],
        ["hotness", 0.2],
        ["structure", 0.2],
    ]);
    factors.set("hotness", calculateHotness(metrics));
    return combineScores(factors, weights);
}
function calculateQueryOverlapWithFile(symbol, query, queryTokens, file) {
    const tokens = queryTokens ?? tokenize(query);
    if (tokens.length === 0)
        return 0;
    const symbolName = symbol.name.toLowerCase();
    const filePath = file?.rel_path.toLowerCase() || "";
    let matches = 0;
    for (const token of tokens) {
        if (symbolName.includes(token) || filePath.includes(token)) {
            matches++;
        }
    }
    return matches / tokens.length;
}
function calculateStacktraceLocalityWithFile(symbol, stackTrace, file) {
    if (!stackTrace)
        return 0;
    const lines = stackTrace.split("\n");
    const filePath = file?.rel_path || "";
    const symbolRange = {
        startLine: symbol.range_start_line,
        endLine: symbol.range_end_line,
    };
    for (const line of lines) {
        if (line.includes(filePath)) {
            const lineMatch = line.match(/:(\d+)(?::(\d+))?/);
            if (lineMatch) {
                const lineNum = parseInt(lineMatch[1], 10);
                if (lineNum >= symbolRange.startLine &&
                    lineNum <= symbolRange.endLine) {
                    return 1;
                }
            }
            return 0.5;
        }
    }
    return 0;
}
function calculateStructuralSpecificity(file) {
    if (!file?.rel_path)
        return 0.8;
    const relPath = file.rel_path.toLowerCase();
    let specificity = 1;
    if (relPath.includes("/tests/") ||
        relPath.startsWith("tests/") ||
        relPath.includes("dist-tests/") ||
        relPath.includes(".test.") ||
        relPath.includes(".spec.")) {
        specificity *= 0.55;
    }
    if (relPath.startsWith("dist/") ||
        relPath.includes("/dist/") ||
        relPath.startsWith("dist-tests/")) {
        specificity *= 0.6;
    }
    if (relPath.startsWith("scripts/")) {
        specificity *= 0.75;
    }
    if (/(^|\/)(index|tools|types|main|mod|util|utils)\.[^.]+$/.test(relPath)) {
        specificity *= 0.72;
    }
    if (/(^|\/)mcp\/tools\.[^.]+$/.test(relPath)) {
        specificity *= 0.65;
    }
    return Math.max(0.15, Math.min(1, specificity));
}
export function normalizeScores(scores) {
    if (scores.length === 0)
        return [];
    if (scores.length === 1)
        return [1];
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    if (min === max) {
        return scores.map(() => 0.5);
    }
    return scores.map((score) => (score - min) / (max - min));
}
export function combineScores(scores, weights) {
    let totalScore = 0;
    let totalWeight = 0;
    for (const [key, score] of scores.entries()) {
        const weight = weights.get(key) ?? 0;
        totalScore += score * weight;
        totalWeight += weight;
    }
    return totalWeight > 0 ? totalScore / totalWeight : 0;
}
//# sourceMappingURL=score.js.map