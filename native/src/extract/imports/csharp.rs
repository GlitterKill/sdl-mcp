use tree_sitter::Node;

use crate::types::NativeParsedImport;

use super::common::{extract_range, find_child_node, node_text};

pub fn extract_imports_csharp(root: Node<'_>, source: &[u8]) -> Vec<NativeParsedImport> {
    let mut imports = Vec::new();
    let mut stack = vec![root];

    while let Some(node) = stack.pop() {
        match node.kind() {
            "using_directive" => {
                if let Some(parsed) = process_using_directive(node, source) {
                    imports.push(parsed);
                }
            }
            "global_using_directive" => {
                if let Some(parsed) = process_using_directive(node, source) {
                    imports.push(parsed);
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

    imports
}

fn process_using_directive(node: Node<'_>, source: &[u8]) -> Option<NativeParsedImport> {
    let mut is_static = false;
    let mut alias: Option<String> = None;
    let mut namespace = String::new();
    let mut alias_identifier = String::new();

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        match child.kind() {
            "static_modifier" => {
                is_static = true;
            }
            "identifier" => {
                let text = node_text(child, source).to_string();
                if alias_identifier.is_empty() {
                    alias_identifier = text;
                } else {
                    namespace = text;
                }
            }
            "type" | "qualified_name" => {
                if let Some(name) = extract_qualified_name(child, source) {
                    namespace = name;
                }
            }
            "name_equals" => {
                if let Some(identifier) = find_child_node(child, "identifier") {
                    let text = node_text(identifier, source).to_string();
                    if !text.is_empty() {
                        alias = Some(text);
                    }
                }
            }
            _ => {}
        }
    }

    if namespace.is_empty() && !alias_identifier.is_empty() {
        namespace = alias_identifier;
    }

    if namespace.is_empty() {
        return None;
    }

    Some(NativeParsedImport {
        specifier: namespace.clone(),
        is_relative: false,
        is_external: !namespace.starts_with("System") && !namespace.starts_with("global::"),
        named_imports: if is_static {
            vec!["*".to_string()]
        } else {
            Vec::new()
        },
        default_import: alias,
        namespace_import: None,
        is_re_export: false,
        range: extract_range(node),
    })
}

fn extract_qualified_name(node: Node<'_>, source: &[u8]) -> Option<String> {
    match node.kind() {
        "identifier" => {
            let text = node_text(node, source).to_string();
            if text.is_empty() {
                None
            } else {
                Some(text)
            }
        }
        "qualified_name" => {
            let mut parts = Vec::new();
            let mut stack = vec![node];
            while let Some(current) = stack.pop() {
                if current.kind() == "identifier" {
                    let text = node_text(current, source).to_string();
                    if !text.is_empty() {
                        parts.push(text);
                    }
                }

                let child_count = current.child_count();
                for i in (0..child_count).rev() {
                    if let Some(child) = current.child(i) {
                        if child.kind() == "identifier" || child.kind() == "qualified_name" {
                            stack.push(child);
                        }
                    }
                }
            }

            if parts.is_empty() {
                None
            } else {
                Some(parts.join("."))
            }
        }
        _ => None,
    }
}
