use std::collections::HashSet;

use tree_sitter::Node;

use crate::types::{NativeParsedCall, NativeParsedSymbol};

use super::common::{extract_range, find_enclosing_symbol, node_text};

pub fn extract_calls_rust(
    root: Node<'_>,
    source: &[u8],
    symbols: &[NativeParsedSymbol],
) -> Vec<NativeParsedCall> {
    let mut calls = Vec::new();
    let mut seen_nodes: HashSet<usize> = HashSet::new();
    let mut stack = vec![root];

    while let Some(node) = stack.pop() {
        match node.kind() {
            "call_expression" => {
                if seen_nodes.insert(node.id()) {
                    if let Some(call) = parse_call_expression(node, source, symbols) {
                        calls.push(call);
                    }
                }
            }
            "macro_invocation" => {
                if seen_nodes.insert(node.id()) {
                    if let Some(call) = parse_macro_invocation(node, source, symbols) {
                        calls.push(call);
                    }
                }
            }
            _ => {}
        }

        let child_count = node.child_count();
        for i in (0..child_count).rev() {
            if let Some(child) = node.child(i) {
                stack.push(child);
            }
        }
    }

    calls
}

fn parse_call_expression(
    node: Node<'_>,
    source: &[u8],
    symbols: &[NativeParsedSymbol],
) -> Option<NativeParsedCall> {
    let function_node = node.child_by_field_name("function")?;

    let (callee_identifier, call_type) = match function_node.kind() {
        "identifier" => {
            let callee = node_text(function_node, source).to_string();
            if callee.is_empty() {
                return None;
            }
            (callee, "function".to_string())
        }
        "scoped_identifier" => {
            let path = function_node.child_by_field_name("path");
            let name = function_node.child_by_field_name("name");

            let callee = match (path, name) {
                (Some(path), Some(name)) => {
                    let path_text = node_text(path, source);
                    let name_text = node_text(name, source);
                    if path_text.is_empty() || name_text.is_empty() {
                        node_text(function_node, source).to_string()
                    } else {
                        format!("{path_text}::{name_text}")
                    }
                }
                _ => node_text(function_node, source).to_string(),
            };

            if callee.is_empty() {
                return None;
            }

            (callee, "function".to_string())
        }
        "field_expression" => {
            let value = function_node.child_by_field_name("value")?;
            let field = function_node.child_by_field_name("field")?;

            let value_text = node_text(value, source);
            let field_text = node_text(field, source);
            if value_text.is_empty() || field_text.is_empty() {
                return None;
            }

            (format!("{value_text}.{field_text}"), "method".to_string())
        }
        _ => {
            let callee = node_text(function_node, source).to_string();
            if callee.is_empty() {
                return None;
            }
            (callee, "dynamic".to_string())
        }
    };

    Some(NativeParsedCall {
        caller_node_id: find_enclosing_symbol(node, symbols),
        callee_identifier,
        call_type,
        range: extract_range(node),
    })
}

fn parse_macro_invocation(
    node: Node<'_>,
    source: &[u8],
    symbols: &[NativeParsedSymbol],
) -> Option<NativeParsedCall> {
    let macro_node = node.child_by_field_name("macro")?;
    let macro_name = node_text(macro_node, source).to_string();
    if macro_name.is_empty() {
        return None;
    }

    Some(NativeParsedCall {
        caller_node_id: find_enclosing_symbol(node, symbols),
        callee_identifier: format!("{macro_name}!"),
        call_type: "dynamic".to_string(),
        range: extract_range(node),
    })
}
