use tree_sitter::Node;

use crate::types::{NativeParsedImport, NativeRange};

/// Node.js built-in module names for detecting external vs builtin imports.
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

/// Extract all import statements from a parsed AST.
///
/// Mirrors TypeScript `extractImports` in `treesitter/extractImports.ts`.
/// Instead of tree-sitter queries (which require language-specific Query objects),
/// we walk the AST directly looking for import_statement and export_statement nodes
/// with source specifiers.
pub fn extract_imports(
    root: Node<'_>,
    source: &[u8],
    _language: &str,
) -> Vec<NativeParsedImport> {
    let mut imports = Vec::new();
    walk_for_imports(root, source, &mut imports);
    imports
}

fn walk_for_imports(node: Node<'_>, source: &[u8], imports: &mut Vec<NativeParsedImport>) {
    match node.kind() {
        "import_statement" | "export_statement" => {
            // Find the source string (module specifier)
            if let Some(specifier) = extract_source_specifier(node, source) {
                let import = parse_import_node(node, &specifier, source);
                imports.push(import);
            }
        }
        _ => {}
    }

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        walk_for_imports(child, source, imports);
    }
}

/// Extract the module specifier from an import/export statement.
/// Looks for: source: (string (string_fragment) ...)
fn extract_source_specifier(node: Node<'_>, source: &[u8]) -> Option<String> {
    // Look for "source" field first
    if let Some(source_node) = node.child_by_field_name("source") {
        return extract_string_value(source_node, source);
    }

    // Fallback: search children for string nodes
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() == "string" {
            return extract_string_value(child, source);
        }
    }

    None
}

/// Extract the text value from a string node, stripping quotes.
fn extract_string_value(string_node: Node<'_>, source: &[u8]) -> Option<String> {
    // Look for string_fragment child
    let mut cursor = string_node.walk();
    for child in string_node.children(&mut cursor) {
        if child.kind() == "string_fragment" {
            let text = node_text(child, source);
            return Some(text.to_string());
        }
    }

    // Fallback: strip quotes from the string node text
    let text = node_text(string_node, source);
    if text.len() >= 2 {
        let first = text.chars().next()?;
        let last = text.chars().last()?;
        if (first == '"' || first == '\'') && first == last {
            return Some(text[1..text.len() - 1].to_string());
        }
    }

    None
}

/// Parse an import/export statement node into a NativeParsedImport.
fn parse_import_node(
    node: Node<'_>,
    specifier: &str,
    source: &[u8],
) -> NativeParsedImport {
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
        range: extract_range(node),
    };

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        match child.kind() {
            "import_clause" => {
                // Default import: identifier directly under import_clause
                if let Some(default_name) = find_child_by_kind(child, "identifier", source) {
                    result.default_import = Some(default_name);
                }

                // Named imports
                if let Some(named_node) = find_child_node(child, "named_imports") {
                    let names = extract_named_imports(named_node, source);
                    result.named_imports.extend(names);
                }

                // Namespace import
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
                    // Check previous sibling isn't a special node
                    let child_idx = child_index_in_parent(child, node);
                    if child_idx > 0 {
                        if let Some(prev) = node.child(child_idx - 1) {
                            let prev_kind = prev.kind();
                            if prev_kind != "named_imports"
                                && prev_kind != "export_clause"
                                && prev_kind != "from"
                            {
                                result.default_import =
                                    Some(node_text(child, source).to_string());
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

    // Handle bare import (import "module") without source/from keyword
    if node.kind() == "import_statement" {
        let has_source = {
            let mut c = node.walk();
            let result = node.children(&mut c)
                .any(|child| child.kind() == "from" || child.kind() == "source");
            result
        };

        if !has_source {
            let mut c = node.walk();
            let identifier = node.children(&mut c).find(|child| child.kind() == "identifier");
            if let Some(id) = identifier {
                if result.named_imports.is_empty() && result.namespace_import.is_none() {
                    result.default_import = Some(node_text(id, source).to_string());
                }
            }
        }
    }

    result
}

/// Extract named import identifiers from a named_imports or export_clause node.
fn extract_named_imports(node: Node<'_>, source: &[u8]) -> Vec<String> {
    let mut names = Vec::new();

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() == "import_specifier" || child.kind() == "export_specifier" {
            let identifiers = find_all_children_by_kind(child, "identifier", source);

            if identifiers.len() == 2 {
                // Has alias: import { foo as bar } - use the alias (second identifier)
                names.push(identifiers[1].clone());
            } else if identifiers.len() == 1 {
                // No alias: import { foo }
                names.push(identifiers[0].clone());
            }
        }
    }

    names
}

// --- Helper functions ---

fn node_text<'a>(node: Node<'a>, source: &'a [u8]) -> &'a str {
    node.utf8_text(source).unwrap_or("")
}

fn extract_range(node: Node<'_>) -> NativeRange {
    let start = node.start_position();
    let end = node.end_position();
    NativeRange {
        start_line: (start.row + 1) as u32,
        start_col: start.column as u32,
        end_line: (end.row + 1) as u32,
        end_col: end.column as u32,
    }
}

fn find_child_by_kind(parent: Node<'_>, kind: &str, source: &[u8]) -> Option<String> {
    let mut cursor = parent.walk();
    for child in parent.children(&mut cursor) {
        if child.kind() == kind {
            return Some(node_text(child, source).to_string());
        }
    }
    None
}

fn find_child_node<'a>(parent: Node<'a>, kind: &str) -> Option<Node<'a>> {
    let mut cursor = parent.walk();
    let mut result = None;
    for c in parent.children(&mut cursor) {
        if c.kind() == kind {
            result = Some(c);
            break;
        }
    }
    result
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
