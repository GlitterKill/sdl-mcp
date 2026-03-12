use tree_sitter::Node;

use crate::types::NativeParsedImport;

use super::common::{extract_range, node_text};

pub fn extract_imports_rust(root: Node<'_>, source: &[u8]) -> Vec<NativeParsedImport> {
    let mut imports = Vec::new();
    let mut stack = vec![root];

    while let Some(node) = stack.pop() {
        match node.kind() {
            "mod_item" => {
                if let Some(parsed) = process_mod_item(node, source) {
                    imports.push(parsed);
                }
            }
            "use_declaration" => {
                if let Some(parsed) = process_use_declaration(node, source) {
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

fn process_mod_item(node: Node<'_>, source: &[u8]) -> Option<NativeParsedImport> {
    let name_node = node.child_by_field_name("name")?;
    let module_name = node_text(name_node, source).to_string();
    if module_name.is_empty() {
        return None;
    }

    Some(NativeParsedImport {
        specifier: module_name.clone(),
        is_relative: true,
        is_external: false,
        named_imports: vec![module_name],
        default_import: None,
        namespace_import: None,
        range: extract_range(node),
    })
}

fn process_use_declaration(node: Node<'_>, source: &[u8]) -> Option<NativeParsedImport> {
    let argument = node.child_by_field_name("argument")?;

    let (specifier, named_imports): (String, Vec<String>) = match argument.kind() {
        "use_wildcard" => parse_use_wildcard(argument, source)?,
        "use_as_clause" => parse_use_as_clause(argument, source)?,
        "scoped_use_list" => parse_scoped_use_list(argument, source)?,
        "scoped_identifier" | "identifier" => {
            let specifier = node_text(argument, source).to_string();
            if specifier.is_empty() {
                return None;
            }

            let imported_name = specifier.rsplit("::").next().unwrap_or("").to_string();
            if imported_name.is_empty() {
                return None;
            }

            (specifier, vec![imported_name])
        }
        _ => return None,
    };

    if specifier.is_empty() || named_imports.is_empty() {
        return None;
    }

    let is_relative = is_relative_specifier(&specifier);
    let is_external = is_external_specifier(&specifier, is_relative);

    Some(NativeParsedImport {
        specifier,
        is_relative,
        is_external,
        named_imports,
        default_import: None,
        namespace_import: None,
        range: extract_range(node),
    })
}

fn parse_use_wildcard(node: Node<'_>, source: &[u8]) -> Option<(String, Vec<String>)> {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() == "scoped_identifier" || child.kind() == "identifier" {
            let specifier = node_text(child, source).to_string();
            if !specifier.is_empty() {
                return Some((specifier, vec!["*".to_string()]));
            }
        }
    }
    None
}

fn parse_use_as_clause(node: Node<'_>, source: &[u8]) -> Option<(String, Vec<String>)> {
    let alias_node = node.child_by_field_name("alias")?;
    let alias = node_text(alias_node, source).to_string();
    if alias.is_empty() {
        return None;
    }

    let path_node = node
        .child_by_field_name("path")
        .or_else(|| node.child_by_field_name("name"))?;
    let specifier = node_text(path_node, source).to_string();
    if specifier.is_empty() {
        return None;
    }

    Some((specifier, vec![alias]))
}

fn parse_scoped_use_list(node: Node<'_>, source: &[u8]) -> Option<(String, Vec<String>)> {
    let path_node = node.child_by_field_name("path")?;
    let specifier = node_text(path_node, source).to_string();
    if specifier.is_empty() {
        return None;
    }

    let list_node = node.child_by_field_name("list");
    let mut named_imports = Vec::new();

    if let Some(list_node) = list_node {
        let mut cursor = list_node.walk();
        for child in list_node.children(&mut cursor) {
            match child.kind() {
                "use_as_clause" => {
                    if let Some(alias_node) = child.child_by_field_name("alias") {
                        let alias = node_text(alias_node, source).to_string();
                        if !alias.is_empty() {
                            named_imports.push(alias);
                        }
                    } else if let Some(name_node) = child.child_by_field_name("name") {
                        let name = node_text(name_node, source).to_string();
                        if !name.is_empty() {
                            named_imports.push(name);
                        }
                    }
                }
                "use_wildcard" => named_imports.push("*".to_string()),
                "scoped_identifier" => {
                    let value = node_text(child, source);
                    let imported = value.rsplit("::").next().unwrap_or("").to_string();
                    if !imported.is_empty() {
                        named_imports.push(imported);
                    }
                }
                "identifier" => {
                    let imported = node_text(child, source).to_string();
                    if !imported.is_empty() && imported != "self" {
                        named_imports.push(imported);
                    }
                }
                "self" => {}
                _ => {}
            }
        }
    } else {
        let imported = specifier.rsplit("::").next().unwrap_or("").to_string();
        if !imported.is_empty() {
            named_imports.push(imported);
        }
    }

    if named_imports.is_empty() {
        return None;
    }

    Some((specifier, named_imports))
}

fn is_relative_specifier(specifier: &str) -> bool {
    specifier.starts_with("self::")
        || specifier.starts_with("super::")
        || specifier.starts_with("crate::")
}

fn is_external_specifier(specifier: &str, is_relative: bool) -> bool {
    if is_relative {
        return false;
    }

    if specifier.contains("::") {
        return true;
    }

    let mut chars = specifier.chars();
    match chars.next() {
        Some(first) if first.is_ascii_lowercase() => {
            chars.all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_')
        }
        _ => false,
    }
}
