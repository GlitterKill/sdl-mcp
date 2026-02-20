use tree_sitter::Node;

use crate::extract::fingerprint::generate_ast_fingerprint;
use crate::extract::symbol_id::generate_symbol_id;
use crate::types::{NativeParsedSymbol, NativeRange};

/// Extract all symbols from a parsed AST tree.
///
/// Mirrors TypeScript `extractSymbols` in `treesitter/extractSymbols.ts`.
pub fn extract_symbols(
    root: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
    _language: &str,
) -> Vec<NativeParsedSymbol> {
    let mut symbols = Vec::new();
    traverse_ast(root, source, repo_id, rel_path, &mut symbols);
    symbols
}

fn traverse_ast(
    node: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
    symbols: &mut Vec<NativeParsedSymbol>,
) {
    match node.kind() {
        "function_declaration" | "generator_function_declaration" => {
            if let Some(sym) = process_function_declaration(node, source, repo_id, rel_path) {
                symbols.push(sym);
            }
        }
        "method_definition" => {
            if let Some(sym) = process_method_definition(node, source, repo_id, rel_path) {
                symbols.push(sym);
            }
        }
        "class_declaration" => {
            if let Some(sym) = process_class_declaration(node, source, repo_id, rel_path) {
                symbols.push(sym);
            }
        }
        "interface_declaration" => {
            if let Some(sym) = process_interface_declaration(node, source, repo_id, rel_path) {
                symbols.push(sym);
            }
        }
        "type_alias_declaration" => {
            if let Some(sym) = process_type_alias_declaration(node, source, repo_id, rel_path) {
                symbols.push(sym);
            }
        }
        "lexical_declaration" | "variable_declaration" => {
            let mut cursor = node.walk();
            for child in node.children(&mut cursor) {
                if child.kind() == "variable_declarator" {
                    let var_symbols =
                        process_variable_declaration(child, source, repo_id, rel_path, node);
                    symbols.extend(var_symbols);
                }
            }
        }
        "ambient_statement" => {
            let mut cursor = node.walk();
            for child in node.children(&mut cursor) {
                if child.kind() == "module" {
                    if let Some(sym) = process_module(child, source, repo_id, rel_path) {
                        symbols.push(sym);
                    }
                }
            }
        }
        "module" => {
            if let Some(sym) = process_module(node, source, repo_id, rel_path) {
                symbols.push(sym);
            }
        }
        "assignment_expression" => {
            process_assignment_expression(node, source, repo_id, rel_path, symbols);
        }
        _ => {}
    }

    // Recurse into children
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        traverse_ast(child, source, repo_id, rel_path, symbols);
    }
}

fn extract_identifier(node: Node<'_>, source: &[u8]) -> Option<String> {
    match node.kind() {
        "identifier" | "property_identifier" | "type_identifier" => {
            return Some(node_text(node, source).to_string());
        }
        _ => {}
    }

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        match child.kind() {
            "identifier" | "property_identifier" | "type_identifier" => {
                return Some(node_text(child, source).to_string());
            }
            _ => {}
        }
    }

    None
}

fn extract_generics(node: Node<'_>, source: &[u8]) -> Vec<String> {
    let mut generics = Vec::new();

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() == "type_parameters" {
            let mut inner_cursor = child.walk();
            for param_child in child.children(&mut inner_cursor) {
                if param_child.kind() == "type_identifier"
                    || param_child.kind() == "type_parameter"
                {
                    generics.push(node_text(param_child, source).to_string());
                }
            }
            break;
        }
    }

    generics
}

fn extract_parameters(node: Node<'_>, source: &[u8]) -> Vec<ParamInfo> {
    let mut params = Vec::new();

    let mut cursor = node.walk();
    let param_list = node.children(&mut cursor).find(|c| {
        c.kind() == "formal_parameters"
            || c.kind() == "required_parameters"
            || c.kind() == "optional_parameters"
    });

    if let Some(param_list) = param_list {
        let mut param_cursor = param_list.walk();
        for child in param_list.children(&mut param_cursor) {
            match child.kind() {
                "required_parameter" | "optional_parameter" => {
                    let identifier = find_child_by_kind(child, "identifier", source);
                    let type_annotation = find_child_by_kind(child, "type_annotation", source);

                    if let Some(name) = identifier {
                        params.push(ParamInfo {
                            name,
                            type_annotation,
                        });
                    }
                }
                "identifier" => {
                    params.push(ParamInfo {
                        name: node_text(child, source).to_string(),
                        type_annotation: None,
                    });
                }
                "rest_parameter" => {
                    let identifier = find_child_by_kind(child, "identifier", source);
                    let type_annotation = find_child_by_kind(child, "type_annotation", source);

                    if let Some(name) = identifier {
                        params.push(ParamInfo {
                            name: format!("...{name}"),
                            type_annotation,
                        });
                    }
                }
                _ => {}
            }
        }
    }

    params
}

fn extract_return_type(node: Node<'_>, source: &[u8]) -> Option<String> {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() == "return_type" {
            return Some(node_text(child, source).to_string());
        }
    }
    None
}

fn extract_decorators(node: Node<'_>, source: &[u8]) -> Vec<String> {
    let mut decorators = Vec::new();
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() == "decorator" {
            decorators.push(node_text(child, source).to_string());
        }
    }
    decorators
}

fn is_exported(node: Node<'_>) -> bool {
    let mut current = Some(node);

    while let Some(n) = current {
        if n.kind() == "export_statement" {
            return true;
        }

        let mut cursor = n.walk();
        for child in n.children(&mut cursor) {
            if child.kind() == "export_clause" || child.kind() == "export_specifier" {
                return true;
            }
        }

        current = n.parent();
    }

    false
}

fn extract_visibility(node: Node<'_>) -> String {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() == "accessibility_modifier" {
            let text = child.utf8_text(&[]).unwrap_or("");
            match text {
                "public" | "private" | "protected" => return text.to_string(),
                _ => {}
            }
        }
    }
    String::new()
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

fn make_symbol(
    name: &str,
    kind: &str,
    node: Node<'_>,
    _source: &[u8],
    repo_id: &str,
    rel_path: &str,
    params: &[ParamInfo],
    returns: Option<&str>,
    generics: &[String],
    visibility: &str,
    _decorators: &[String],
) -> NativeParsedSymbol {
    let fingerprint = generate_ast_fingerprint(node);
    let symbol_id = generate_symbol_id(repo_id, rel_path, kind, name, &fingerprint);

    let signature = build_signature_json(params, returns, generics);

    NativeParsedSymbol {
        symbol_id,
        ast_fingerprint: fingerprint,
        kind: kind.to_string(),
        name: name.to_string(),
        exported: is_exported(node),
        visibility: visibility.to_string(),
        range: extract_range(node),
        signature_json: signature,
        summary: String::new(),    // Filled by summary module later
        invariants_json: "[]".into(),
        side_effects_json: "[]".into(),
    }
}

fn process_function_declaration(
    node: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
) -> Option<NativeParsedSymbol> {
    let name = extract_identifier(node, source)?;

    // Check for function_signature child
    let mut cursor = node.walk();
    let sig_node = node
        .children(&mut cursor)
        .find(|c| c.kind() == "function_signature");

    let (generics, params, returns) = if let Some(sig) = sig_node {
        (
            extract_generics(sig, source),
            extract_parameters(sig, source),
            extract_return_type(sig, source),
        )
    } else {
        (
            Vec::new(),
            extract_parameters(node, source),
            extract_return_type(node, source),
        )
    };

    Some(make_symbol(
        &name,
        "function",
        node,
        source,
        repo_id,
        rel_path,
        &params,
        returns.as_deref(),
        &generics,
        "",
        &extract_decorators(node, source),
    ))
}

fn process_method_definition(
    node: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
) -> Option<NativeParsedSymbol> {
    let name = extract_identifier(node, source)?;

    let params = extract_parameters(node, source);
    let returns = extract_return_type(node, source);
    let visibility = extract_visibility(node);
    let decorators = extract_decorators(node, source);
    let generics = extract_generics(node, source);

    let kind = if name == "constructor" {
        "constructor"
    } else {
        "method"
    };

    Some(make_symbol(
        &name,
        kind,
        node,
        source,
        repo_id,
        rel_path,
        &params,
        returns.as_deref(),
        &generics,
        &visibility,
        &decorators,
    ))
}

fn process_class_declaration(
    node: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
) -> Option<NativeParsedSymbol> {
    let name = extract_identifier(node, source)?;
    let generics = extract_generics(node, source);

    Some(make_symbol(
        &name,
        "class",
        node,
        source,
        repo_id,
        rel_path,
        &[],
        None,
        &generics,
        "",
        &extract_decorators(node, source),
    ))
}

fn process_interface_declaration(
    node: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
) -> Option<NativeParsedSymbol> {
    let name = extract_identifier(node, source)?;
    let generics = extract_generics(node, source);

    Some(make_symbol(
        &name,
        "interface",
        node,
        source,
        repo_id,
        rel_path,
        &[],
        None,
        &generics,
        "",
        &[],
    ))
}

fn process_type_alias_declaration(
    node: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
) -> Option<NativeParsedSymbol> {
    let name = extract_identifier(node, source)?;
    let generics = extract_generics(node, source);

    Some(make_symbol(
        &name,
        "type",
        node,
        source,
        repo_id,
        rel_path,
        &[],
        None,
        &generics,
        "",
        &[],
    ))
}

fn process_variable_declaration(
    declarator: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
    parent_node: Node<'_>,
) -> Vec<NativeParsedSymbol> {
    // Check for destructuring patterns
    if let Some(left) = declarator.child_by_field_name("name") {
        if left.kind() == "object_pattern" || left.kind() == "array_pattern" {
            let mut results = Vec::new();
            let mut cursor = left.walk();
            for child in left.children(&mut cursor) {
                let pattern_name = match child.kind() {
                    "shorthand_property_identifier_pattern" => {
                        Some(node_text(child, source).to_string())
                    }
                    "identifier" | "pair" | "object_pattern" | "array_pattern" => {
                        extract_identifier(child, source)
                    }
                    _ => {
                        // Check for name field
                        if let Some(name_node) = child.child_by_field_name("name") {
                            extract_identifier(name_node, source)
                        } else {
                            None
                        }
                    }
                };

                if let Some(name) = pattern_name {
                    let fingerprint = generate_ast_fingerprint(child);
                    let symbol_id =
                        generate_symbol_id(repo_id, rel_path, "variable", &name, &fingerprint);

                    results.push(NativeParsedSymbol {
                        symbol_id,
                        ast_fingerprint: fingerprint,
                        kind: "variable".to_string(),
                        name,
                        exported: is_exported(parent_node),
                        visibility: String::new(),
                        range: extract_range(child),
                        signature_json: "{}".to_string(),
                        summary: String::new(),
                        invariants_json: "[]".to_string(),
                        side_effects_json: "[]".to_string(),
                    });
                }
            }
            return results;
        }
    }

    let name = match extract_identifier(declarator, source) {
        Some(n) => n,
        None => return vec![],
    };

    vec![make_symbol(
        &name,
        "variable",
        declarator,
        source,
        repo_id,
        rel_path,
        &[],
        None,
        &[],
        "",
        &[],
    )]
}

fn process_module(
    node: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
) -> Option<NativeParsedSymbol> {
    let name = extract_identifier(node, source)?;
    Some(make_symbol(
        &name, "module", node, source, repo_id, rel_path, &[], None, &[], "", &[],
    ))
}

fn process_assignment_expression(
    node: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
    symbols: &mut Vec<NativeParsedSymbol>,
) {
    // Check if second child is "="
    let child_count = node.child_count();
    if child_count < 3 {
        return;
    }

    let op = node.child(1);
    if op.map(|n| node_text(n, source)) != Some("=") {
        return;
    }

    let left = match node.child(0) {
        Some(n) if n.kind() == "identifier" => n,
        _ => return,
    };

    let right = match node.child(2) {
        Some(n) if n.kind() == "arrow_function" || n.kind() == "function_expression" => n,
        _ => return,
    };

    let left_name = node_text(left, source).to_string();
    let params = extract_parameters(right, source);
    let returns = extract_return_type(right, source);

    let mut sym = make_symbol(
        &left_name,
        "function",
        right,
        source,
        repo_id,
        rel_path,
        &params,
        returns.as_deref(),
        &[],
        "",
        &[],
    );
    sym.name = left_name;
    symbols.push(sym);
}

// --- Helper types and functions ---

struct ParamInfo {
    name: String,
    type_annotation: Option<String>,
}

fn node_text<'a>(node: Node<'a>, source: &'a [u8]) -> &'a str {
    node.utf8_text(source).unwrap_or("")
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

fn build_signature_json(
    params: &[ParamInfo],
    returns: Option<&str>,
    generics: &[String],
) -> String {
    let mut parts = Vec::new();

    // params
    let param_entries: Vec<String> = params
        .iter()
        .map(|p| {
            if let Some(ref t) = p.type_annotation {
                format!(
                    "{{\"name\":{},\"type\":{}}}",
                    serde_json::to_string(&p.name).unwrap_or_default(),
                    serde_json::to_string(t).unwrap_or_default()
                )
            } else {
                format!(
                    "{{\"name\":{}}}",
                    serde_json::to_string(&p.name).unwrap_or_default()
                )
            }
        })
        .collect();
    parts.push(format!("\"params\":[{}]", param_entries.join(",")));

    // returns
    if let Some(ret) = returns {
        parts.push(format!(
            "\"returns\":{}",
            serde_json::to_string(ret).unwrap_or_default()
        ));
    }

    // generics
    if !generics.is_empty() {
        let gen_entries: Vec<String> = generics
            .iter()
            .map(|g| serde_json::to_string(g).unwrap_or_default())
            .collect();
        parts.push(format!("\"generics\":[{}]", gen_entries.join(",")));
    }

    format!("{{{}}}", parts.join(","))
}
