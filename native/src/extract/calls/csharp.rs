use std::collections::HashSet;

use tree_sitter::Node;

use crate::types::{NativeParsedCall, NativeParsedSymbol};

use super::common::{extract_range, find_enclosing_symbol, node_text};

pub fn extract_calls_csharp(
    root: Node<'_>,
    source: &[u8],
    symbols: &[NativeParsedSymbol],
) -> Vec<NativeParsedCall> {
    let mut calls = Vec::new();
    let mut seen_nodes: HashSet<usize> = HashSet::new();
    let mut stack = vec![root];

    while let Some(node) = stack.pop() {
        match node.kind() {
            "invocation_expression" => {
                if seen_nodes.insert(node.id()) {
                    if let Some(call) = process_invocation_expression(node, source, symbols) {
                        calls.push(call);
                    }
                }
            }
            "object_creation_expression" => {
                if seen_nodes.insert(node.id()) {
                    if let Some(call) = process_object_creation_expression(node, source, symbols) {
                        calls.push(call);
                    }
                }
            }
            "await_expression" => {
                process_await_expression(node, source, symbols, &mut seen_nodes, &mut calls);
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

fn process_invocation_expression(
    node: Node<'_>,
    source: &[u8],
    symbols: &[NativeParsedSymbol],
) -> Option<NativeParsedCall> {
    let func_node = node.child_by_field_name("function")?;

    let (callee_identifier, call_type) = match func_node.kind() {
        "identifier" => {
            let name = node_text(func_node, source).to_string();
            if name.is_empty() {
                return None;
            }
            (name, "function".to_string())
        }
        "member_access_expression" => {
            let name = member_access_identifier(func_node, source)?;
            (name, "method".to_string())
        }
        "generic_name" => {
            let name_node = func_node
                .child_by_field_name("name")
                .or_else(|| find_first_descendant(func_node, "identifier"));
            let Some(name_node) = name_node else {
                return None;
            };
            let name = node_text(name_node, source).to_string();
            if name.is_empty() {
                return None;
            }
            (name, "function".to_string())
        }
        _ => {
            let name = node_text(func_node, source).to_string();
            if name.is_empty() {
                return None;
            }
            (name, "dynamic".to_string())
        }
    };

    Some(NativeParsedCall {
        caller_node_id: find_enclosing_symbol(node, symbols),
        callee_identifier,
        call_type,
        range: extract_range(node),
    })
}

fn process_object_creation_expression(
    node: Node<'_>,
    source: &[u8],
    symbols: &[NativeParsedSymbol],
) -> Option<NativeParsedCall> {
    let type_node = node
        .child_by_field_name("type")
        .or_else(|| node.child_by_field_name("constructor"))
        .or_else(|| node.child_by_field_name("name"))
        .or_else(|| find_type_like_child(node));

    let Some(type_node) = type_node else {
        return None;
    };

    let type_text = if type_node.kind() == "generic_name" {
        let name_node = type_node
            .child_by_field_name("name")
            .or_else(|| find_first_descendant(type_node, "identifier"));
        let Some(name_node) = name_node else {
            return None;
        };
        node_text(name_node, source).to_string()
    } else {
        node_text(type_node, source).to_string()
    };

    if type_text.is_empty() {
        return None;
    }

    Some(NativeParsedCall {
        caller_node_id: find_enclosing_symbol(node, symbols),
        callee_identifier: format!("new {type_text}"),
        call_type: "constructor".to_string(),
        range: extract_range(node),
    })
}

fn process_await_expression(
    node: Node<'_>,
    source: &[u8],
    symbols: &[NativeParsedSymbol],
    seen_nodes: &mut HashSet<usize>,
    calls: &mut Vec<NativeParsedCall>,
) {
    let child_count = node.child_count();
    for i in 0..child_count {
        let Some(child) = node.child(i) else {
            continue;
        };

        match child.kind() {
            "invocation_expression" => {
                if seen_nodes.insert(child.id()) {
                    if let Some(call) = process_invocation_expression(child, source, symbols) {
                        calls.push(call);
                    }
                }
            }
            "object_creation_expression" => {
                if seen_nodes.insert(child.id()) {
                    if let Some(call) = process_object_creation_expression(child, source, symbols) {
                        calls.push(call);
                    }
                }
            }
            _ => {}
        }
    }
}

fn member_access_identifier(node: Node<'_>, source: &[u8]) -> Option<String> {
    if node.kind() != "member_access_expression" {
        return None;
    }

    let expression = node.child_by_field_name("expression");
    let name = node.child_by_field_name("name");

    match (expression, name) {
        (Some(lhs), Some(rhs)) => {
            let lhs_text = node_text(lhs, source);
            let rhs_text = node_text(rhs, source);
            if lhs_text.is_empty() || rhs_text.is_empty() {
                return None;
            }
            Some(format!("{lhs_text}.{rhs_text}"))
        }
        _ => {
            let text = node_text(node, source).to_string();
            if text.is_empty() {
                None
            } else {
                Some(text)
            }
        }
    }
}

fn find_type_like_child(node: Node<'_>) -> Option<Node<'_>> {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if matches!(
            child.kind(),
            "identifier" | "qualified_name" | "generic_name" | "alias_qualified_name"
        ) {
            return Some(child);
        }
    }
    None
}

fn find_first_descendant<'a>(node: Node<'a>, kind: &str) -> Option<Node<'a>> {
    let mut stack = vec![node];

    while let Some(current) = stack.pop() {
        if current.kind() == kind {
            return Some(current);
        }

        let child_count = current.child_count();
        for i in (0..child_count).rev() {
            if let Some(child) = current.child(i) {
                stack.push(child);
            }
        }
    }

    None
}
