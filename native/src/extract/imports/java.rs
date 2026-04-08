use tree_sitter::Node;

use crate::types::NativeParsedImport;

use super::common::{extract_range, find_child_node, node_text};

pub fn extract_imports_java(root: Node<'_>, source: &[u8]) -> Vec<NativeParsedImport> {
    let mut imports = Vec::new();
    let mut stack = vec![root];

    while let Some(node) = stack.pop() {
        if node.kind() == "import_declaration" {
            if let Some(parsed) = process_import_declaration(node, source) {
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

fn process_import_declaration(node: Node<'_>, source: &[u8]) -> Option<NativeParsedImport> {
    let specifier_node = find_child_node(node, "scoped_identifier")
        .or_else(|| find_child_node(node, "identifier"))?;
    let specifier = node_text(specifier_node, source).to_string();
    if specifier.is_empty() {
        return None;
    }

    let is_wildcard = has_kind(node, "*");
    let is_static = has_kind(node, "static")
        || find_child_node(node, "modifiers").is_some_and(|m| has_kind(m, "static"));

    let named_imports = if is_wildcard {
        vec!["*".to_string()]
    } else {
        vec![specifier.split('.').next_back().unwrap_or("").to_string()]
    };

    // TS java.ts does NOT populate namespaceImport (it leaves it undefined).
    let _ = is_static;
    let namespace_import: Option<String> = None;

    Some(NativeParsedImport {
        specifier,
        is_relative: false,
        // TS java.ts emits is_external: false for all java imports.
        is_external: false,
        named_imports,
        default_import: None,
        namespace_import,
        is_re_export: false,
        range: extract_range(node),
    })
}

fn has_kind(parent: Node<'_>, kind: &str) -> bool {
    let mut cursor = parent.walk();
    let found = parent
        .children(&mut cursor)
        .any(|child| child.kind() == kind);
    found
}
