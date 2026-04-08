// TypeScript / JavaScript call extractor (Task 1.8).
//
// Output-parity target: `src/indexer/treesitter/extractCalls.ts`.
//
// The TypeScript source-of-truth uses tree-sitter Queries for a "standard"
// pass (plain function / member / new / super / optional-chain / computed /
// tagged-template) followed by a recursive walk that catches calls inside
// `await_expression` and `arrow_function` bodies. Rather than introduce a
// Query layer here, we achieve the same output set with two recursive
// passes that mimic the TS semantics node-by-node:
//
//   1. `walk_standard_calls` — dispatches on `call_expression` and
//      `new_expression` node kinds, classifying each callee by the kind of
//      its `function` / `constructor` child. Handles the post-hoc `.`
//      demotion rule and the tagged-template chained recursion.
//
//   2. `walk_nested_calls` — dedicated pass for `await_expression` and
//      `arrow_function`, using the simpler `extract_single_call` shape the
//      TS side applies when attributing calls to a parent symbol across an
//      arrow boundary. A shared `seen` set deduplicates with pass (1).
//
// The parity harness (`tests/harness/engine-parity-runner.ts`) excludes
// `isResolved` / `calleeSymbolId` / `candidateCount` from comparison — they
// are Pass-2 concerns and `rustIndexer.ts::mapNativeCall` hard-codes
// `isResolved: false`. So this module only needs to match
// `callerNodeId` / `calleeIdentifier` / `callType` / `range` exactly.
//
// Symbol map semantics: TS uses first-wins (`if (!symbolMap.has(name)) …`),
// so we build the map with `entry(name).or_insert(symbol)` — never plain
// `insert`, which would be last-wins and corrupt the demotion rule.

use std::collections::{HashMap, HashSet};

use tree_sitter::Node;

use crate::types::{NativeParsedCall, NativeParsedSymbol};

use super::common::{extract_range, find_enclosing_symbol, node_text};

pub fn extract_calls_ts(
    root: Node<'_>,
    source: &[u8],
    symbols: &[NativeParsedSymbol],
) -> Vec<NativeParsedCall> {
    // First-wins symbol map keyed on name (matches TS `symbolMap`).
    let mut symbol_map: HashMap<&str, &NativeParsedSymbol> = HashMap::new();
    for sym in symbols {
        symbol_map
            .entry(sym.name.as_str())
            .or_insert(sym);
    }

    let mut calls: Vec<NativeParsedCall> = Vec::new();
    let mut seen: HashSet<usize> = HashSet::new();

    // Pass 1: standard call classification (mirrors TS query passes).
    walk_standard_calls(root, source, symbols, &symbol_map, &mut calls, &mut seen);

    // Pass 2: nested walk for await / arrow-function body attribution
    // (mirrors TS `extractNestedCalls`).
    walk_nested_calls(root, source, symbols, &symbol_map, &mut calls, &mut seen);

    calls
}

// ---------------------------------------------------------------------------
// Pass 1 — standard call classification
// ---------------------------------------------------------------------------

fn walk_standard_calls(
    node: Node<'_>,
    source: &[u8],
    symbols: &[NativeParsedSymbol],
    symbol_map: &HashMap<&str, &NativeParsedSymbol>,
    calls: &mut Vec<NativeParsedCall>,
    seen: &mut HashSet<usize>,
) {
    match node.kind() {
        "call_expression" => {
            if !seen.contains(&node.id()) {
                seen.insert(node.id());
                process_standard_call(node, source, symbols, symbol_map, calls, seen);
            }
        }
        "new_expression" => {
            if !seen.contains(&node.id()) {
                seen.insert(node.id());
                process_new_expression(node, source, symbols, symbol_map, calls);
            }
        }
        _ => {}
    }

    // Recurse into every child — nested calls are still classified by the
    // standard logic first; the "nested" pass runs afterwards for await /
    // arrow attribution.
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        walk_standard_calls(child, source, symbols, symbol_map, calls, seen);
    }
}

/// Classify a `call_expression` node. Handles plain function / method /
/// super / computed / tagged-template / optional-chain, plus the post-hoc
/// `.`→dynamic demotion.
fn process_standard_call(
    call_node: Node<'_>,
    source: &[u8],
    symbols: &[NativeParsedSymbol],
    symbol_map: &HashMap<&str, &NativeParsedSymbol>,
    calls: &mut Vec<NativeParsedCall>,
    seen: &mut HashSet<usize>,
) {
    let func_node = match call_node.child_by_field_name("function") {
        Some(n) => n,
        None => return,
    };

    // NB: TS source-of-truth treats tagged templates (`tag`tpl``) as
    // regular `call_expression` nodes whose `arguments` field is a
    // `template_string`. In the TS pipeline, the standard function /
    // member queries run FIRST and match these nodes (because the
    // `arguments: (_)` predicate matches `template_string` too), so they
    // get classified as `function` / `method` and inserted into
    // `seenCallNodes`. The dedicated tagged-template loop runs second and
    // finds them already seen, so `tagged-template` is effectively dead
    // code in the TS output — the only cases it would fire are cases
    // the standard loop already covered. We replicate that by never
    // emitting `tagged-template` from the standard classification path.

    let callee_identifier: String;
    let mut call_type: &'static str;

    match func_node.kind() {
        "identifier" => {
            let name = node_text(func_node, source);
            callee_identifier = name.to_string();
            if name == "require" || name == "import" {
                call_type = "dynamic";
            } else {
                call_type = "function";
            }
        }
        "super" => {
            // `super()` — the super query captures `function: (super) @callee`
            // and the resulting identifier is literally "super".
            callee_identifier = node_text(func_node, source).to_string();
            call_type = "function";
        }
        "member_expression" => {
            // NB: TS optional-chain calls (`svc?.doWork()`) are *also* dead
            // code in the TS output — the standard `memberCallQuery` uses
            // `object: (_)` which matches any object child (including one
            // with a sibling `optional_chain`), so the standard pass
            // emits them as plain `method` calls with identifier = prop
            // name *before* the optional-chain loop runs. We match that
            // behaviour by ignoring `optional_chain` and always emitting
            // the bare property name.
            let prop = match func_node.child_by_field_name("property") {
                Some(n) => n,
                None => return,
            };
            if prop.kind() != "property_identifier" {
                // TS standard queries require `property: (property_identifier)`.
                return;
            }
            let prop_text = node_text(prop, source);
            callee_identifier = prop_text.to_string();
            call_type = "method";
        }
        "subscript_expression" => {
            // Computed call: `obj[index]()`.
            let obj = match func_node.child_by_field_name("object") {
                Some(n) => n,
                None => return,
            };
            let index = match func_node.child_by_field_name("index") {
                Some(n) => n,
                None => return,
            };
            let obj_text = node_text(obj, source);
            let index_text = node_text(index, source);

            if index.kind() == "string" || index.kind() == "string_fragment" {
                // Strip leading/trailing quotes (match TS
                // `indexText.replace(/^['"\`]|['"\`]$/g, "")`).
                let clean_index = strip_string_quotes(index_text);
                callee_identifier = format!("{obj_text}.{clean_index}");
            } else {
                callee_identifier = format!("{obj_text}[{index_text}]");
            }
            call_type = "computed";
        }
        _ => {
            // Function is something exotic (parenthesized_expression,
            // call_expression for a chain, etc.). The TS standard queries
            // never match these, so neither do we.
            return;
        }
    }

    // --- Post-hoc demotion (TS: `if (calleeIdentifier.includes(".") && ...)`).
    //
    // Runs on the standard-pass identifier only. Tagged-template, optional-
    // chain and computed classifications happen in their own TS loops where
    // the demotion rule does NOT run — so we gate it to matching call_type.
    if matches!(call_type, "function" | "method") {
        if callee_identifier.contains('.') && !callee_identifier.starts_with("new ") {
            let parts: Vec<&str> = callee_identifier.split('.').collect();
            let last_part = parts.last().copied().unwrap_or("");
            if parts.len() > 2 || !symbol_map.contains_key(last_part) {
                call_type = "dynamic";
            }
        }
    }

    let caller_node_id = find_enclosing_symbol(call_node, symbols);

    calls.push(NativeParsedCall {
        caller_node_id,
        callee_identifier,
        call_type: call_type.to_string(),
        range: extract_range(call_node),
    });

    // Tagged-template chained-call recursion: the TS
    // `extractChainedCalls(funcNode, ...)` runs immediately after a
    // tagged-template emit. Because our standard classification never
    // emits `tagged-template` (see comment above), we also never enter
    // this recursion — matching TS output, which only reaches it when
    // the tagged loop processes a node the standard loop didn't. That
    // case doesn't occur for any AST shape the tagged queries can match.
    let _ = (func_node, seen);
}

fn process_new_expression(
    new_node: Node<'_>,
    source: &[u8],
    symbols: &[NativeParsedSymbol],
    symbol_map: &HashMap<&str, &NativeParsedSymbol>,
    calls: &mut Vec<NativeParsedCall>,
) {
    // TS standard new queries require `arguments: (_)` — argless `new Foo`
    // is not emitted. Enforce the same.
    if new_node.child_by_field_name("arguments").is_none() {
        return;
    }

    let constructor = match new_node.child_by_field_name("constructor") {
        Some(n) => n,
        None => return,
    };

    let callee_identifier: String;

    match constructor.kind() {
        "identifier" => {
            let name = node_text(constructor, source);
            callee_identifier = format!("new {name}");
        }
        "member_expression" => {
            // TS optional-chain `new`s are dead code for the same reason
            // optional-chain call_expressions are: the standard
            // `newMemberExpressionQuery` uses `object: (_)` which matches
            // any object child, so it wins on query order and emits
            // `new ${prop.text}` (prop name only). We always emit that
            // form, never the optional `${obj}?.${prop}` shape.
            let prop = match constructor.child_by_field_name("property") {
                Some(n) => n,
                None => return,
            };
            if prop.kind() != "property_identifier" {
                return;
            }
            let prop_text = node_text(prop, source);
            callee_identifier = format!("new {prop_text}");
        }
        _ => return,
    }

    let caller_node_id = find_enclosing_symbol(new_node, symbols);

    calls.push(NativeParsedCall {
        caller_node_id,
        callee_identifier,
        call_type: "constructor".to_string(),
        range: extract_range(new_node),
    });

    // Silence unused-parameter lint for symbol_map — the optional-chain
    // path doesn't consult it, matching TS.
    let _ = symbol_map;
}

fn strip_string_quotes(raw: &str) -> &str {
    let trimmed = raw
        .strip_prefix('\'')
        .or_else(|| raw.strip_prefix('"'))
        .or_else(|| raw.strip_prefix('`'))
        .unwrap_or(raw);
    let trimmed = trimmed
        .strip_suffix('\'')
        .or_else(|| trimmed.strip_suffix('"'))
        .or_else(|| trimmed.strip_suffix('`'))
        .unwrap_or(trimmed);
    trimmed
}

// ---------------------------------------------------------------------------
// Pass 2 — nested walk for await / arrow-body attribution
// ---------------------------------------------------------------------------

fn walk_nested_calls(
    node: Node<'_>,
    source: &[u8],
    symbols: &[NativeParsedSymbol],
    symbol_map: &HashMap<&str, &NativeParsedSymbol>,
    calls: &mut Vec<NativeParsedCall>,
    seen: &mut HashSet<usize>,
) {
    // Await expression: if the first child is a call_expression, try to
    // emit it via `extract_single_call`. The TS uses `node.firstChild`
    // which in tree-sitter is `child(0)` (named + unnamed).
    if node.kind() == "await_expression" {
        if let Some(child) = node.child(0) {
            if child.kind() == "call_expression" && !seen.contains(&child.id()) {
                seen.insert(child.id());
                if let Some(call) =
                    extract_single_call(child, source, symbols, symbol_map, None)
                {
                    calls.push(call);
                }
            }
        }
    }

    // Arrow function body: attribute nested calls to the arrow's own
    // enclosing symbol, matching the TS override.
    if node.kind() == "arrow_function" {
        if let Some(body) = node.child_by_field_name("body") {
            let parent_caller = find_enclosing_symbol(node, symbols);

            // Concise arrow: `x => process(x)` — body is a call_expression.
            if body.kind() == "call_expression" && !seen.contains(&body.id()) {
                seen.insert(body.id());
                if let Some(call) = extract_single_call(
                    body,
                    source,
                    symbols,
                    symbol_map,
                    Some(parent_caller.clone()),
                ) {
                    calls.push(call);
                }
            }

            // Walk the body for any nested call_expression nodes, stopping
            // at inner arrow_functions (they get their own attribution).
            walk_for_calls(
                body,
                parent_caller.as_str(),
                source,
                symbols,
                symbol_map,
                calls,
                seen,
            );
        }
    }

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        walk_nested_calls(child, source, symbols, symbol_map, calls, seen);
    }
}

/// Walk a subtree looking for call_expression nodes, emitting each via
/// `extract_single_call` with an overridden caller. Stops at nested
/// `arrow_function` boundaries (they get their own parent attribution).
fn walk_for_calls(
    node: Node<'_>,
    caller_node_id: &str,
    source: &[u8],
    symbols: &[NativeParsedSymbol],
    symbol_map: &HashMap<&str, &NativeParsedSymbol>,
    calls: &mut Vec<NativeParsedCall>,
    seen: &mut HashSet<usize>,
) {
    if node.kind() == "call_expression" && !seen.contains(&node.id()) {
        seen.insert(node.id());
        if let Some(call) = extract_single_call(
            node,
            source,
            symbols,
            symbol_map,
            Some(caller_node_id.to_string()),
        ) {
            calls.push(call);
        }
    }

    // CRITICAL: do not descend into nested arrow_function bodies. Their
    // calls are attributed to the inner arrow (via the outer walk), not
    // the current caller.
    if node.kind() == "arrow_function" {
        return;
    }

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        walk_for_calls(child, caller_node_id, source, symbols, symbol_map, calls, seen);
    }
}

/// Minimal call classifier used by the nested walk. Mirrors TS
/// `extractSingleCall`: only `identifier` / `member_expression` / `super`
/// function kinds are recognised, and the member form uses the full
/// `${obj}.${prop}` identifier shape.
fn extract_single_call(
    call_node: Node<'_>,
    source: &[u8],
    symbols: &[NativeParsedSymbol],
    _symbol_map: &HashMap<&str, &NativeParsedSymbol>,
    override_caller: Option<String>,
) -> Option<NativeParsedCall> {
    let func_node = call_node.child_by_field_name("function")?;

    let mut callee_identifier = String::new();
    let mut call_type: &'static str = "function";

    match func_node.kind() {
        "identifier" => {
            let name = node_text(func_node, source);
            callee_identifier = name.to_string();
            if name == "require" || name == "import" {
                call_type = "dynamic";
            }
        }
        "member_expression" => {
            let obj = func_node.child_by_field_name("object");
            let prop = func_node.child_by_field_name("property");
            if let (Some(o), Some(p)) = (obj, prop) {
                let obj_text = node_text(o, source);
                let prop_text = node_text(p, source);
                callee_identifier = format!("{obj_text}.{prop_text}");
                call_type = "method";
            }
        }
        "super" => {
            callee_identifier = "super".to_string();
        }
        _ => return None,
    }

    if callee_identifier.is_empty() {
        return None;
    }

    let caller_node_id =
        override_caller.unwrap_or_else(|| find_enclosing_symbol(call_node, symbols));

    Some(NativeParsedCall {
        caller_node_id,
        callee_identifier,
        call_type: call_type.to_string(),
        range: extract_range(call_node),
    })
}
