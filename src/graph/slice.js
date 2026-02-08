import { loadGraphForRepo } from "./buildGraph.js";
import { scoreSymbolWithMetrics } from "./score.js";
import { loadConfig } from "../config/loadConfig.js";
import { tokenize, estimateTokens as estimateTextTokens, } from "../util/tokenize.js";
import * as db from "../db/queries.js";
import { DEFAULT_MAX_CARDS, DEFAULT_MAX_TOKENS_SLICE, SLICE_SCORE_THRESHOLD, MAX_FRONTIER, SYMBOL_TOKEN_BASE, SYMBOL_TOKEN_ADDITIONAL_MAX, SYMBOL_TOKEN_MAX, TOKENS_PER_CHAR_ESTIMATE, DB_QUERY_LIMIT_DEFAULT, } from "../config/constants.js";
import { MinHeap } from "./minHeap.js";
import { symbolCardCache } from "./cache.js";
import { getSliceCacheKey, getCachedSlice, setCachedSlice, } from "./sliceCache.js";
/**
 * Builds a graph slice for code context delivery.
 * Uses beam search to select relevant symbols based on entry points and scoring.
 * Supports truncation and spillover for large slices.
 *
 * @param request - Slice build parameters including repoId, versionId, task context, and budget
 * @returns Graph slice with cards, edges, and truncation metadata
 */
export async function buildSlice(request) {
    const config = loadConfig();
    const cacheConfig = config.cache;
    const cacheEnabled = cacheConfig?.enabled ?? true;
    const cacheKey = getSliceCacheKey(request);
    const cached = cacheEnabled ? getCachedSlice(cacheKey) : null;
    if (cached) {
        return cached;
    }
    const sliceConfig = config.slice;
    const edgeWeights = sliceConfig?.edgeWeights ?? {
        call: 1.0,
        import: 0.6,
        config: 0.8,
    };
    const graph = loadGraphForRepo(request.repoId);
    const budget = {
        maxCards: request.budget?.maxCards ??
            sliceConfig?.defaultMaxCards ??
            DEFAULT_MAX_CARDS,
        maxEstimatedTokens: request.budget?.maxEstimatedTokens ??
            sliceConfig?.defaultMaxTokens ??
            DEFAULT_MAX_TOKENS_SLICE,
    };
    const startSymbols = resolveStartNodes(graph, request);
    const { sliceCards, frontier, wasTruncated, droppedCandidates } = beamSearch(graph, startSymbols, budget, request, edgeWeights);
    const cards = await loadSymbolCards(Array.from(sliceCards), request.versionId, request.repoId);
    const edges = loadEdgesBetweenSymbols(Array.from(sliceCards), request.repoId);
    const frontierSuggestions = frontier.slice(0, 10).map((item) => ({
        symbolId: item.symbolId,
        score: item.score,
        why: item.why,
    }));
    const estimatedTokens = estimateTokens(cards);
    const slice = {
        repoId: request.repoId,
        versionId: request.versionId,
        budget,
        startSymbols,
        cards,
        edges,
        frontier: frontierSuggestions,
    };
    if (wasTruncated || cards.length >= budget.maxCards) {
        const totalEdges = edges.length;
        const maxEdges = Math.max(0, totalEdges);
        slice.truncation = {
            truncated: true,
            droppedCards: droppedCandidates,
            droppedEdges: maxEdges,
            howToResume: {
                type: "token",
                value: estimatedTokens,
            },
        };
    }
    if (cacheEnabled) {
        setCachedSlice(cacheKey, slice);
    }
    return slice;
}
function resolveStartNodes(graph, request) {
    const startNodes = new Set();
    if (request.entrySymbols) {
        for (const symbolId of request.entrySymbols) {
            if (graph.symbols.has(symbolId)) {
                startNodes.add(symbolId);
            }
        }
    }
    if (request.taskText) {
        const tokens = tokenize(request.taskText);
        for (const token of tokens) {
            const results = db.searchSymbolsLite(request.repoId, token, DB_QUERY_LIMIT_DEFAULT);
            for (const result of results) {
                startNodes.add(result.symbol_id);
            }
        }
    }
    if (request.stackTrace) {
        const stackSymbols = extractSymbolsFromStackTrace(request.stackTrace, request.repoId);
        for (const symbolId of stackSymbols) {
            if (graph.symbols.has(symbolId)) {
                startNodes.add(symbolId);
            }
        }
    }
    if (request.failingTestPath) {
        const fileSymbols = getSymbolsByPath(request.repoId, request.failingTestPath);
        for (const symbolId of fileSymbols) {
            if (graph.symbols.has(symbolId)) {
                startNodes.add(symbolId);
            }
        }
    }
    if (request.editedFiles) {
        for (const filePath of request.editedFiles) {
            const fileSymbols = getSymbolsByPath(request.repoId, filePath);
            for (const symbolId of fileSymbols) {
                if (graph.symbols.has(symbolId)) {
                    startNodes.add(symbolId);
                }
            }
        }
    }
    return Array.from(startNodes);
}
function extractSymbolsFromStackTrace(stackTrace, repoId) {
    const symbols = new Set();
    const lines = stackTrace.split("\n");
    const filesByRepo = db.getFilesByRepoLite(repoId);
    const filePaths = new Map();
    for (const file of filesByRepo) {
        filePaths.set(file.rel_path, file.file_id);
    }
    for (const [path, fileId] of filePaths.entries()) {
        for (const line of lines) {
            if (line.includes(path)) {
                const symbolIds = db.getSymbolIdsByFile(fileId);
                for (const symbolId of symbolIds) {
                    symbols.add(symbolId);
                }
                break;
            }
        }
    }
    return Array.from(symbols);
}
function getSymbolsByPath(repoId, filePath) {
    const filesByRepo = db.getFilesByRepoLite(repoId);
    const file = filesByRepo.find((f) => f.rel_path === filePath);
    if (!file)
        return [];
    const symbolIds = db.getSymbolIdsByFile(file.file_id);
    return symbolIds;
}
function beamSearch(graph, startSymbols, budget, request, edgeWeights) {
    const sliceCards = new Set();
    const visited = new Set();
    const frontier = new MinHeap();
    let droppedCandidates = 0;
    for (const symbolId of startSymbols) {
        if (!visited.has(symbolId) && graph.symbols.has(symbolId)) {
            frontier.insert({
                symbolId,
                score: -1.0,
                why: "start node",
            });
            visited.add(symbolId);
        }
    }
    const context = {
        query: request.taskText ?? "",
        queryTokens: request.taskText ? tokenize(request.taskText) : undefined,
        stackTrace: request.stackTrace,
        failingTestPath: request.failingTestPath,
        editedFiles: request.editedFiles,
        entrySymbols: request.entrySymbols,
    };
    let belowThresholdCount = 0;
    let wasTruncated = false;
    let totalTokens = 0;
    while (!frontier.isEmpty() && sliceCards.size < budget.maxCards) {
        const current = frontier.extractMin();
        const actualScore = -current.score;
        if (sliceCards.size >= budget.maxCards) {
            wasTruncated = true;
            break;
        }
        if (actualScore < SLICE_SCORE_THRESHOLD) {
            belowThresholdCount++;
            if (belowThresholdCount >= 5)
                break;
            continue;
        }
        belowThresholdCount = 0;
        sliceCards.add(current.symbolId);
        const cardTokens = estimateCardTokens(current.symbolId, graph);
        totalTokens += cardTokens;
        if (totalTokens > budget.maxEstimatedTokens) {
            sliceCards.delete(current.symbolId);
            totalTokens -= cardTokens;
            wasTruncated = true;
            droppedCandidates++;
            break;
        }
        const outgoing = graph.adjacencyOut.get(current.symbolId) ?? [];
        const neighborIds = outgoing
            .map((e) => e.to_symbol_id)
            .filter((id) => !visited.has(id) && !sliceCards.has(id));
        if (neighborIds.length === 0)
            continue;
        const neighborsMap = new Map();
        for (const id of neighborIds) {
            const symbol = graph.symbols.get(id);
            if (symbol) {
                neighborsMap.set(id, symbol);
            }
        }
        if (neighborsMap.size === 0)
            continue;
        const metricsMap = db.getMetricsBySymbolIds([...neighborsMap.keys()]);
        const fileIds = new Set([...neighborsMap.values()].map((s) => s.file_id));
        const filesMap = db.getFilesByIds([...fileIds]);
        for (const [neighborId, neighborSymbol] of neighborsMap) {
            if (visited.has(neighborId))
                continue;
            visited.add(neighborId);
            const edge = outgoing.find((e) => e.to_symbol_id === neighborId);
            if (!edge)
                continue;
            const edgeWeight = edgeWeights[edge.type] ?? 0.5;
            const neighborScore = -(scoreSymbolWithMetrics(neighborSymbol, context, metricsMap.get(neighborId) ?? null, filesMap.get(neighborSymbol.file_id)) * edgeWeight);
            if (-neighborScore < SLICE_SCORE_THRESHOLD) {
                droppedCandidates++;
                continue;
            }
            if (frontier.size() < MAX_FRONTIER) {
                frontier.insert({
                    symbolId: neighborId,
                    score: neighborScore,
                    why: getEdgeWhy(edge.type, neighborSymbol.name),
                });
            }
            else {
                const min = frontier.peek();
                if (min && min.score > neighborScore) {
                    frontier.extractMin();
                    frontier.insert({
                        symbolId: neighborId,
                        score: neighborScore,
                        why: getEdgeWhy(edge.type, neighborSymbol.name),
                    });
                }
                else {
                    droppedCandidates++;
                }
            }
        }
    }
    const frontierArray = frontier.toHeapArray().map((item) => ({
        symbolId: item.symbolId,
        score: -item.score,
        why: item.why,
    }));
    if (sliceCards.size >= budget.maxCards || frontierArray.length > 0) {
        wasTruncated = true;
        droppedCandidates += frontierArray.length;
    }
    return {
        sliceCards,
        frontier: frontierArray,
        wasTruncated,
        droppedCandidates,
    };
}
function getEdgeWhy(edgeType, symbolName) {
    switch (edgeType) {
        case "call":
            return `calls ${symbolName}`;
        case "import":
            return `imports ${symbolName}`;
        case "config":
            return `configures ${symbolName}`;
    }
}
function estimateCardTokens(symbolId, graph) {
    const symbol = graph.symbols.get(symbolId);
    if (!symbol)
        return SYMBOL_TOKEN_BASE;
    let tokens = SYMBOL_TOKEN_BASE;
    tokens += symbol.name.length / TOKENS_PER_CHAR_ESTIMATE;
    if (symbol.signature_json) {
        tokens += symbol.signature_json.length / TOKENS_PER_CHAR_ESTIMATE;
    }
    if (symbol.summary) {
        tokens += Math.min(symbol.summary.length / TOKENS_PER_CHAR_ESTIMATE, SYMBOL_TOKEN_ADDITIONAL_MAX);
    }
    const outgoing = graph.adjacencyOut.get(symbolId) ?? [];
    tokens += outgoing.length * 5;
    return Math.ceil(tokens);
}
async function loadSymbolCards(symbolIds, versionId, repoId) {
    if (symbolIds.length === 0)
        return [];
    const config = loadConfig();
    const cacheConfig = config.cache;
    const cacheEnabled = cacheConfig?.enabled ?? true;
    const cards = [];
    const uncachedSymbolIds = [];
    if (cacheEnabled) {
        for (const symbolId of symbolIds) {
            const cachedCard = symbolCardCache.get(repoId, symbolId, versionId);
            if (cachedCard) {
                cards.push(cachedCard);
            }
            else {
                uncachedSymbolIds.push(symbolId);
            }
        }
    }
    else {
        uncachedSymbolIds.push(...symbolIds);
    }
    if (uncachedSymbolIds.length === 0) {
        return cards;
    }
    uncachedSymbolIds.sort();
    // Batch fetch all symbols (1 query instead of N)
    const symbolsMap = db.getSymbolsByIds(uncachedSymbolIds);
    // Collect unique file IDs and batch fetch files (1 query instead of N)
    const fileIds = new Set();
    for (const symbol of symbolsMap.values()) {
        fileIds.add(symbol.file_id);
    }
    const filesMap = db.getFilesByIds([...fileIds]);
    // Batch fetch all metrics (1 query instead of N)
    const metricsMap = db.getMetricsBySymbolIds(uncachedSymbolIds);
    // Batch fetch all outgoing edges (1 query instead of N)
    const edgesMap = db.getEdgesFromSymbols(uncachedSymbolIds);
    // Collect all imported symbol IDs to batch fetch their names
    const importedSymbolIds = new Set();
    for (const edges of edgesMap.values()) {
        for (const edge of edges) {
            if (edge.type === "import") {
                importedSymbolIds.add(edge.to_symbol_id);
            }
        }
    }
    // Batch fetch imported symbols for name lookup (lite version - only name needed)
    const importedSymbolsMap = db.getSymbolsByIdsLite([...importedSymbolIds]);
    // Build cards using pre-fetched data
    for (const symbolId of uncachedSymbolIds) {
        const symbolRow = symbolsMap.get(symbolId);
        if (!symbolRow)
            continue;
        const file = filesMap.get(symbolRow.file_id);
        const metrics = metricsMap.get(symbolId);
        const outgoingEdges = edgesMap.get(symbolId) ?? [];
        const deps = {
            imports: [],
            calls: [],
        };
        for (const edge of outgoingEdges) {
            if (edge.type === "import") {
                const importedSymbol = importedSymbolsMap.get(edge.to_symbol_id);
                if (importedSymbol) {
                    deps.imports.push(importedSymbol.name);
                }
            }
            else if (edge.type === "call") {
                deps.calls.push(edge.to_symbol_id);
            }
        }
        let signature;
        if (symbolRow.signature_json) {
            try {
                signature = JSON.parse(symbolRow.signature_json);
            }
            catch (error) {
                // Log parse failure but continue with fallback
                process.stderr.write(`[sdl-mcp] Failed to parse signature_json for symbol ${symbolId}: ${error instanceof Error ? error.message : String(error)}\n`);
                signature = { name: symbolRow.name };
            }
        }
        else {
            signature = { name: symbolRow.name };
        }
        let invariants;
        if (symbolRow.invariants_json) {
            try {
                invariants = JSON.parse(symbolRow.invariants_json);
            }
            catch (error) {
                process.stderr.write(`[sdl-mcp] Failed to parse invariants_json for symbol ${symbolId}: ${error instanceof Error ? error.message : String(error)}\n`);
            }
        }
        let sideEffects;
        if (symbolRow.side_effects_json) {
            try {
                sideEffects = JSON.parse(symbolRow.side_effects_json);
            }
            catch (error) {
                process.stderr.write(`[sdl-mcp] Failed to parse side_effects_json for symbol ${symbolId}: ${error instanceof Error ? error.message : String(error)}\n`);
            }
        }
        let metricsData;
        if (metrics) {
            let testRefs;
            if (metrics.test_refs_json) {
                try {
                    testRefs = JSON.parse(metrics.test_refs_json);
                }
                catch (error) {
                    process.stderr.write(`[sdl-mcp] Failed to parse test_refs_json for symbol ${symbolId}: ${error instanceof Error ? error.message : String(error)}\n`);
                }
            }
            metricsData = {
                fanIn: metrics.fan_in,
                fanOut: metrics.fan_out,
                churn30d: metrics.churn_30d,
                testRefs,
            };
        }
        const card = {
            symbolId: symbolRow.symbol_id,
            repoId: symbolRow.repo_id,
            file: file?.rel_path ?? "",
            range: {
                startLine: symbolRow.range_start_line,
                startCol: symbolRow.range_start_col,
                endLine: symbolRow.range_end_line,
                endCol: symbolRow.range_end_col,
            },
            kind: symbolRow.kind,
            name: symbolRow.name,
            exported: symbolRow.exported === 1,
            visibility: symbolRow.visibility ?? undefined,
            signature,
            summary: symbolRow.summary ?? undefined,
            invariants,
            sideEffects,
            deps,
            metrics: metricsData,
            version: {
                ledgerVersion: versionId,
                astFingerprint: symbolRow.ast_fingerprint,
            },
        };
        cards.push(card);
        if (cacheEnabled) {
            await symbolCardCache.set(repoId, symbolRow.symbol_id, versionId, card);
        }
    }
    return cards;
}
function loadEdgesBetweenSymbols(symbolIds, _repoId) {
    if (symbolIds.length === 0)
        return [];
    const symbolSet = new Set(symbolIds);
    const edges = [];
    // Batch fetch all outgoing edges (1 query instead of N)
    const edgesMap = db.getEdgesFromSymbols(symbolIds);
    for (const [_fromId, outgoing] of edgesMap) {
        for (const edge of outgoing) {
            if (symbolSet.has(edge.to_symbol_id)) {
                edges.push({
                    from: edge.from_symbol_id,
                    to: edge.to_symbol_id,
                    type: edge.type,
                    weight: edge.weight,
                });
            }
        }
    }
    return edges;
}
export function estimateTokens(cards) {
    let total = 0;
    for (const card of cards) {
        let cardTokens = SYMBOL_TOKEN_BASE;
        cardTokens += estimateTextTokens(card.name);
        cardTokens += estimateTextTokens(card.file);
        if (card.signature) {
            const sigText = JSON.stringify(card.signature);
            cardTokens += estimateTextTokens(sigText);
        }
        if (card.summary) {
            cardTokens += Math.min(estimateTextTokens(card.summary), SYMBOL_TOKEN_ADDITIONAL_MAX);
        }
        cardTokens += card.deps.imports.length * 5;
        cardTokens += card.deps.calls.length * 5;
        if (card.invariants) {
            for (const invariant of card.invariants) {
                cardTokens += estimateTextTokens(invariant);
            }
        }
        if (card.sideEffects) {
            for (const effect of card.sideEffects) {
                cardTokens += estimateTextTokens(effect);
            }
        }
        cardTokens = Math.min(cardTokens, SYMBOL_TOKEN_MAX);
        total += cardTokens;
    }
    return total;
}
//# sourceMappingURL=slice.js.map