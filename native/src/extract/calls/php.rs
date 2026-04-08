use std::collections::HashSet;

use tree_sitter::Node;

use crate::types::{NativeParsedCall, NativeParsedSymbol};

use super::common::{extract_range, find_enclosing_symbol, node_text};

pub fn extract_calls_php(
    root: Node<'_>,
    source: &[u8],
    symbols: &[NativeParsedSymbol],
) -> Vec<NativeParsedCall> {
    let mut calls = Vec::new();
    let mut seen_nodes: HashSet<usize> = HashSet::new();
    let mut stack = vec![root];

    while let Some(node) = stack.pop() {
        match node.kind() {
            "function_call_expression" | "member_call_expression" | "scoped_call_expression" => {
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

fn parse_call_expression(
    node: Node<'_>,
    source: &[u8],
    symbols: &[NativeParsedSymbol],
) -> Option<NativeParsedCall> {
    let (callee_identifier, call_type) = match node.kind() {
        "function_call_expression" => parse_function_call(node, source)?,
        "member_call_expression" => parse_member_call(node, source)?,
        "scoped_call_expression" => parse_scoped_call(node, source)?,
        _ => return None,
    };

    if callee_identifier.is_empty() {
        return None;
    }

    Some(NativeParsedCall {
        caller_node_id: find_enclosing_symbol(node, symbols),
        callee_identifier,
        call_type,
        range: extract_range(node),
    })
}

fn parse_function_call(node: Node<'_>, source: &[u8]) -> Option<(String, String)> {
    let function_node = node
        .child_by_field_name("function")
        .or_else(|| node.child_by_field_name("name"))
        .or_else(|| first_child_of_kind(node, &["name", "variable_name", "qualified_name"]));
    let function_node = function_node?;

    match function_node.kind() {
        "name" => {
            let callee = node_text(function_node, source).to_string();
            if callee.is_empty() {
                return None;
            }
            Some((callee, "function".to_string()))
        }
        "variable_name" => {
            let callee = node_text(function_node, source).to_string();
            if callee.is_empty() {
                return None;
            }
            Some((callee, "dynamic".to_string()))
        }
        _ => {
            let callee = node_text(function_node, source).to_string();
            if callee.is_empty() {
                return None;
            }
            Some((callee, "dynamic".to_string()))
        }
    }
}

fn parse_member_call(node: Node<'_>, source: &[u8]) -> Option<(String, String)> {
    let receiver_node = node
        .child_by_field_name("object")
        .or_else(|| first_child_of_kind(node, &["variable_name", "name", "qualified_name"]));

    let member_node = node
        .child_by_field_name("name")
        .or_else(|| node.child_by_field_name("member"))
        .or_else(|| first_last_call_target(node));

    let (receiver_node, member_node) = (receiver_node?, member_node?);
    let receiver_text = node_text(receiver_node, source).to_string();
    let member_text = node_text(member_node, source).to_string();
    if receiver_text.is_empty() || member_text.is_empty() {
        return None;
    }

    let call_type = if member_node.kind() == "variable_name" {
        "dynamic"
    } else {
        "method"
    };

    Some((
        format!("{receiver_text}.{member_text}"),
        call_type.to_string(),
    ))
}

fn parse_scoped_call(node: Node<'_>, source: &[u8]) -> Option<(String, String)> {
    let scope_node = node
        .child_by_field_name("scope")
        .or_else(|| first_child_of_kind(node, &["qualified_name", "name"]));
    let static_name_node = node
        .child_by_field_name("name")
        .or_else(|| second_name_like_child(node));

    let (scope_node, static_name_node) = (scope_node?, static_name_node?);

    let scope_text = node_text(scope_node, source).to_string();
    let static_name_text = node_text(static_name_node, source).to_string();
    if scope_text.is_empty() || static_name_text.is_empty() {
        return None;
    }

    Some((
        format!("{scope_text}::{static_name_text}"),
        "function".to_string(),
    ))
}

fn first_child_of_kind<'a>(node: Node<'a>, kinds: &[&str]) -> Option<Node<'a>> {
    let mut cursor = node.walk();
    let found = node
        .children(&mut cursor)
        .find(|child| kinds.iter().any(|kind| child.kind() == *kind));
    found
}

fn first_last_call_target<'a>(node: Node<'a>) -> Option<Node<'a>> {
    let mut cursor = node.walk();
    let mut seen_arrow = false;

    for child in node.children(&mut cursor) {
        if child.kind() == "->" {
            seen_arrow = true;
            continue;
        }

        if !seen_arrow {
            continue;
        }

        if child.kind() == "name" || child.kind() == "variable_name" {
            return Some(child);
        }
    }

    None
}

fn second_name_like_child<'a>(node: Node<'a>) -> Option<Node<'a>> {
    let mut cursor = node.walk();
    let mut seen_first = false;

    for child in node.children(&mut cursor) {
        if child.kind() != "name" {
            continue;
        }

        if !seen_first {
            seen_first = true;
            continue;
        }

        return Some(child);
    }

    None
}
