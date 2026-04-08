use tree_sitter::Node;

use crate::types::NativeParsedSymbol;

use super::common::{
    extract_range, find_child_by_kind, make_symbol, make_symbol_with_forced_signature,
    node_text, ParamInfo,
};

pub fn extract_symbols_ts(
    root: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
) -> Vec<NativeParsedSymbol> {
    let mut symbols = Vec::new();
    traverse_ast(root, source, repo_id, rel_path, &mut symbols);
    symbols
}

fn traverse_ast(
    root: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
    symbols: &mut Vec<NativeParsedSymbol>,
) {
    let mut stack: Vec<(Node, u32)> = vec![(root, 0)];

    while let Some((node, scope_depth)) = stack.pop() {
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
                if scope_depth == 0 {
                    let mut cursor = node.walk();
                    for child in node.children(&mut cursor) {
                        if child.kind() == "variable_declarator" {
                            let var_symbols =
                                process_variable_declaration(child, source, repo_id, rel_path, node);
                            symbols.extend(var_symbols);
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

        // Increment scope depth when entering function/method/arrow bodies
        let enters_function_scope = matches!(
            node.kind(),
            "function_declaration"
                | "generator_function_declaration"
                | "method_definition"
                | "arrow_function"
                | "function"
                | "static_block"
        );
        let child_scope_depth = if enters_function_scope {
            scope_depth + 1
        } else {
            scope_depth
        };

        let child_count = node.child_count();
        for i in (0..child_count).rev() {
            if let Some(child) = node.child(i) {
                stack.push((child, child_scope_depth));
            }
        }
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
                if param_child.kind() == "type_identifier" || param_child.kind() == "type_parameter"
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

fn extract_visibility(node: Node<'_>, source: &[u8]) -> String {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() == "accessibility_modifier" {
            let text = node_text(child, source);
            match text {
                "public" | "private" | "protected" => return text.to_string(),
                _ => {}
            }
        }
    }
    String::new()
}

fn process_function_declaration(
    node: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
) -> Option<NativeParsedSymbol> {
    let name = extract_identifier(node, source)?;

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

    let decorators = extract_decorators(node, source);
    let mut symbol = make_symbol_with_forced_signature(
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
        &decorators,
    );
    symbol.exported = is_exported(node);
    Some(symbol)
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
    let visibility = extract_visibility(node, source);
    let decorators = extract_decorators(node, source);

    // TS source-of-truth only extracts method generics when the method
    // has a `statement_block` body. Interface / abstract method
    // signatures (no body) produce empty generics.
    let has_body = {
        let mut cursor = node.walk();
        let result = node.children(&mut cursor)
            .any(|c| c.kind() == "statement_block");
        result
    };
    let generics = if has_body {
        extract_generics(node, source)
    } else {
        Vec::new()
    };

    let kind = if name == "constructor" {
        "constructor"
    } else {
        "method"
    };

    let mut symbol = make_symbol_with_forced_signature(
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
    );
    symbol.exported = is_exported(node);
    Some(symbol)
}

fn process_class_declaration(
    node: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
) -> Option<NativeParsedSymbol> {
    let name = extract_identifier(node, source)?;
    let generics = extract_generics(node, source);
    let decorators = extract_decorators(node, source);

    let mut symbol = make_symbol_with_forced_signature(
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
        &decorators,
    );
    symbol.exported = is_exported(node);
    Some(symbol)
}

fn process_interface_declaration(
    node: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
) -> Option<NativeParsedSymbol> {
    let name = extract_identifier(node, source)?;
    let generics = extract_generics(node, source);

    let mut symbol = make_symbol_with_forced_signature(
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
        &extract_decorators(node, source),
    );
    symbol.exported = is_exported(node);
    Some(symbol)
}

fn process_type_alias_declaration(
    node: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
) -> Option<NativeParsedSymbol> {
    let name = extract_identifier(node, source)?;
    let generics = extract_generics(node, source);

    let mut symbol = make_symbol_with_forced_signature(
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
        &extract_decorators(node, source),
    );
    symbol.exported = is_exported(node);
    Some(symbol)
}

fn process_variable_declaration(
    declarator: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
    parent_node: Node<'_>,
) -> Vec<NativeParsedSymbol> {
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
                        if let Some(name_node) = child.child_by_field_name("name") {
                            extract_identifier(name_node, source)
                        } else {
                            None
                        }
                    }
                };

                if let Some(name) = pattern_name {
                    let mut symbol = make_symbol(
                        &name,
                        "variable",
                        child,
                        source,
                        repo_id,
                        rel_path,
                        &[],
                        None,
                        &[],
                        "",
                        &extract_decorators(child, source),
                    );
                    symbol.exported = is_exported(parent_node);
                    symbol.range = extract_range(child);
                    results.push(symbol);
                }
            }
            return results;
        }
    }

    let name = match extract_identifier(declarator, source) {
        Some(n) => n,
        None => return vec![],
    };

    let mut symbol = make_symbol(
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
        &extract_decorators(declarator, source),
    );
    symbol.exported = is_exported(parent_node);
    vec![symbol]
}

fn process_module(
    node: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
) -> Option<NativeParsedSymbol> {
    let name = extract_identifier(node, source)?;
    let mut symbol = make_symbol(
        &name,
        "module",
        node,
        source,
        repo_id,
        rel_path,
        &[],
        None,
        &[],
        "",
        &extract_decorators(node, source),
    );
    symbol.exported = is_exported(node);
    Some(symbol)
}

fn process_assignment_expression(
    node: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
    symbols: &mut Vec<NativeParsedSymbol>,
) {
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

    let mut symbol = make_symbol_with_forced_signature(
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
        &extract_decorators(right, source),
    );
    symbol.name = left_name;
    symbol.exported = is_exported(right);
    symbols.push(symbol);
}
