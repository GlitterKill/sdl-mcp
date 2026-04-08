use tree_sitter::Node;

use crate::types::NativeParsedImport;

use super::common::{extract_range, extract_string_value, node_text};

pub fn extract_imports_shell(root: Node<'_>, source: &[u8]) -> Vec<NativeParsedImport> {
    let mut imports = Vec::new();
    let mut stack = vec![root];

    while let Some(node) = stack.pop() {
        if node.kind() == "command" {
            if let Some(parsed) = process_source_command(node, source) {
                imports.push(parsed);
            }
        }

        let child_count = node.child_count();
        for i in (0..child_count).rev() {
            if let Some(child) = node.child(i) {
                stack.push(child);
            }
        }
    }

    imports
}

fn process_source_command(node: Node<'_>, source: &[u8]) -> Option<NativeParsedImport> {
    let name_node = node.child_by_field_name("name")?;
    if name_node.kind() != "command_name" {
        return None;
    }

    let command_name = node_text(name_node, source);
    if command_name != "source" && command_name != "." {
        return None;
    }

    let arg_node = find_first_argument(node)?;
    let mut specifier = extract_string_value(arg_node, source)
        .unwrap_or_else(|| node_text(arg_node, source).trim().to_string());

    if specifier.starts_with('"') || specifier.starts_with('\'') {
        specifier = specifier[1..].to_string();
    }
    if specifier.ends_with('"') || specifier.ends_with('\'') {
        specifier.truncate(specifier.len().saturating_sub(1));
    }

    if specifier.is_empty() {
        return None;
    }

    let is_external = specifier.starts_with('/');
    let is_relative = specifier.starts_with('.') || !specifier.starts_with('/');

    Some(NativeParsedImport {
        specifier,
        is_relative,
        is_external,
        named_imports: Vec::new(),
        default_import: None,
        namespace_import: None,
        is_re_export: false,
        range: extract_range(node),
    })
}

fn find_first_argument(node: Node<'_>) -> Option<Node<'_>> {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() == "command_name" {
            continue;
        }
        if matches!(
            child.kind(),
            "word"
                | "string"
                | "raw_string"
                | "concatenation"
                | "simple_expansion"
                | "command_substitution"
        ) {
            return Some(child);
        }
    }

    None
}
