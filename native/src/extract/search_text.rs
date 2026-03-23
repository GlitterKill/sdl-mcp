use std::collections::HashSet;

use crate::types::NativeParsedSymbol;

pub fn build_search_text(
    symbol: &NativeParsedSymbol,
    rel_path: &str,
    role_tags: &[String],
) -> String {
    let mut parts = Vec::new();
    parts.push(symbol.name.clone());
    parts.extend(split_identifier_like_text(&symbol.name));

    if !symbol.summary.trim().is_empty() {
        parts.push(symbol.summary.trim().to_string());
        parts.extend(split_identifier_like_text(&symbol.summary));
    }

    parts.push(symbol.kind.clone());
    parts.extend(role_tags.iter().cloned());
    parts.extend(split_path_tokens(rel_path));
    parts.extend(extract_signature_terms(&symbol.signature));

    let mut seen = HashSet::new();
    let mut normalized = Vec::new();
    for part in parts {
        let token = part.trim().to_lowercase();
        if token.is_empty() || !seen.insert(token.clone()) {
            continue;
        }
        normalized.push(token);
    }

    normalized.join(" ")
}

fn split_identifier_like_text(input: &str) -> Vec<String> {
    let mut result = Vec::new();
    let mut current = String::new();
    let chars: Vec<char> = input.chars().collect();

    for (idx, ch) in chars.iter().enumerate() {
        if ch.is_alphanumeric() {
            let boundary = idx > 0
                && ch.is_uppercase()
                && (!chars[idx - 1].is_uppercase()
                    || (idx + 1 < chars.len() && chars[idx + 1].is_lowercase()));
            if boundary && !current.is_empty() {
                result.push(current.clone());
                current.clear();
            }
            current.push(*ch);
        } else if !current.is_empty() {
            result.push(current.clone());
            current.clear();
        }
    }

    if !current.is_empty() {
        result.push(current);
    }

    result
}

fn split_path_tokens(rel_path: &str) -> Vec<String> {
    rel_path
        .replace('\\', "/")
        .split(['/', '.', '-', '_'])
        .filter(|part| !part.is_empty())
        .map(|part| part.to_string())
        .collect()
}

fn extract_signature_terms(signature: &Option<crate::types::NativeSymbolSignature>) -> Vec<String> {
    let Some(sig) = signature else {
        return Vec::new();
    };

    let mut terms = Vec::new();
    if let Some(ref params) = sig.params {
        for param in params {
            terms.push(param.name.clone());
            terms.extend(split_identifier_like_text(&param.name));
        }
    }

    terms
}

#[cfg(test)]
mod tests {
    use crate::types::{NativeParsedSymbol, NativeRange, NativeSymbolSignature, NativeSymbolSignatureParam};

    use super::build_search_text;

    fn stub_symbol() -> NativeParsedSymbol {
        NativeParsedSymbol {
            symbol_id: "sym".to_string(),
            ast_fingerprint: "fp".to_string(),
            kind: "function".to_string(),
            name: "handleLoginRequest".to_string(),
            exported: true,
            visibility: "public".to_string(),
            range: NativeRange {
                start_line: 1,
                start_col: 0,
                end_line: 3,
                end_col: 0,
            },
            signature: Some(NativeSymbolSignature {
                params: Some(vec![NativeSymbolSignatureParam {
                    name: "authRequest".to_string(),
                    type_name: Some("Request".to_string()),
                }]),
                returns: None,
                generics: None,
            }),
            summary: "Handle login requests".to_string(),
            invariants: vec![],
            side_effects: vec![],
            role_tags: vec![],
            search_text: String::new(),
            summary_quality: None,
        }
    }

    #[test]
    fn includes_name_summary_tags_path_and_signature_terms() {
        let symbol = stub_symbol();
        let text = build_search_text(
            &symbol,
            "src/api/auth-handler.ts",
            &["handler".to_string(), "entrypoint".to_string()],
        );

        assert!(text.contains("handleloginrequest"));
        assert!(text.contains("handle"));
        assert!(text.contains("login"));
        assert!(text.contains("requests"));
        assert!(text.contains("handler"));
        assert!(text.contains("entrypoint"));
        assert!(text.contains("auth"));
        assert!(text.contains("request"));
    }
}
