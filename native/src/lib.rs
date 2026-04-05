#[macro_use]
extern crate napi_derive;

use std::collections::HashMap;

use regex::Regex;

pub mod cluster;
pub mod error;
pub mod extract;
pub mod lang;
pub mod parse;
pub mod process;
pub mod scanner;
pub mod scip;
pub mod types;

use types::{
    NativeClusterAssignment, NativeClusterEdge, NativeClusterSymbol, NativeFileInput,
    NativeParsedFile, NativeProcess, NativeProcessCallEdge, NativeProcessStep,
    NativeProcessSymbol,
};

#[napi]
pub fn parse_files(
    files: Vec<NativeFileInput>,
    thread_count: u32,
) -> Vec<NativeParsedFile> {
    let count = if thread_count == 0 {
        num_cpus()
    } else {
        thread_count as usize
    };

    parse::parse_files_parallel(&files, count)
}

#[napi]
pub fn hash_content_native(content: String) -> String {
    parse::content_hash::hash_content(&content)
}

#[napi]
pub fn generate_symbol_id_native(
    repo_id: String,
    rel_path: String,
    kind: String,
    name: String,
    fingerprint: String,
) -> String {
    extract::symbol_id::generate_symbol_id(&repo_id, &rel_path, &kind, &name, &fingerprint)
}

#[napi]
pub fn compute_clusters(
    symbols: Vec<NativeClusterSymbol>,
    edges: Vec<NativeClusterEdge>,
    min_cluster_size: u32,
) -> Vec<NativeClusterAssignment> {
    if symbols.is_empty() {
        return Vec::new();
    }

    let min_size = if min_cluster_size == 0 {
        3usize
    } else {
        min_cluster_size as usize
    };

    // Deterministic symbol ordering regardless of input order.
    let mut symbol_ids: Vec<String> = symbols.into_iter().map(|s| s.symbol_id).collect();
    symbol_ids.sort();
    symbol_ids.dedup();

    let mut index_by_id: HashMap<String, usize> = HashMap::with_capacity(symbol_ids.len());
    for (idx, id) in symbol_ids.iter().enumerate() {
        index_by_id.insert(id.clone(), idx);
    }

    // Build an undirected, de-duplicated edge list on numeric indices.
    let mut edge_pairs: Vec<(usize, usize)> = Vec::with_capacity(edges.len());
    for edge in edges {
        let Some(&a) = index_by_id.get(&edge.from_symbol_id) else {
            continue;
        };
        let Some(&b) = index_by_id.get(&edge.to_symbol_id) else {
            continue;
        };
        if a == b {
            continue;
        }
        let (x, y) = if a < b { (a, b) } else { (b, a) };
        edge_pairs.push((x, y));
    }
    edge_pairs.sort_unstable();
    edge_pairs.dedup();

    let result = cluster::label_propagation(&edge_pairs, symbol_ids.len(), 100);

    let mut assignments: Vec<NativeClusterAssignment> = Vec::new();

    for (_label, members) in result.communities {
        if members.len() < min_size {
            continue;
        }

        let mut member_ids: Vec<&String> = members
            .iter()
            .filter_map(|idx| symbol_ids.get(*idx))
            .collect();
        member_ids.sort();

        let seed = member_ids
            .iter()
            .map(|s| s.as_str())
            .collect::<Vec<_>>()
            .join("|");
        let cluster_id = parse::content_hash::hash_content(&format!("cluster:{seed}"));

        for symbol_id in member_ids {
            assignments.push(NativeClusterAssignment {
                symbol_id: symbol_id.clone(),
                cluster_id: cluster_id.clone(),
                membership_score: 1.0,
            });
        }
    }

    assignments.sort_by(|a, b| a.symbol_id.cmp(&b.symbol_id));
    assignments
}

#[napi]
pub fn trace_processes(
    symbols: Vec<NativeProcessSymbol>,
    call_edges: Vec<NativeProcessCallEdge>,
    max_depth: u32,
    entry_patterns: Vec<String>,
) -> Vec<NativeProcess> {
    let mut patterns: Vec<Regex> = Vec::new();
    for pattern in entry_patterns {
        if let Ok(re) = Regex::new(&pattern) {
            patterns.push(re);
        }
    }
    if patterns.is_empty() {
        return Vec::new();
    }

    // Select deterministic entry symbols by sorting on symbol_id.
    let mut entry_symbol_ids: Vec<String> = symbols
        .iter()
        .filter(|s| patterns.iter().any(|re| re.is_match(&s.name)))
        .map(|s| s.symbol_id.clone())
        .collect();
    entry_symbol_ids.sort();
    entry_symbol_ids.dedup();

    if entry_symbol_ids.is_empty() {
        return Vec::new();
    }

    let edges: Vec<process::CallEdge> = call_edges
        .into_iter()
        .map(|e| process::CallEdge {
            caller_id: e.caller_id,
            callee_id: e.callee_id,
        })
        .collect();

    let tracer = process::ProcessTracer::new(Some(process::TracerConfig {
        max_depth: if max_depth == 0 {
            process::DEFAULT_MAX_DEPTH
        } else {
            max_depth
        },
    }));

    tracer
        .trace_multiple(&entry_symbol_ids, &edges)
        .into_iter()
        .map(|trace| {
            let steps: Vec<NativeProcessStep> = trace
                .steps
                .iter()
                .map(|s| NativeProcessStep {
                    symbol_id: s.symbol_id.clone(),
                    step_order: s.step_order,
                })
                .collect();

            // Deterministic process IDs (hash-based).
            let process_id = parse::content_hash::hash_content(&format!(
                "process:{}",
                trace.entry_symbol_id,
            ));

            NativeProcess {
                process_id,
                entry_symbol_id: trace.entry_symbol_id,
                steps,
                depth: trace.depth,
            }
        })
        .collect()
}

fn num_cpus() -> usize {
    let cpus = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1);
    cpus.saturating_sub(1).max(1)
}


// --- SCIP decoder napi exports ---

use std::sync::Arc;
use scip::decoder::ScipDecodeState;

#[napi]
pub struct ScipDecodeHandle {
    state: Arc<ScipDecodeState>,
}

#[napi]
pub fn scip_decode_start(file_path: String) -> napi::Result<ScipDecodeHandle> {
    let state = ScipDecodeState::new(&file_path)?;
    Ok(ScipDecodeHandle {
        state: Arc::new(state),
    })
}

#[napi]
impl ScipDecodeHandle {
    #[napi]
    pub fn metadata(&self) -> napi::Result<scip::types::NapiScipMetadata> {
        self.state.metadata()
    }

    #[napi]
    pub fn next_document(&self) -> napi::Result<Option<scip::types::NapiScipDocument>> {
        self.state.next_document()
    }

    #[napi]
    pub fn external_symbols(&self) -> napi::Result<Vec<scip::types::NapiScipExternalSymbol>> {
        self.state.external_symbols()
    }
}

