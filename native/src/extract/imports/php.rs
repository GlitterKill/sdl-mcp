use tree_sitter::Node;

use crate::types::NativeParsedImport;

use super::common::{extract_range, extract_string_value, find_child_by_kind, find_child_node};

pub fn extract_imports_php(root: Node<'_>, source: &[u8]) -> Vec<NativeParsedImport> {
    let mut imports = Vec::new();
    let mut stack = vec![root];

    while let Some(node) = stack.pop() {
        match node.kind() {
            "namespace_use_declaration" => {
                process_namespace_use_declaration(node, source, &mut imports);
            }
            "include_expression"
            | "include_once_expression"
            | "require_expression"
            | "require_once_expression" => {
                if let Some(parsed) = process_include_like_expression(node, source) {
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

fn process_namespace_use_declaration(
    node: Node<'_>,
    source: &[u8],
    imports: &mut Vec<NativeParsedImport>,
) {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() != "namespace_use_clause" {
            continue;
        }

        if let Some(parsed) = parse_namespace_use_clause(child, source) {
            imports.push(parsed);
        }
    }
}

fn parse_namespace_use_clause(node: Node<'_>, source: &[u8]) -> Option<NativeParsedImport> {
    let specifier = find_child_by_kind(node, "qualified_name", source)
        .or_else(|| find_child_by_kind(node, "name", source))?;
    if specifier.is_empty() {
        return None;
    }

    let is_relative = specifier.starts_with('\\');

    let alias = extract_use_alias(node, source);
    let named_import =
        alias.unwrap_or_else(|| specifier.split('\\').next_back().unwrap_or("").to_string());

    Some(NativeParsedImport {
        specifier,
        is_relative,
        is_external: true,
        named_imports: if named_import.is_empty() {
            Vec::new()
        } else {
            vec![named_import]
        },
        default_import: None,
        namespace_import: None,
        is_re_export: false,
        range: extract_range(node),
    })
}

fn extract_use_alias(node: Node<'_>, source: &[u8]) -> Option<String> {
    let has_as = has_as_keyword(node);
    if has_as {
        let mut cursor = node.walk();
        let mut found_as = false;
        for child in node.children(&mut cursor) {
            if child.kind() == "as" {
                found_as = true;
                continue;
            }

            if found_as && child.kind() == "name" {
                let alias = child.utf8_text(source).unwrap_or("").to_string();
                if !alias.is_empty() {
                    return Some(alias);
                }
            }
        }
    }

    if let Some(alias_clause) = find_child_node(node, "namespace_aliasing_clause") {
        return find_child_by_kind(alias_clause, "name", source);
    }

    None
}

fn has_as_keyword(node: Node<'_>) -> bool {
    let mut cursor = node.walk();
    let found = node.children(&mut cursor).any(|child| child.kind() == "as");
    found
}

fn process_include_like_expression(node: Node<'_>, source: &[u8]) -> Option<NativeParsedImport> {
    let string_node = find_child_node(node, "string")?;
    let specifier = extract_string_value(string_node, source)?;
    if specifier.is_empty() {
        return None;
    }

    let is_relative = specifier.starts_with("./") || specifier.starts_with("../");

    Some(NativeParsedImport {
        specifier,
        is_relative,
        is_external: !is_relative,
        named_imports: Vec::new(),
        default_import: None,
        namespace_import: None,
        is_re_export: false,
        range: extract_range(node),
    })
}
