use tree_sitter::Node;

use crate::types::NativeParsedImport;

use super::common::{
    extract_range, extract_string_value, find_child_by_kind, find_child_node, node_text,
};

pub fn extract_imports_cpp(root: Node<'_>, source: &[u8]) -> Vec<NativeParsedImport> {
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
    let path_node = node
        .child_by_field_name("path")
        .or_else(|| find_child_node(node, "string_literal"))
        .or_else(|| find_child_node(node, "system_lib_string"));
    let Some(path_node) = path_node else {
        return None;
    };

    if path_node.kind() == "string_literal" {
        let specifier = extract_string_value(path_node, source)
            .or_else(|| find_child_by_kind(node, "string_literal", source))
            .unwrap_or_default();
        if specifier.is_empty() {
            return None;
        }

        return Some(NativeParsedImport {
            is_relative: specifier.starts_with('.'),
            is_external: false,
            named_imports: vec![specifier.clone()],
            default_import: None,
            namespace_import: None,
            is_re_export: false,
            specifier,
            range: extract_range(node),
        });
    }

    if path_node.kind() == "system_lib_string" {
        let specifier = node_text(path_node, source)
            .trim()
            .trim_start_matches('<')
            .trim_end_matches('>')
            .to_string();
        if specifier.is_empty() {
            return None;
        }

        return Some(NativeParsedImport {
            is_relative: false,
            is_external: true,
            named_imports: vec![specifier.clone()],
            default_import: None,
            namespace_import: None,
            is_re_export: false,
            specifier,
            range: extract_range(node),
        });
    }

    None
}
