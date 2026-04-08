use std::collections::HashSet;

use tree_sitter::Node;

use crate::types::{NativeParsedCall, NativeParsedSymbol};

use super::common::{extract_range, find_enclosing_symbol, node_text};

pub fn extract_calls_cpp(
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
                    if let Some(call) = process_call_expression(node, source, symbols) {
                        calls.push(call);
                    }
                }
            }
            "new_expression" => {
                if seen_nodes.insert(node.id()) {
                    if let Some(call) = process_new_expression(node, source, symbols) {
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

fn process_call_expression(
    node: Node<'_>,
    source: &[u8],
    symbols: &[NativeParsedSymbol],
) -> Option<NativeParsedCall> {
    let function = node.child_by_field_name("function")?;

    let (callee_identifier, call_type) = match function.kind() {
        "identifier" => {
            let name = node_text(function, source).to_string();
            if name.is_empty() {
                return None;
            }
            (name, "function".to_string())
        }
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
        "template_function" => {
            let name_node = function
                .child_by_field_name("name")
                .or_else(|| function.child(0));
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
            let text = node_text(function, source).to_string();
            if text.is_empty() {
                return None;
            }
            (text, "dynamic".to_string())
        }
    };

    Some(NativeParsedCall {
        caller_node_id: find_enclosing_symbol(node, symbols),
        callee_identifier,
        call_type,
        range: extract_range(node),
    })
}

fn process_new_expression(
    node: Node<'_>,
    source: &[u8],
    symbols: &[NativeParsedSymbol],
) -> Option<NativeParsedCall> {
    let type_node = node
        .child_by_field_name("type")
        .or_else(|| node.child_by_field_name("constructor"));
    let Some(type_node) = type_node else {
        return None;
    };

    let type_text = node_text(type_node, source).to_string();
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
