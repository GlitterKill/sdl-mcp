use std::collections::HashSet;

use tree_sitter::Node;

use crate::types::{NativeParsedCall, NativeParsedSymbol};

use super::common::{extract_range, find_enclosing_symbol, node_text};

pub fn extract_calls_c(
    root: Node<'_>,
    source: &[u8],
    symbols: &[NativeParsedSymbol],
) -> Vec<NativeParsedCall> {
    let mut calls = Vec::new();
    let mut seen_nodes: HashSet<usize> = HashSet::new();
    let mut stack = vec![root];

    while let Some(node) = stack.pop() {
        if node.kind() == "call_expression" && seen_nodes.insert(node.id()) {
            if let Some(call) = process_call_expression(node, source, symbols) {
                calls.push(call);
            }
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

fn process_call_expression(
    node: Node<'_>,
    source: &[u8],
    symbols: &[NativeParsedSymbol],
) -> Option<NativeParsedCall> {
    let function = node.child_by_field_name("function")?;

    let (callee_identifier, call_type) = match function.kind() {
        "identifier" => (
            node_text(function, source).to_string(),
            "direct".to_string(),
        ),
        "field_expression" => {
            let argument = function.child_by_field_name("argument")?;
            let field = function.child_by_field_name("field")?;
            let argument_text = node_text(argument, source);
            let field_text = node_text(field, source);
            if argument_text.is_empty() || field_text.is_empty() {
                return None;
            }
            (
                format!("{argument_text}.{field_text}"),
                "method".to_string(),
            )
        }
        "parenthesized_expression" => {
            let text = node_text(function, source).to_string();
            if text.is_empty() {
                return None;
            }
            (text, "dynamic".to_string())
        }
        _ => {
            let text = node_text(function, source).to_string();
            if text.is_empty() {
                return None;
            }
            (text, "dynamic".to_string())
        }
    };

    if callee_identifier.is_empty() {
        return None;
    }

    Some(NativeParsedCall {
        caller_name: find_enclosing_symbol(node, symbols),
        callee_identifier,
        call_type,
        range: extract_range(node),
    })
}
