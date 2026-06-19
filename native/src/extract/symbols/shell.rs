use tree_sitter::Node;

use crate::types::NativeParsedSymbol;

use super::common::{make_symbol, node_text};

pub fn extract_symbols_shell(
    root: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
) -> Vec<NativeParsedSymbol> {
    let mut symbols = Vec::new();
    let mut stack = vec![root];

    while let Some(node) = stack.pop() {
        match node.kind() {
            "function_definition" => {
                if let Some(symbol) = process_function_definition(node, source, repo_id, rel_path) {
                    symbols.push(symbol);
                }
            }
            "variable_assignment" => {
                if let Some(symbol) = process_variable_assignment(node, source, repo_id, rel_path) {
                    symbols.push(symbol);
                }
            }
            "command" => {
                if let Some(symbol) = process_alias_command(node, source, repo_id, rel_path) {
                    symbols.push(symbol);
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

    symbols
}

fn process_function_definition(
    node: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
) -> Option<NativeParsedSymbol> {
    let name = extract_function_name(node, source)?;
    if name.is_empty() {
        return None;
    }

    // TS shell.ts always emits signature { params: [] } and visibility "public".
    let mut symbol = super::common::make_symbol_with_forced_signature(
        &name,
        "function",
        node,
        source,
        repo_id,
        rel_path,
        &[],
        None,
        &[],
        "public",
        &[],
    );
    symbol.exported = true;
    Some(symbol)
}

fn process_variable_assignment(
    node: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
) -> Option<NativeParsedSymbol> {
    let name_node = find_first_variable_name(node)?;
    let name = node_text(name_node, source).to_string();
    if name.is_empty() {
        return None;
    }

    let mut symbol = make_symbol(
        &name,
        "variable",
        node,
        source,
        repo_id,
        rel_path,
        &[],
        None,
        &[],
        "public",
        &[],
    );
    symbol.exported = has_export_keyword(node, source);
    Some(symbol)
}

fn process_alias_command(
    node: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
) -> Option<NativeParsedSymbol> {
    let command_name = node.child_by_field_name("name")?;
    if node_text(command_name, source) != "alias" {
        return None;
    }

    let mut saw_alias = false;
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if !saw_alias {
            saw_alias = child.id() == command_name.id();
            continue;
        }

        let text = node_text(child, source).trim();
        if text.is_empty() {
            continue;
        }

        let alias_name = if let Some((name, _)) = text.split_once('=') {
            name.trim()
        } else if child.kind() == "word" {
            text
        } else {
            continue;
        };

        if alias_name.is_empty() {
            continue;
        }

        let mut symbol = make_symbol(
            alias_name,
            "variable",
            node,
            source,
            repo_id,
            rel_path,
            &[],
            None,
            &[],
            "public",
            &[],
        );
        symbol.exported = true;
        return Some(symbol);
    }

    None
}

fn extract_function_name(node: Node<'_>, source: &[u8]) -> Option<String> {
    if let Some(name_node) = node.child_by_field_name("name") {
        let name = node_text(name_node, source).to_string();
        if !name.is_empty() {
            return Some(name);
        }
    }

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() == "word" {
            let name = node_text(child, source).to_string();
            if !name.is_empty() {
                return Some(name);
            }
        }
    }

    None
}

fn find_first_variable_name(node: Node<'_>) -> Option<Node<'_>> {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() == "variable_name" {
            return Some(child);
        }
    }
    None
}

fn has_export_keyword(node: Node<'_>, source: &[u8]) -> bool {
    let mut current = node.parent();
    while let Some(parent) = current {
        if parent.kind() == "statement"
            || parent.kind() == "declaration_command"
            || parent.kind() == "command"
        {
            let mut cursor = parent.walk();
            if parent
                .children(&mut cursor)
                .any(|child| child.kind() == "export" || node_text(child, source) == "export")
            {
                return true;
            }
        }

        if parent.kind() == "function_definition" || parent.kind() == "program" {
            break;
        }
        current = parent.parent();
    }

    false
}
