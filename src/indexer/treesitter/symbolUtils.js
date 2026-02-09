export function findEnclosingSymbol(node, symbols) {
    let bestMatch = null;
    let smallestSize = Infinity;
    const nodeLine = node.startPosition.row + 1;
    const nodeCol = node.startPosition.column;
    for (const symbol of symbols) {
        if (nodeLine >= symbol.range.startLine &&
            nodeLine <= symbol.range.endLine) {
            if (nodeLine === symbol.range.startLine &&
                nodeCol < symbol.range.startCol) {
                continue;
            }
            if (nodeLine === symbol.range.endLine && nodeCol > symbol.range.endCol) {
                continue;
            }
            const size = (symbol.range.endLine - symbol.range.startLine) * 1000 +
                (symbol.range.endCol - symbol.range.startCol);
            if (size < smallestSize) {
                smallestSize = size;
                bestMatch = symbol;
            }
        }
    }
    return bestMatch?.nodeId || "global";
}
//# sourceMappingURL=symbolUtils.js.map