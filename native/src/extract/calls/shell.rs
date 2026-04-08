use std::collections::HashSet;

use tree_sitter::Node;

use crate::types::{NativeParsedCall, NativeParsedSymbol};

use super::common::{extract_range, find_enclosing_symbol, node_text};

pub fn extract_calls_shell(
    root: Node<'_>,
    source: &[u8],
    symbols: &[NativeParsedSymbol],
) -> Vec<NativeParsedCall> {
    let mut calls = Vec::new();
    let mut seen_nodes: HashSet<usize> = HashSet::new();
    let mut stack = vec![root];

    while let Some(node) = stack.pop() {
        if node.kind() == "command" && seen_nodes.insert(node.id()) {
            if let Some(call) = process_command(node, source, symbols) {
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

fn process_command(
    node: Node<'_>,
    source: &[u8],
    symbols: &[NativeParsedSymbol],
) -> Option<NativeParsedCall> {
    let command_name_node = node.child_by_field_name("name")?;
    if command_name_node.kind() != "command_name" {
        return None;
    }

    let callee_identifier = node_text(command_name_node, source).to_string();
    if callee_identifier.is_empty() {
        return None;
    }

    if callee_identifier == "source" || callee_identifier == "." {
        return None;
    }

    // TS shell.ts treats 'alias' commands as variable assignments, not
    // calls. Filter them out here.
    if callee_identifier == "alias" {
        return None;
    }

    // TS shell.ts sets callType to "function" if the callee matches a
    // declared function symbol, otherwise "dynamic" (external command).
    let call_type = if symbols
        .iter()
        .any(|s| s.kind == "function" && s.name == callee_identifier)
    {
        "function".to_string()
    } else {
        "dynamic".to_string()
    };

    Some(NativeParsedCall {
        caller_node_id: find_enclosing_symbol(node, symbols),
        callee_identifier,
        call_type,
        range: extract_range(node),
    })
}
