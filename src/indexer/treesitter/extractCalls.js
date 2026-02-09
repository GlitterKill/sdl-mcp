import { queryTree } from "./tsTreesitter.js";
import { findEnclosingSymbol } from "./symbolUtils.js";
export function extractCalls(tree, extractedSymbols) {
    const calls = [];
    const seenCallNodes = new Set(); // Track processed nodes to avoid duplicates
    // Build symbol lookup map
    const symbolMap = new Map();
    for (const symbol of extractedSymbols) {
        symbolMap.set(symbol.name, symbol);
    }
    // --- Standard call queries ---
    const functionQuery = `
    (call_expression
      function: (identifier) @callee
      arguments: (_) @args
    ) @call
  `;
    const memberCallQuery = `
    (call_expression
      function: (member_expression
        object: (_) @obj
        property: (property_identifier) @prop
      )
      arguments: (_) @args
    ) @call
  `;
    const newExpressionQuery = `
    (new_expression
      constructor: (identifier) @callee
      arguments: (_) @args
    ) @call
  `;
    const newMemberExpressionQuery = `
    (new_expression
      constructor: (member_expression
        object: (_) @obj
        property: (property_identifier) @prop
      )
      arguments: (_) @args
    ) @call
  `;
    const superCallQuery = `
    (call_expression
      function: (super) @callee
    ) @call
  `;
    // --- 36-1.1: Computed property call detection ---
    // Matches: obj[methodName]() or obj["method"]()
    const computedCallQuery = `
    (call_expression
      function: (subscript_expression
        object: (_) @obj
        index: (_) @index
      )
      arguments: (_) @args
    ) @call
  `;
    // --- 36-1.4: Tagged template string detection ---
    // Matches: tag`template` or obj.method`template`
    const taggedTemplateQuery = `
    (call_expression
      function: (identifier) @callee
      arguments: (template_string)
    ) @call
  `;
    const taggedTemplateMemberQuery = `
    (call_expression
      function: (member_expression
        object: (_) @obj
        property: (property_identifier) @prop
      )
      arguments: (template_string)
    ) @call
  `;
    // Note: tagged_template_expression doesn't exist in tree-sitter-typescript 0.23.x
    // Tagged templates are parsed as call_expression with template_string arguments
    // The taggedTemplateQuery and taggedTemplateMemberQuery above already handle these cases
    // --- 36-1.7: Optional chaining call detection ---
    // Note: In tree-sitter-typescript 0.23.x, optional_chain is a sibling of object/property
    const optionalChainedCallQuery = `
    (call_expression
      function: (member_expression
        object: (_) @obj
        (optional_chain)
        property: (property_identifier) @prop
      )
      arguments: (_) @args
    ) @call
  `;
    const optionalChainedNewQuery = `
    (new_expression
      constructor: (member_expression
        object: (_) @obj
        (optional_chain)
        property: (property_identifier) @prop
      )
      arguments: (_) @args
    ) @call
  `;
    // Collect all matches
    const standardMatches = [
        ...queryTree(tree, functionQuery),
        ...queryTree(tree, memberCallQuery),
        ...queryTree(tree, newExpressionQuery),
        ...queryTree(tree, newMemberExpressionQuery),
        ...queryTree(tree, superCallQuery),
    ];
    const optionalChainedCallMatches = queryTree(tree, optionalChainedCallQuery);
    const optionalChainedNewMatches = queryTree(tree, optionalChainedNewQuery);
    const computedMatches = queryTree(tree, computedCallQuery);
    // Tagged templates are just call_expressions with template_string arguments
    // The taggedTemplateQuery and taggedTemplateMemberQuery handle these cases
    const taggedMatches = [
        ...queryTree(tree, taggedTemplateQuery),
        ...queryTree(tree, taggedTemplateMemberQuery),
    ];
    // Process standard calls
    for (const match of standardMatches) {
        const callNode = match.captures.find((c) => c.name === "call");
        if (!callNode)
            continue;
        // Skip if already processed
        const nodeId = callNode.node.id;
        if (seenCallNodes.has(nodeId))
            continue;
        seenCallNodes.add(nodeId);
        const calleeCapture = match.captures.find((c) => c.name === "callee" || c.name === "prop");
        const objCapture = match.captures.find((c) => c.name === "obj");
        let calleeIdentifier = "";
        let callType = "function";
        let isResolved = false;
        let calleeSymbolId;
        if (calleeCapture) {
            calleeIdentifier = callNode.node.text.includes("new")
                ? `new ${calleeCapture.node.text}`
                : calleeCapture.node.text;
            if (callNode.node.text.includes("new") ||
                callNode.node.type === "new_expression") {
                callType = "constructor";
            }
            else if (objCapture) {
                callType = "method";
            }
            if (objCapture) {
                const objText = objCapture.node.text;
                if (objText === "this" || objText === "super") {
                    isResolved = symbolMap.has(calleeCapture.node.text);
                    if (isResolved) {
                        const resolvedSymbol = symbolMap.get(calleeCapture.node.text);
                        if (resolvedSymbol) {
                            calleeSymbolId = resolvedSymbol.nodeId;
                        }
                    }
                }
                else if (objText === "exports" || objText === "module") {
                    isResolved = false;
                }
                else {
                    const symbol = symbolMap.get(objText);
                    if (symbol &&
                        (symbol.kind === "class" || symbol.kind === "interface")) {
                        isResolved = true;
                        calleeSymbolId = `${objText}.${calleeCapture.node.text}`;
                    }
                }
            }
            else {
                if (calleeCapture.node.text === "require" ||
                    calleeCapture.node.text === "import") {
                    isResolved = false;
                    callType = "dynamic";
                }
                else {
                    const symbol = symbolMap.get(calleeCapture.node.text);
                    if (symbol) {
                        isResolved = true;
                        calleeSymbolId = symbol.nodeId;
                    }
                }
            }
            if (calleeIdentifier.includes(".") &&
                !calleeIdentifier.startsWith("new ")) {
                const parts = calleeIdentifier.split(".");
                const lastPart = parts[parts.length - 1];
                if (parts.length > 2 || !symbolMap.has(lastPart)) {
                    isResolved = false;
                    callType = "dynamic";
                }
            }
        }
        const range = {
            startLine: callNode.node.startPosition.row,
            startCol: callNode.node.startPosition.column,
            endLine: callNode.node.endPosition.row,
            endCol: callNode.node.endPosition.column,
        };
        const callerNodeId = findEnclosingSymbol(callNode.node, extractedSymbols);
        calls.push({
            callerNodeId,
            calleeIdentifier,
            isResolved,
            callType,
            calleeSymbolId,
            range,
        });
    }
    // --- 36-1.7: Process optional chaining calls ---
    for (const match of [
        ...optionalChainedCallMatches,
        ...optionalChainedNewMatches,
    ]) {
        const callNode = match.captures.find((c) => c.name === "call");
        if (!callNode)
            continue;
        const nodeId = callNode.node.id;
        if (seenCallNodes.has(nodeId))
            continue;
        seenCallNodes.add(nodeId);
        const propCapture = match.captures.find((c) => c.name === "prop");
        const objCapture = match.captures.find((c) => c.name === "obj");
        if (!propCapture)
            continue;
        let calleeIdentifier = "";
        let isResolved = false;
        let calleeSymbolId;
        let callType = "method";
        const isConstructor = callNode.node.type === "new_expression";
        if (isConstructor) {
            callType = "constructor";
        }
        if (objCapture) {
            const objText = objCapture.node.text;
            calleeIdentifier = `${objText}?.${propCapture.node.text}`;
            if (objText === "this" || objText === "super") {
                const symbol = symbolMap.get(propCapture.node.text);
                if (symbol) {
                    isResolved = true;
                    calleeSymbolId = symbol.nodeId;
                }
            }
        }
        const range = {
            startLine: callNode.node.startPosition.row,
            startCol: callNode.node.startPosition.column,
            endLine: callNode.node.endPosition.row,
            endCol: callNode.node.endPosition.column,
        };
        const callerNodeId = findEnclosingSymbol(callNode.node, extractedSymbols);
        calls.push({
            callerNodeId,
            calleeIdentifier,
            isResolved,
            callType,
            calleeSymbolId,
            range,
        });
    }
    // --- 36-1.1: Process computed property calls ---
    for (const match of computedMatches) {
        const callNode = match.captures.find((c) => c.name === "call");
        if (!callNode)
            continue;
        const nodeId = callNode.node.id;
        if (seenCallNodes.has(nodeId))
            continue;
        seenCallNodes.add(nodeId);
        const objCapture = match.captures.find((c) => c.name === "obj");
        const indexCapture = match.captures.find((c) => c.name === "index");
        let calleeIdentifier = "";
        let isResolved = false;
        if (objCapture && indexCapture) {
            const objText = objCapture.node.text;
            const indexText = indexCapture.node.text;
            // If index is a string literal, extract the value
            if (indexCapture.node.type === "string" ||
                indexCapture.node.type === "string_fragment") {
                const cleanIndex = indexText.replace(/^['"`]|['"`]$/g, "");
                calleeIdentifier = `${objText}.${cleanIndex}`;
                // Try to resolve if it's a known symbol
                const symbol = symbolMap.get(cleanIndex);
                if (symbol) {
                    isResolved = true;
                }
            }
            else {
                // Dynamic key - still track but mark as dynamic
                calleeIdentifier = `${objText}[${indexText}]`;
            }
        }
        const range = {
            startLine: callNode.node.startPosition.row,
            startCol: callNode.node.startPosition.column,
            endLine: callNode.node.endPosition.row,
            endCol: callNode.node.endPosition.column,
        };
        const callerNodeId = findEnclosingSymbol(callNode.node, extractedSymbols);
        calls.push({
            callerNodeId,
            calleeIdentifier,
            isResolved,
            callType: "computed",
            range,
        });
    }
    // --- 36-1.4: Process tagged template calls ---
    for (const match of taggedMatches) {
        const callNode = match.captures.find((c) => c.name === "call");
        if (!callNode)
            continue;
        const nodeId = callNode.node.id;
        if (seenCallNodes.has(nodeId))
            continue;
        seenCallNodes.add(nodeId);
        const calleeCapture = match.captures.find((c) => c.name === "callee");
        const propCapture = match.captures.find((c) => c.name === "prop");
        const objCapture = match.captures.find((c) => c.name === "obj");
        let calleeIdentifier = "";
        let isResolved = false;
        let calleeSymbolId;
        const callType = "tagged-template";
        if (calleeCapture) {
            calleeIdentifier = calleeCapture.node.text;
            const symbol = symbolMap.get(calleeIdentifier);
            if (symbol) {
                isResolved = true;
                calleeSymbolId = symbol.nodeId;
            }
        }
        else if (propCapture && objCapture) {
            calleeIdentifier = `${objCapture.node.text}.${propCapture.node.text}`;
        }
        const range = {
            startLine: callNode.node.startPosition.row,
            startCol: callNode.node.startPosition.column,
            endLine: callNode.node.endPosition.row,
            endCol: callNode.node.endPosition.column,
        };
        const callerNodeId = findEnclosingSymbol(callNode.node, extractedSymbols);
        calls.push({
            callerNodeId,
            calleeIdentifier,
            isResolved,
            callType,
            calleeSymbolId,
            range,
        });
        // --- 36-1.6: Handle chained method calls ---
        // If this call's function is itself a call_expression, extract those too
        const funcNode = callNode.node.childForFieldName("function");
        if (funcNode) {
            extractChainedCalls(funcNode, callerNodeId, symbolMap, calls, seenCallNodes, extractedSymbols);
        }
    }
    // --- 36-1.2 & 36-1.5: Extract calls from await expressions and arrow functions ---
    extractNestedCalls(tree.rootNode, extractedSymbols, symbolMap, calls, seenCallNodes);
    return calls;
}
/**
 * 36-1.6: Recursively extract chained method calls
 * For: obj.method1().method2().method3()
 */
function extractChainedCalls(node, callerNodeId, symbolMap, calls, seenCallNodes, extractedSymbols) {
    if (!node)
        return;
    // If this is a member_expression whose object is a call_expression
    if (node.type === "member_expression") {
        const objNode = node.childForFieldName("object");
        if (objNode?.type === "call_expression") {
            // This is a chained call - extract the inner call
            if (!seenCallNodes.has(objNode.id)) {
                seenCallNodes.add(objNode.id);
                const funcNode = objNode.childForFieldName("function");
                let calleeIdentifier = "";
                let isResolved = false;
                let calleeSymbolId;
                let callType = "method";
                if (funcNode?.type === "identifier") {
                    calleeIdentifier = funcNode.text;
                    const symbol = symbolMap.get(calleeIdentifier);
                    if (symbol) {
                        isResolved = true;
                        calleeSymbolId = symbol.nodeId;
                    }
                    callType = "function";
                }
                else if (funcNode?.type === "member_expression") {
                    const prop = funcNode.childForFieldName("property");
                    const obj = funcNode.childForFieldName("object");
                    if (prop && obj) {
                        calleeIdentifier = `${obj.text}.${prop.text}`;
                    }
                }
                if (calleeIdentifier) {
                    calls.push({
                        callerNodeId,
                        calleeIdentifier,
                        isResolved,
                        callType,
                        calleeSymbolId,
                        range: {
                            startLine: objNode.startPosition.row,
                            startCol: objNode.startPosition.column,
                            endLine: objNode.endPosition.row,
                            endCol: objNode.endPosition.column,
                        },
                    });
                }
                // Continue recursing for deeper chains
                if (funcNode) {
                    extractChainedCalls(funcNode, callerNodeId, symbolMap, calls, seenCallNodes, extractedSymbols);
                }
            }
        }
    }
    // Also check if node itself is a call_expression
    if (node.type === "call_expression") {
        const funcNode = node.childForFieldName("function");
        if (funcNode) {
            extractChainedCalls(funcNode, callerNodeId, symbolMap, calls, seenCallNodes, extractedSymbols);
        }
    }
}
/**
 * 36-1.2 & 36-1.5: Extract calls from await expressions and arrow function callbacks
 * Walks the entire AST to find calls nested in:
 * - await expressions: await fetchData()
 * - arrow functions: array.map(x => process(x))
 */
function extractNestedCalls(node, extractedSymbols, symbolMap, calls, seenCallNodes) {
    if (!node)
        return;
    // 36-1.2: Handle await expressions - ensure the call inside is captured
    if (node.type === "await_expression") {
        const child = node.firstChild;
        if (child?.type === "call_expression" && !seenCallNodes.has(child.id)) {
            seenCallNodes.add(child.id);
            const callInfo = extractSingleCall(child, extractedSymbols, symbolMap);
            if (callInfo) {
                calls.push(callInfo);
            }
        }
    }
    // 36-1.5: Handle arrow functions - extract calls from their bodies
    if (node.type === "arrow_function") {
        const body = node.childForFieldName("body");
        if (body) {
            // Find the enclosing symbol for this arrow function
            const enclosingSymbol = findEnclosingSymbol(node, extractedSymbols);
            extractCallsFromArrowBody(body, enclosingSymbol, extractedSymbols, symbolMap, calls, seenCallNodes);
        }
    }
    // Recurse into children
    for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child) {
            extractNestedCalls(child, extractedSymbols, symbolMap, calls, seenCallNodes);
        }
    }
}
/**
 * 36-1.5: Extract calls from arrow function body, attributing them to parent symbol
 */
function extractCallsFromArrowBody(body, parentCallerNodeId, extractedSymbols, symbolMap, calls, seenCallNodes) {
    if (!body)
        return;
    // If body is a call_expression directly (concise arrow: x => process(x))
    if (body.type === "call_expression" && !seenCallNodes.has(body.id)) {
        seenCallNodes.add(body.id);
        const callInfo = extractSingleCall(body, extractedSymbols, symbolMap, parentCallerNodeId);
        if (callInfo) {
            calls.push(callInfo);
        }
    }
    // Walk the body for nested calls
    walkForCalls(body, parentCallerNodeId, extractedSymbols, symbolMap, calls, seenCallNodes);
}
/**
 * Walk a node tree looking for call expressions
 */
function walkForCalls(node, callerNodeId, extractedSymbols, symbolMap, calls, seenCallNodes) {
    if (!node)
        return;
    if (node.type === "call_expression" && !seenCallNodes.has(node.id)) {
        seenCallNodes.add(node.id);
        const callInfo = extractSingleCall(node, extractedSymbols, symbolMap, callerNodeId);
        if (callInfo) {
            calls.push(callInfo);
        }
    }
    // Don't descend into nested arrow functions - they get their own parent
    if (node.type === "arrow_function") {
        return;
    }
    for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child) {
            walkForCalls(child, callerNodeId, extractedSymbols, symbolMap, calls, seenCallNodes);
        }
    }
}
/**
 * Extract a single call expression into an ExtractedCall
 */
function extractSingleCall(callNode, extractedSymbols, symbolMap, overrideCallerNodeId) {
    const funcNode = callNode.childForFieldName("function");
    if (!funcNode)
        return null;
    let calleeIdentifier = "";
    let callType = "function";
    let isResolved = false;
    let calleeSymbolId;
    if (funcNode.type === "identifier") {
        calleeIdentifier = funcNode.text;
        if (calleeIdentifier !== "require" && calleeIdentifier !== "import") {
            const symbol = symbolMap.get(calleeIdentifier);
            if (symbol) {
                isResolved = true;
                calleeSymbolId = symbol.nodeId;
            }
        }
        else {
            callType = "dynamic";
        }
    }
    else if (funcNode.type === "member_expression") {
        const obj = funcNode.childForFieldName("object");
        const prop = funcNode.childForFieldName("property");
        if (obj && prop) {
            calleeIdentifier = `${obj.text}.${prop.text}`;
            callType = "method";
            if (obj.text === "this" || obj.text === "super") {
                const symbol = symbolMap.get(prop.text);
                if (symbol) {
                    isResolved = true;
                    calleeSymbolId = symbol.nodeId;
                }
            }
        }
    }
    else if (funcNode.type === "super") {
        calleeIdentifier = "super";
    }
    if (!calleeIdentifier)
        return null;
    const callerNodeId = overrideCallerNodeId ?? findEnclosingSymbol(callNode, extractedSymbols);
    return {
        callerNodeId,
        calleeIdentifier,
        isResolved,
        callType,
        calleeSymbolId,
        range: {
            startLine: callNode.startPosition.row,
            startCol: callNode.startPosition.column,
            endLine: callNode.endPosition.row,
            endCol: callNode.endPosition.column,
        },
    };
}
export { findEnclosingSymbol as findEnclosingSymbol };
//# sourceMappingURL=extractCalls.js.map