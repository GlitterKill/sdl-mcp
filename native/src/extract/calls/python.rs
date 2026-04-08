use std::collections::HashSet;

use tree_sitter::Node;

use crate::types::{NativeParsedCall, NativeParsedSymbol};

use super::common::{extract_range, find_enclosing_symbol, node_text};

pub fn extract_calls_python(
    root: Node<'_>,
    source: &[u8],
    symbols: &[NativeParsedSymbol],
) -> Vec<NativeParsedCall> {
    let mut calls = Vec::new();
    let mut seen_call_nodes: HashSet<usize> = HashSet::new();

    walk_for_calls(root, source, symbols, &mut calls, &mut seen_call_nodes);
    extract_decorator_calls(root, source, &mut calls, &mut seen_call_nodes);

    calls
}

fn walk_for_calls(
    root: Node<'_>,
    source: &[u8],
    symbols: &[NativeParsedSymbol],
    calls: &mut Vec<NativeParsedCall>,
    seen_call_nodes: &mut HashSet<usize>,
) {
    let mut stack = vec![root];

    while let Some(node) = stack.pop() {
        if node.kind() == "call"
            && !seen_call_nodes.contains(&node.id())
            && !has_ancestor_of_type(node, "decorator")
        {
            seen_call_nodes.insert(node.id());
            let caller_node_id = find_enclosing_symbol(node, symbols);
            if let Some(call) = parse_call_node(node, source, &caller_node_id) {
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
}

fn extract_decorator_calls(
    root: Node<'_>,
    source: &[u8],
    calls: &mut Vec<NativeParsedCall>,
    seen_call_nodes: &mut HashSet<usize>,
) {
    let mut stack = vec![root];

    while let Some(node) = stack.pop() {
        if node.kind() == "call"
            && has_ancestor_of_type(node, "decorator")
            && !seen_call_nodes.contains(&node.id())
        {
            seen_call_nodes.insert(node.id());
            if let Some(call) = parse_call_node(node, source, "decorator") {
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
}

fn parse_call_node(
    call_node: Node<'_>,
    source: &[u8],
    caller_node_id: &str,
) -> Option<NativeParsedCall> {
    let function_node = call_node.child_by_field_name("function")?;

    let (callee_identifier, call_type) = match function_node.kind() {
        "identifier" => (
            node_text(function_node, source).to_string(),
            "function".to_string(),
        ),
        "attribute" => {
            let object = function_node.child_by_field_name("object")?;
            let attribute = function_node.child_by_field_name("attribute")?;
            (
                format!(
                    "{}.{}",
                    node_text(object, source),
                    node_text(attribute, source)
                ),
                "method".to_string(),
            )
        }
        _ => {
            let text = node_text(function_node, source).to_string();
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
        caller_node_id: caller_node_id.to_string(),
        callee_identifier,
        call_type,
        range: extract_range(call_node),
    })
}

fn has_ancestor_of_type(node: Node<'_>, kind: &str) -> bool {
    let mut current = node.parent();
    while let Some(parent) = current {
        if parent.kind() == kind {
            return true;
        }
        current = parent.parent();
    }
    false
}
