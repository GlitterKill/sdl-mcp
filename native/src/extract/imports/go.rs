use tree_sitter::Node;

use crate::types::NativeParsedImport;

use super::common::{extract_range, extract_string_value, node_text};

pub fn extract_imports_go(root: Node<'_>, source: &[u8]) -> Vec<NativeParsedImport> {
    let mut imports = Vec::new();
    let mut stack = vec![root];

    while let Some(node) = stack.pop() {
        if node.kind() == "import_declaration" {
            process_import_declaration(node, source, &mut imports);
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

fn process_import_declaration(
    node: Node<'_>,
    source: &[u8],
    imports: &mut Vec<NativeParsedImport>,
) {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() == "import_spec" {
            if let Some(parsed) = process_import_spec(child, source) {
                imports.push(parsed);
            }
        } else if child.kind() == "import_spec_list" {
            let mut list_cursor = child.walk();
            for import_spec in child.children(&mut list_cursor) {
                if import_spec.kind() == "import_spec" {
                    if let Some(parsed) = process_import_spec(import_spec, source) {
                        imports.push(parsed);
                    }
                }
            }
        }
    }
}

fn process_import_spec(node: Node<'_>, source: &[u8]) -> Option<NativeParsedImport> {
    let path_node = node.child_by_field_name("path")?;
    let specifier = extract_string_value(path_node, source)
        .unwrap_or_else(|| node_text(path_node, source).trim_matches('"').to_string());

    if specifier.is_empty() {
        return None;
    }

    let alias = node
        .child_by_field_name("name")
        .map(|name_node| node_text(name_node, source).to_string())
        .filter(|name| !name.is_empty());

    let named_imports = alias.clone().into_iter().collect::<Vec<String>>();

    let namespace_import = match alias {
        Some(alias_name) if alias_name != "_" => Some(alias_name),
        Some(_) => None,
        None => specifier
            .split('/')
            .next_back()
            .map(|name| name.to_string()),
    };

    let is_relative = specifier.starts_with("./") || specifier.starts_with("../");

    Some(NativeParsedImport {
        specifier,
        is_relative,
        is_external: !is_relative,
        named_imports,
        default_import: None,
        namespace_import,
        range: extract_range(node),
    })
}
