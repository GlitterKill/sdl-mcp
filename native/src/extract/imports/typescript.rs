use tree_sitter::Node;

use crate::types::NativeParsedImport;

use super::common::{
    extract_range, extract_string_value, find_child_by_kind, find_child_node, node_text,
};

const BUILTIN_MODULES: &[&str] = &[
    "fs",
    "path",
    "os",
    "http",
    "https",
    "url",
    "querystring",
    "stream",
    "util",
    "events",
    "buffer",
    "crypto",
    "timers",
    "cluster",
    "child_process",
    "net",
    "dgram",
    "dns",
    "readline",
    "repl",
    "vm",
    "zlib",
    "assert",
    "tty",
    "module",
    "process",
    "console",
];

pub fn extract_imports_ts(root: Node<'_>, source: &[u8]) -> Vec<NativeParsedImport> {
    let mut imports = Vec::new();
    walk_for_imports(root, source, &mut imports);
    imports
}

fn walk_for_imports(root: Node<'_>, source: &[u8], imports: &mut Vec<NativeParsedImport>) {
    let mut stack = vec![root];

    while let Some(node) = stack.pop() {
        match node.kind() {
            "import_statement" | "export_statement" => {
                if let Some(specifier) = extract_source_specifier(node, source) {
                    let import = parse_import_node(node, &specifier, source);
                    imports.push(import);
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
}

fn extract_source_specifier(node: Node<'_>, source: &[u8]) -> Option<String> {
    if let Some(source_node) = node.child_by_field_name("source") {
        return extract_string_value(source_node, source);
    }

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() == "string" {
            return extract_string_value(child, source);
        }
    }

    None
}

fn parse_import_node(node: Node<'_>, specifier: &str, source: &[u8]) -> NativeParsedImport {
    let is_re_export = node.kind() == "export_statement";
    let is_relative = specifier.starts_with("./") || specifier.starts_with("../");
    let is_external = !is_relative && !BUILTIN_MODULES.contains(&specifier);

    let mut result = NativeParsedImport {
        specifier: specifier.to_string(),
        is_relative,
        is_external,
        named_imports: Vec::new(),
        default_import: None,
        namespace_import: None,
        is_re_export,
        range: extract_range(node),
    };

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        match child.kind() {
            "import_clause" => {
                if let Some(default_name) = find_child_by_kind(child, "identifier", source) {
                    result.default_import = Some(default_name);
                }

                if let Some(named_node) = find_child_node(child, "named_imports") {
                    let names = extract_named_imports(named_node, source);
                    result.named_imports.extend(names);
                }

                if let Some(ns_node) = find_child_node(child, "namespace_import") {
                    if let Some(name) = find_child_by_kind(ns_node, "identifier", source) {
                        result.namespace_import = Some(name);
                    }
                }
            }
            "named_imports" => {
                let names = extract_named_imports(child, source);
                result.named_imports.extend(names);
            }
            "export_clause" => {
                let names = extract_named_imports(child, source);
                result.named_imports.extend(names);
            }
            "namespace_import" => {
                if let Some(name) = find_child_by_kind(child, "identifier", source) {
                    result.namespace_import = Some(name);
                }
            }
            "identifier" => {
                if is_re_export && result.default_import.is_none() {
                    let child_idx = child_index_in_parent(child, node);
                    if child_idx > 0 {
                        if let Some(prev) = node.child(child_idx - 1) {
                            let prev_kind = prev.kind();
                            if prev_kind != "named_imports"
                                && prev_kind != "export_clause"
                                && prev_kind != "from"
                            {
                                result.default_import = Some(node_text(child, source).to_string());
                            }
                        }
                    } else {
                        result.default_import = Some(node_text(child, source).to_string());
                    }
                }
            }
            _ => {}
        }
    }

    if node.kind() == "import_statement" {
        let has_source = {
            let mut c = node.walk();
            let result = node
                .children(&mut c)
                .any(|child| child.kind() == "from" || child.kind() == "source");
            result
        };

        if !has_source {
            let mut c = node.walk();
            let identifier = node
                .children(&mut c)
                .find(|child| child.kind() == "identifier");
            if let Some(id) = identifier {
                if result.named_imports.is_empty() && result.namespace_import.is_none() {
                    result.default_import = Some(node_text(id, source).to_string());
                }
            }
        }
    }

    result
}

fn extract_named_imports(node: Node<'_>, source: &[u8]) -> Vec<String> {
    let mut names = Vec::new();

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() == "import_specifier" || child.kind() == "export_specifier" {
            let identifiers = find_all_children_by_kind(child, "identifier", source);

            if identifiers.len() == 2 {
                names.push(identifiers[1].clone());
            } else if identifiers.len() == 1 {
                names.push(identifiers[0].clone());
            }
        }
    }

    names
}

fn find_all_children_by_kind(parent: Node<'_>, kind: &str, source: &[u8]) -> Vec<String> {
    let mut results = Vec::new();
    let mut cursor = parent.walk();
    for child in parent.children(&mut cursor) {
        if child.kind() == kind {
            results.push(node_text(child, source).to_string());
        }
    }
    results
}

fn child_index_in_parent(child: Node<'_>, parent: Node<'_>) -> usize {
    let mut cursor = parent.walk();
    for (idx, c) in parent.children(&mut cursor).enumerate() {
        if c.id() == child.id() {
            return idx;
        }
    }
    0
}
