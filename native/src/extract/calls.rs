use std::collections::{HashMap, HashSet};
use tree_sitter::Node;

use crate::types::{NativeParsedCall, NativeParsedSymbol, NativeRange};

/// Extract all call sites from a parsed AST.
///
/// Mirrors TypeScript `extractCalls` in `treesitter/extractCalls.ts`.
/// Handles 7 call variants:
///   1. Direct function calls
///   2. Method calls
///   3. Constructor calls (new)
///   4. Super calls
///   5. Computed property calls
///   6. Tagged template calls
///   7. Optional chaining calls
///
/// Instead of tree-sitter queries, we walk the AST directly.
pub fn extract_calls(
    root: Node<'_>,
    source: &[u8],
    symbols: &[NativeParsedSymbol],
    _language: &str,
) -> Vec<NativeParsedCall> {
    let symbol_map: HashMap<&str, &NativeParsedSymbol> = symbols
        .iter()
        .map(|s| (s.name.as_str(), s))
        .collect();

    let mut calls = Vec::new();
    let mut seen_nodes: HashSet<usize> = HashSet::new();

    walk_for_calls(root, source, symbols, &symbol_map, &mut calls, &mut seen_nodes);

    calls
}

fn walk_for_calls(
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
                process_call_expression(node, source, symbols, symbol_map, calls);
            }
        }
        "new_expression" => {
            if !seen.contains(&node.id()) {
                seen.insert(node.id());
                process_new_expression(node, source, symbols, symbol_map, calls);
            }
        }
        "await_expression" => {
            // Ensure call inside await is captured
            if let Some(child) = node.child(1).or_else(|| node.child(0)) {
                if child.kind() == "call_expression" && !seen.contains(&child.id()) {
                    seen.insert(child.id());
                    process_call_expression(child, source, symbols, symbol_map, calls);
                }
            }
        }
        _ => {}
    }

    // Recurse into children
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        walk_for_calls(child, source, symbols, symbol_map, calls, seen);
    }
}

#[allow(unused_variables)]
fn process_call_expression(
    call_node: Node<'_>,
    source: &[u8],
    symbols: &[NativeParsedSymbol],
    symbol_map: &HashMap<&str, &NativeParsedSymbol>,
    calls: &mut Vec<NativeParsedCall>,
) {
    let func_node = match call_node.child_by_field_name("function") {
        Some(n) => n,
        None => return,
    };

    let (callee_identifier, call_type) = match func_node.kind() {
        "identifier" => {
            let name = node_text(func_node, source);
            let ct = if name == "require" || name == "import" {
                "dynamic"
            } else {
                "direct"
            };
            (name.to_string(), ct.to_string())
        }
        "member_expression" => {
            let obj = func_node.child_by_field_name("object");
            let prop = func_node.child_by_field_name("property");

            match (obj, prop) {
                (Some(o), Some(p)) => {
                    let obj_text = node_text(o, source);
                    let prop_text = node_text(p, source);

                    // Check for optional chain
                    let has_optional = {
                        let mut cursor = func_node.walk();
                        let result = func_node
                            .children(&mut cursor)
                            .any(|c| c.kind() == "optional_chain");
                        result
                    };

                    let ident = if has_optional {
                        format!("{obj_text}?.{prop_text}")
                    } else {
                        format!("{obj_text}.{prop_text}")
                    };

                    (ident, "method".to_string())
                }
                _ => return,
            }
        }
        "super" => ("super".to_string(), "method".to_string()),
        "subscript_expression" => {
            // Computed property call: obj[key]()
            let obj = func_node.child_by_field_name("object");
            let index = func_node.child_by_field_name("index");

            match (obj, index) {
                (Some(o), Some(i)) => {
                    let obj_text = node_text(o, source);
                    let index_text = node_text(i, source);

                    let ident = if i.kind() == "string" || i.kind() == "string_fragment" {
                        let clean = index_text
                            .trim_start_matches(|c| c == '\'' || c == '"' || c == '`')
                            .trim_end_matches(|c| c == '\'' || c == '"' || c == '`');
                        format!("{obj_text}.{clean}")
                    } else {
                        format!("{obj_text}[{index_text}]")
                    };

                    (ident, "computed".to_string())
                }
                _ => return,
            }
        }
        _ => {
            // For other node types, try to get text
            let text = node_text(func_node, source);
            if text.is_empty() {
                return;
            }
            (text.to_string(), "dynamic".to_string())
        }
    };

    if callee_identifier.is_empty() {
        return;
    }

    // Check if arguments include a template_string (tagged template)
    let has_template_arg = {
        let args = call_node.child_by_field_name("arguments");
        args.map(|a| a.kind() == "template_string").unwrap_or(false)
    };

    let final_call_type = if has_template_arg && call_type != "computed" {
        "tagged_template".to_string()
    } else {
        call_type
    };

    let caller_name = find_enclosing_symbol(call_node, symbols, source);

    calls.push(NativeParsedCall {
        caller_name,
        callee_identifier,
        call_type: final_call_type,
        range: extract_range(call_node),
    });
}

fn process_new_expression(
    new_node: Node<'_>,
    source: &[u8],
    symbols: &[NativeParsedSymbol],
    _symbol_map: &HashMap<&str, &NativeParsedSymbol>,
    calls: &mut Vec<NativeParsedCall>,
) {
    let constructor = match new_node.child_by_field_name("constructor") {
        Some(n) => n,
        None => return,
    };

    let callee = match constructor.kind() {
        "identifier" => {
            let name = node_text(constructor, source);
            format!("new {name}")
        }
        "member_expression" => {
            let obj = constructor.child_by_field_name("object");
            let prop = constructor.child_by_field_name("property");

            match (obj, prop) {
                (Some(o), Some(p)) => {
                    let obj_text = node_text(o, source);
                    let prop_text = node_text(p, source);
                    format!("new {obj_text}.{prop_text}")
                }
                _ => return,
            }
        }
        _ => return,
    };

    let caller_name = find_enclosing_symbol(new_node, symbols, source);

    calls.push(NativeParsedCall {
        caller_name,
        callee_identifier: callee,
        call_type: "constructor".to_string(),
        range: extract_range(new_node),
    });
}

/// Find the enclosing symbol for a node.
/// Walks up the AST to find the nearest function/class/method declaration.
fn find_enclosing_symbol(
    node: Node<'_>,
    symbols: &[NativeParsedSymbol],
    _source: &[u8],
) -> String {
    let node_start_line = node.start_position().row + 1;
    let node_end_line = node.end_position().row + 1;

    // Find the smallest symbol that contains this node
    let mut best: Option<&NativeParsedSymbol> = None;
    let mut best_size = u32::MAX;

    for sym in symbols {
        let sym_start = sym.range.start_line;
        let sym_end = sym.range.end_line;

        if sym_start <= node_start_line as u32
            && sym_end >= node_end_line as u32
        {
            let size = sym_end - sym_start;
            if size < best_size {
                best = Some(sym);
                best_size = size;
            }
        }
    }

    best.map(|s| s.name.clone()).unwrap_or_else(|| "<module>".to_string())
}

fn node_text<'a>(node: Node<'a>, source: &'a [u8]) -> &'a str {
    node.utf8_text(source).unwrap_or("")
}

fn extract_range(node: Node<'_>) -> NativeRange {
    let start = node.start_position();
    let end = node.end_position();
    NativeRange {
        start_line: (start.row + 1) as u32,
        start_col: start.column as u32,
        end_line: (end.row + 1) as u32,
        end_col: end.column as u32,
    }
}
