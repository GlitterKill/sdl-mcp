use tree_sitter::Node;

use crate::types::NativeParsedImport;

use super::common::{extract_range, find_child_node, node_text};

const PYTHON_STDLIB_MODULES: &[&str] = &[
    "os",
    "sys",
    "json",
    "re",
    "datetime",
    "math",
    "collections",
    "itertools",
    "functools",
    "pathlib",
    "typing",
    "types",
    "io",
    "string",
    "numbers",
    "random",
    "statistics",
    "decimal",
    "fractions",
    "heapq",
    "bisect",
    "array",
    "weakref",
];

pub fn extract_imports_python(root: Node<'_>, source: &[u8]) -> Vec<NativeParsedImport> {
    let mut imports = Vec::new();
    let mut stack = vec![root];

    while let Some(node) = stack.pop() {
        match node.kind() {
            "import_statement" => process_import_statement(node, source, &mut imports),
            "import_from_statement" => process_import_from_statement(node, source, &mut imports),
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

fn process_import_statement(node: Node<'_>, source: &[u8], imports: &mut Vec<NativeParsedImport>) {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        match child.kind() {
            "dotted_name" => {
                let specifier = node_text(child, source).to_string();
                let namespace_import = specifier
                    .split('.')
                    .next_back()
                    .map(|name| name.to_string());
                imports.push(build_import(
                    node,
                    &specifier,
                    is_relative_specifier(&specifier),
                    Vec::new(),
                    namespace_import,
                    false,
                ));
            }
            "aliased_import" => {
                let Some(name_node) = child.child_by_field_name("name") else {
                    continue;
                };
                let specifier = node_text(name_node, source).to_string();
                let alias = child
                    .child_by_field_name("alias")
                    .map(|alias_node| node_text(alias_node, source).to_string())
                    .or_else(|| {
                        specifier
                            .split('.')
                            .next_back()
                            .map(|name| name.to_string())
                    });

                imports.push(build_import(
                    node,
                    &specifier,
                    is_relative_specifier(&specifier),
                    Vec::new(),
                    alias,
                    false,
                ));
            }
            _ => {}
        }
    }
}

fn process_import_from_statement(
    node: Node<'_>,
    source: &[u8],
    imports: &mut Vec<NativeParsedImport>,
) {
    let specifier = extract_from_specifier(node, source);
    let is_relative = is_relative_specifier(&specifier) || has_relative_import_module(node);

    let mut named_imports = Vec::new();
    let mut has_wildcard_import = false;
    let mut found_import_keyword = false;
    // PEP 484 / typing: `from x import y as y` is an explicit re-export marker.
    let mut is_re_export = false;

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        match child.kind() {
            "wildcard_import" => {
                has_wildcard_import = true;
                break;
            }
            "import" => {
                found_import_keyword = true;
            }
            "dotted_name" if found_import_keyword => {
                named_imports.push(node_text(child, source).to_string());
            }
            "aliased_import" if found_import_keyword => {
                let original_name = child
                    .child_by_field_name("name")
                    .map(|n| node_text(n, source).to_string());
                let alias_name = child
                    .child_by_field_name("alias")
                    .map(|n| node_text(n, source).to_string());
                if let (Some(orig), Some(alias)) = (original_name.as_ref(), alias_name.as_ref()) {
                    if orig == alias {
                        is_re_export = true;
                    }
                }
                let name = alias_name.or(original_name);
                if let Some(name) = name {
                    named_imports.push(name);
                }
            }
            _ => {}
        }
    }

    if has_wildcard_import {
        named_imports.clear();
        named_imports.push("*".to_string());
    } else if named_imports.is_empty() {
        named_imports.push("*".to_string());
    }

    imports.push(build_import(
        node,
        &specifier,
        is_relative,
        named_imports,
        None,
        is_re_export,
    ));
}

fn extract_from_specifier(node: Node<'_>, source: &[u8]) -> String {
    if let Some(module_name) = node.child_by_field_name("module_name") {
        return node_text(module_name, source).to_string();
    }

    if let Some(relative_import) = find_child_node(node, "relative_import") {
        return node_text(relative_import, source).to_string();
    }

    String::new()
}

fn has_relative_import_module(node: Node<'_>) -> bool {
    let Some(module_name) = node.child_by_field_name("module_name") else {
        return false;
    };
    module_name.kind() == "relative_import"
}

fn build_import(
    node: Node<'_>,
    specifier: &str,
    is_relative: bool,
    named_imports: Vec<String>,
    namespace_import: Option<String>,
    is_re_export: bool,
) -> NativeParsedImport {
    NativeParsedImport {
        specifier: specifier.to_string(),
        is_relative,
        is_external: !is_relative && !is_stdlib_module(specifier),
        named_imports,
        default_import: None,
        namespace_import,
        is_re_export,
        range: extract_range(node),
    }
}

fn is_relative_specifier(specifier: &str) -> bool {
    specifier.starts_with('.')
}

fn is_stdlib_module(specifier: &str) -> bool {
    let first_part = specifier
        .trim_start_matches('.')
        .split('.')
        .next()
        .unwrap_or("");
    PYTHON_STDLIB_MODULES.contains(&first_part)
}
