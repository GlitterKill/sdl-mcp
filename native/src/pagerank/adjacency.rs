//! Adjacency helpers for the personalized PageRank module.
//!
//! Most adjacency construction lives in TypeScript so the snapshot remains
//! single-sourced; this module keeps utilities for native-only paths
//! (currently just sanity checks reused by tests).

use super::types::NativePprAdjEntry;

/// Total outgoing weight from `node`. Treats non-finite or non-positive
/// entries as zero to match the push-loop's filtering rules.
pub fn out_weight(adjacency: &[Vec<NativePprAdjEntry>], node: usize) -> f64 {
    if node >= adjacency.len() {
        return 0.0;
    }
    let mut sum = 0.0;
    for entry in &adjacency[node] {
        if entry.weight.is_finite() && entry.weight > 0.0 {
            sum += entry.weight;
        }
    }
    sum
}

/// Returns true iff every node has zero out-weight.
pub fn is_sink_only(adjacency: &[Vec<NativePprAdjEntry>]) -> bool {
    (0..adjacency.len()).all(|i| out_weight(adjacency, i) <= 0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn adj(rows: &[&[(u32, f64)]]) -> Vec<Vec<NativePprAdjEntry>> {
        rows.iter()
            .map(|row| {
                row.iter()
                    .map(|(neighbor, weight)| NativePprAdjEntry {
                        neighbor: *neighbor,
                        weight: *weight,
                    })
                    .collect()
            })
            .collect()
    }

    #[test]
    fn out_weight_sums_positive_finite_entries_only() {
        let g = adj(&[&[(1, 0.5), (2, 1.5), (3, f64::NAN), (4, -1.0)]]);
        assert!((out_weight(&g, 0) - 2.0).abs() < 1e-12);
    }

    #[test]
    fn is_sink_only_detects_isolated_nodes() {
        let g = adj(&[&[], &[]]);
        assert!(is_sink_only(&g));
        let g2 = adj(&[&[(1, 1.0)], &[]]);
        assert!(!is_sink_only(&g2));
    }
}
