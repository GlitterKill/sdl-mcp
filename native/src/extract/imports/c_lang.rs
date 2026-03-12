use tree_sitter::Node;

use crate::types::NativeParsedImport;

use super::common::{extract_range, extract_string_value, node_text};

pub fn extract_imports_c(root: Node<'_>, source: &[u8]) -> Vec<NativeParsedImport> {
    let mut imports = Vec::new();
    let mut stack = vec![root];

    while let Some(node) = stack.pop() {
        if node.kind() == "preproc_include" {
            if let Some(parsed) = process_preproc_include(node, source) {
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

fn process_preproc_include(node: Node<'_>, source: &[u8]) -> Option<NativeParsedImport> {
    if let Some(path_node) = find_child_by_kind(node, "string_literal") {
        let specifier = extract_string_value(path_node, source)
            .unwrap_or_else(|| node_text(path_node, source).trim_matches('"').to_string());
        if specifier.is_empty() {
            return None;
        }

        return Some(NativeParsedImport {
            specifier,
            is_relative: true,
            is_external: false,
            named_imports: Vec::new(),
            default_import: None,
            namespace_import: None,
            range: extract_range(node),
        });
    }

    if let Some(path_node) = find_child_by_kind(node, "system_lib_string") {
        let specifier = node_text(path_node, source)
            .trim()
            .trim_start_matches('<')
            .trim_end_matches('>')
            .to_string();

        if specifier.is_empty() {
            return None;
        }

        return Some(NativeParsedImport {
            specifier,
            is_relative: false,
            is_external: true,
            named_imports: Vec::new(),
            default_import: None,
            namespace_import: None,
            range: extract_range(node),
        });
    }

    None
}

fn find_child_by_kind<'a>(parent: Node<'a>, kind: &str) -> Option<Node<'a>> {
    let mut cursor = parent.walk();
    for child in parent.children(&mut cursor) {
        if child.kind() == kind {
            return Some(child);
        }
    }
    None
}
