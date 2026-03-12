use std::collections::{HashMap, HashSet};

use tree_sitter::Node;

use crate::types::{NativeParsedCall, NativeParsedSymbol};

use super::common::{extract_range, find_enclosing_symbol, node_text};

pub fn extract_calls_java(
    root: Node<'_>,
    source: &[u8],
    symbols: &[NativeParsedSymbol],
) -> Vec<NativeParsedCall> {
    let symbol_map: HashMap<&str, &NativeParsedSymbol> = symbols
        .iter()
        .map(|symbol| (symbol.name.as_str(), symbol))
        .collect();

    let mut calls = Vec::new();
    let mut seen_nodes: HashSet<usize> = HashSet::new();
    let mut stack = vec![root];

    while let Some(node) = stack.pop() {
        match node.kind() {
            "method_invocation" => {
                if seen_nodes.insert(node.id()) {
                    if let Some(call) = parse_method_invocation(node, source, symbols, &symbol_map)
                    {
                        calls.push(call);
                    }
                }
            }
            "object_creation_expression" => {
                if seen_nodes.insert(node.id()) {
                    if let Some(call) = parse_object_creation(node, source, symbols, &symbol_map) {
                        calls.push(call);
                    }
                }
            }
            "call_expression" => {
                if seen_nodes.insert(node.id()) {
                    if let Some(call) = parse_call_expression(node, source, symbols) {
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

fn parse_method_invocation(
    node: Node<'_>,
    source: &[u8],
    symbols: &[NativeParsedSymbol],
    symbol_map: &HashMap<&str, &NativeParsedSymbol>,
) -> Option<NativeParsedCall> {
    let object_node = node.child_by_field_name("object");
    let name_node = node.child_by_field_name("name");

    let (callee_identifier, call_type) = if let Some(object) = object_node {
        let object_text = node_text(object, source);
        let name = name_node
            .map(|name| node_text(name, source).to_string())
            .unwrap_or_default();
        if object_text.is_empty() || name.is_empty() {
            return None;
        }
        (format!("{object_text}.{name}"), "method".to_string())
    } else if let Some(name) = name_node {
        let name_text = node_text(name, source).to_string();
        if name_text.is_empty() {
            return None;
        }

        let call_type = if name_text == "this" || name_text == "super" {
            "constructor"
        } else {
            "method"
        };
        (name_text, call_type.to_string())
    } else {
        return None;
    };

    let _resolved_symbol = symbol_map
        .get(callee_identifier.split('.').next_back().unwrap_or(""))
        .copied();

    Some(NativeParsedCall {
        caller_name: find_enclosing_symbol(node, symbols),
        callee_identifier,
        call_type,
        range: extract_range(node),
    })
}

fn parse_object_creation(
    node: Node<'_>,
    source: &[u8],
    symbols: &[NativeParsedSymbol],
    symbol_map: &HashMap<&str, &NativeParsedSymbol>,
) -> Option<NativeParsedCall> {
    let type_node = node
        .child_by_field_name("type")
        .or_else(|| node.child_by_field_name("constructor"))
        .or_else(|| node.child_by_field_name("name"));

    let type_text = type_node
        .map(|n| node_text(n, source).to_string())
        .or_else(|| find_type_like_child(node, source))?;

    if type_text.is_empty() {
        return None;
    }

    let _resolved_symbol = symbol_map.get(type_text.as_str()).copied();

    Some(NativeParsedCall {
        caller_name: find_enclosing_symbol(node, symbols),
        callee_identifier: format!("new {type_text}"),
        call_type: "constructor".to_string(),
        range: extract_range(node),
    })
}

fn parse_call_expression(
    node: Node<'_>,
    source: &[u8],
    symbols: &[NativeParsedSymbol],
) -> Option<NativeParsedCall> {
    let function = node.child_by_field_name("function")?;

    if function.kind() == "identifier" {
        let callee_identifier = node_text(function, source).to_string();
        if callee_identifier.is_empty() {
            return None;
        }

        return Some(NativeParsedCall {
            caller_name: find_enclosing_symbol(node, symbols),
            callee_identifier,
            call_type: "direct".to_string(),
            range: extract_range(node),
        });
    }

    None
}

fn find_type_like_child(node: Node<'_>, source: &[u8]) -> Option<String> {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if matches!(
            child.kind(),
            "type_identifier" | "generic_type" | "scoped_type_identifier"
        ) {
            let text = node_text(child, source).to_string();
            if !text.is_empty() {
                return Some(text);
            }
        }
    }
    None
}
