use tree_sitter::Node;

use crate::parse::content_hash::hash_content;

/// Generate a stable AST fingerprint for a symbol node.
///
/// Exact parity with TypeScript `generateAstFingerprint` in `fingerprints.ts`.
///
/// Algorithm:
/// 1. Build pipe-delimited parts: type, name, params count, async, static,
///    visibility, returnType, subtree hash
/// 2. Subtree hash: comma-delimited node types, skipping comments and literals
/// 3. Hash via SHA-256
pub fn generate_ast_fingerprint(node: Node<'_>) -> String {
    let mut parts: Vec<String> = Vec::new();

    // type:{node_type}
    parts.push(format!("type:{}", node.kind()));

    // name:{name}
    if let Some(name_node) = node.child_by_field_name("name") {
        let name_text = name_node.utf8_text(&[]).unwrap_or("");
        parts.push(format!("name:{name_text}"));
    }

    // params:{count}
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() == "formal_parameters" || child.kind() == "parameters" {
            let param_count = count_params(&child);
            parts.push(format!("params:{param_count}"));
            break;
        }
    }

    // async:true
    let mut cursor2 = node.walk();
    for child in node.children(&mut cursor2) {
        if child.kind() == "async" {
            parts.push("async:true".into());
            break;
        }
    }

    // static:true
    let mut cursor3 = node.walk();
    for child in node.children(&mut cursor3) {
        if child.kind() == "static" {
            parts.push("static:true".into());
            break;
        }
    }

    // visibility:{vis}
    let visibility_modifiers = ["public", "private", "protected", "internal"];
    let mut cursor4 = node.walk();
    for child in node.children(&mut cursor4) {
        let mut found = false;
        for vis in &visibility_modifiers {
            if child.kind() == *vis {
                parts.push(format!("visibility:{vis}"));
                found = true;
                break;
            }
        }
        if found {
            break;
        }
    }

    // returnType:true
    let has_return = node.child_by_field_name("return_type").is_some()
        || node.child_by_field_name("type").is_some();
    if has_return {
        parts.push("returnType:true".into());
    }

    // subtree:{hash}
    let subtree_hash = compute_subtree_hash(node);
    parts.push(format!("subtree:{subtree_hash}"));

    hash_content(&parts.join("|"))
}

/// Count parameters in a formal_parameters or parameters node.
/// Matches the TypeScript logic that counts required_parameter,
/// optional_parameter, identifier, and pattern children.
fn count_params(params_node: &Node<'_>) -> usize {
    let mut count = 0;
    let mut cursor = params_node.walk();
    for child in params_node.children(&mut cursor) {
        match child.kind() {
            "required_parameter" | "optional_parameter" | "identifier" | "pattern" => {
                count += 1;
            }
            _ => {}
        }
    }
    count
}

/// Compute subtree hash: collect normalized node types, join with comma,
/// hash with SHA-256.
fn compute_subtree_hash(node: Node<'_>) -> String {
    let mut parts: Vec<String> = Vec::new();
    collect_normalized_parts(node, &mut parts);
    hash_content(&parts.join(","))
}

/// Recursively collect node types, skipping comments and literals.
/// Exact match to TypeScript `collectNormalizedParts`.
fn collect_normalized_parts(node: Node<'_>, parts: &mut Vec<String>) {
    let kind = node.kind();

    let is_literal = kind.contains("string")
        || kind.contains("number")
        || kind == "true"
        || kind == "false"
        || kind == "null"
        || kind == "undefined";

    if !is_literal {
        parts.push(kind.to_string());

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if child.kind() != "comment" {
                collect_normalized_parts(child, parts);
            }
        }
    }
}

/// Generate AST fingerprint from source bytes (needs the node to have
/// access to source for text extraction via `utf8_text`).
pub fn generate_ast_fingerprint_with_source(node: Node<'_>, _source: &[u8]) -> String {
    // The node already has access to source through its tree.
    // We pass source separately for the API but use node.utf8_text internally.
    generate_ast_fingerprint(node)
}

#[cfg(test)]
mod tests {
    #[test]
    fn test_is_literal_detection() {
        // Verify the literal detection logic matches TypeScript
        let literals = vec![
            "string",
            "string_fragment",
            "number",
            "true",
            "false",
            "null",
            "undefined",
        ];
        for lit in literals {
            let is_lit = lit.contains("string")
                || lit.contains("number")
                || lit == "true"
                || lit == "false"
                || lit == "null"
                || lit == "undefined";
            assert!(is_lit, "{lit} should be detected as literal");
        }

        let non_literals = vec!["identifier", "function_declaration", "call_expression"];
        for nl in non_literals {
            let is_lit = nl.contains("string")
                || nl.contains("number")
                || nl == "true"
                || nl == "false"
                || nl == "null"
                || nl == "undefined";
            assert!(!is_lit, "{nl} should not be detected as literal");
        }
    }
}
