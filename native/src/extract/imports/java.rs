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

    let mut named_imports = if is_wildcard {
        vec!["*".to_string()]
    } else {
        vec![specifier.split('.').next_back().unwrap_or("").to_string()]
    };

    let mut namespace_import = None;
    if is_static {
        let parts: Vec<&str> = specifier.split('.').collect();
        if parts.len() > 1 {
            namespace_import = Some(parts[parts.len() - 2].to_string());
        }

        let member = parts.last().copied().unwrap_or("");
        named_imports = vec![if member == "*" {
            "*".to_string()
        } else {
            member.to_string()
        }];
    }

    Some(NativeParsedImport {
        specifier,
        is_relative: false,
        is_external: true,
        named_imports,
        default_import: None,
        namespace_import,
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
