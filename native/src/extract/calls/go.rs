use std::collections::HashSet;

use tree_sitter::Node;

use crate::types::{NativeParsedCall, NativeParsedSymbol};

use super::common::{extract_range, find_enclosing_symbol, node_text};

pub fn extract_calls_go(
    root: Node<'_>,
    source: &[u8],
    symbols: &[NativeParsedSymbol],
) -> Vec<NativeParsedCall> {
    let mut calls = Vec::new();
    let mut seen_call_nodes: HashSet<usize> = HashSet::new();
    let mut stack = vec![root];

    while let Some(node) = stack.pop() {
        match node.kind() {
            "call_expression" => {
                push_call_if_new(node, source, symbols, &mut calls, &mut seen_call_nodes);
            }
            "go_statement" | "defer_statement" => {
                if let Some(call_node) = find_call_expression_child(node) {
                    push_call_if_new(call_node, source, symbols, &mut calls, &mut seen_call_nodes);
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

fn push_call_if_new(
    call_node: Node<'_>,
    source: &[u8],
    symbols: &[NativeParsedSymbol],
    calls: &mut Vec<NativeParsedCall>,
    seen_call_nodes: &mut HashSet<usize>,
) {
    if seen_call_nodes.contains(&call_node.id()) {
        return;
    }
    seen_call_nodes.insert(call_node.id());

    if let Some(call) = parse_call_node(call_node, source, symbols) {
        calls.push(call);
    }
}

fn parse_call_node(
    call_node: Node<'_>,
    source: &[u8],
    symbols: &[NativeParsedSymbol],
) -> Option<NativeParsedCall> {
    let function_node = call_node.child_by_field_name("function")?;

    let (callee_identifier, call_type) = match function_node.kind() {
        "identifier" => (
            node_text(function_node, source).to_string(),
            "direct".to_string(),
        ),
        "selector_expression" => {
            let operand = function_node.child_by_field_name("operand")?;
            let field = function_node.child_by_field_name("field")?;
            let operand_text = node_text(operand, source);
            let field_text = node_text(field, source);

            if operand_text.is_empty() || field_text.is_empty() {
                return None;
            }

            (format!("{operand_text}.{field_text}"), "method".to_string())
        }
        _ => return None,
    };

    if callee_identifier.is_empty() {
        return None;
    }

    Some(NativeParsedCall {
        caller_name: find_enclosing_symbol(call_node, symbols),
        callee_identifier,
        call_type,
        range: extract_range(call_node),
    })
}

fn find_call_expression_child(node: Node<'_>) -> Option<Node<'_>> {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() == "call_expression" {
            return Some(child);
        }
    }
    None
}
