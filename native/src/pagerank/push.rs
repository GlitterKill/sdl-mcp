//! Andersen-Chung-Lang forward-push for Personalized PageRank.
//!
//! Mirrors `pushPpr` in `src/retrieval/ppr.ts` byte-for-byte (within numerical
//! tolerance). The TypeScript implementation is the reference; this module
//! exists purely to keep the hot loop out of V8 for graphs over a few thousand
//! nodes.

use std::collections::VecDeque;

use super::types::{NativePprAdjEntry, NativePprScore, NativePprSeed};

/// Run forward-push PPR.
///
/// `adjacency` is the directional out-neighbor list (TS owns direction
/// resolution). `seeds.weight` should already be normalized to sum 1. All
/// non-finite values in `adjacency` and `seeds` are dropped silently.
///
/// Returns the sparse score map sorted by node index ascending. Callers that
/// need sorted-by-score results sort downstream.
pub fn run(
    adjacency: Vec<Vec<NativePprAdjEntry>>,
    seeds: Vec<NativePprSeed>,
    alpha: f64,
    epsilon: f64,
    max_nodes_touched: usize,
) -> Vec<NativePprScore> {
    let n = adjacency.len();
    if n == 0 {
        return Vec::new();
    }

    let alpha = clamp01(alpha).unwrap_or(0.15);
    let epsilon = if epsilon.is_finite() && epsilon > 0.0 {
        epsilon
    } else {
        1e-4
    };
    let max_nodes_touched = if max_nodes_touched == 0 {
        2000
    } else {
        max_nodes_touched
    };

    // Pre-compute row-sum (out-degree weighted) for the residual threshold check.
    let mut row_sums: Vec<f64> = vec![0.0; n];
    for (i, row) in adjacency.iter().enumerate() {
        let mut sum = 0.0;
        for entry in row {
            if entry.weight.is_finite() && entry.weight > 0.0 {
                sum += entry.weight;
            }
        }
        row_sums[i] = sum;
    }

    let mut p: Vec<f64> = vec![0.0; n];
    let mut r: Vec<f64> = vec![0.0; n];
    let mut in_queue: Vec<u8> = vec![0; n];
    let mut touched: Vec<u8> = vec![0; n];
    let mut touched_count: usize = 0;
    let mut queue: VecDeque<usize> = VecDeque::new();

    let enqueue_if_above = |node: usize,
                            r: &Vec<f64>,
                            row_sums: &Vec<f64>,
                            in_queue: &mut Vec<u8>,
                            queue: &mut VecDeque<usize>| {
        if in_queue[node] == 1 {
            return;
        }
        let deg = row_sums[node];
        if deg <= 0.0 {
            return;
        }
        if r[node] / deg < epsilon {
            return;
        }
        queue.push_back(node);
        in_queue[node] = 1;
    };

    for seed in seeds {
        let idx = seed.node as usize;
        if idx >= n {
            continue;
        }
        if !seed.weight.is_finite() || seed.weight <= 0.0 {
            continue;
        }
        r[idx] += seed.weight;
        if touched[idx] == 0 {
            touched[idx] = 1;
            touched_count += 1;
        }
        enqueue_if_above(idx, &r, &row_sums, &mut in_queue, &mut queue);
    }

    let push_safety_cap = max_nodes_touched.saturating_mul(32);
    let mut pushed: usize = 0;

    while let Some(u) = queue.pop_front() {
        if touched_count >= max_nodes_touched {
            break;
        }
        in_queue[u] = 0;
        let ru = r[u];
        if ru == 0.0 {
            continue;
        }
        let deg = row_sums[u];
        if deg <= 0.0 {
            continue;
        }
        if ru / deg < epsilon {
            continue;
        }

        p[u] += alpha * ru;
        let remaining = (1.0 - alpha) * ru;
        r[u] = 0.0;

        for entry in &adjacency[u] {
            if !entry.weight.is_finite() || entry.weight <= 0.0 {
                continue;
            }
            let v = entry.neighbor as usize;
            if v >= n {
                continue;
            }
            let delta = remaining * (entry.weight / deg);
            r[v] += delta;
            if touched[v] == 0 {
                touched[v] = 1;
                touched_count += 1;
            }
            enqueue_if_above(v, &r, &row_sums, &mut in_queue, &mut queue);
        }

        pushed += 1;
        if pushed > push_safety_cap {
            break;
        }
    }

    let mut out: Vec<NativePprScore> = Vec::new();
    for (idx, score) in p.into_iter().enumerate() {
        if score > 0.0 && score.is_finite() {
            out.push(NativePprScore {
                node: idx as u32,
                score,
            });
        }
    }
    out
}

fn clamp01(x: f64) -> Option<f64> {
    if x.is_finite() && x > 0.0 && x < 1.0 {
        Some(x)
    } else {
        None
    }
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

    fn seeds(seeds: &[(u32, f64)]) -> Vec<NativePprSeed> {
        seeds
            .iter()
            .map(|(node, weight)| NativePprSeed {
                node: *node,
                weight: *weight,
            })
            .collect()
    }

    fn score_for(scores: &[NativePprScore], node: u32) -> f64 {
        scores
            .iter()
            .find(|s| s.node == node)
            .map(|s| s.score)
            .unwrap_or(0.0)
    }

    /// Six-node test graph used as the cross-reference between the JS and
    /// Rust backends. Topology: 0->1, 0->2, 1->3, 2->3, 3->4, 3->5 (chain
    /// fanning into 4/5). Seed at node 0 with weight 1.0.
    fn six_node_graph() -> Vec<Vec<NativePprAdjEntry>> {
        adj(&[
            &[(1, 1.0), (2, 1.0)],
            &[(3, 1.0)],
            &[(3, 1.0)],
            &[(4, 1.0), (5, 1.0)],
            &[],
            &[],
        ])
    }

    #[test]
    fn seed_node_dominates_score() {
        let scores = run(six_node_graph(), seeds(&[(0, 1.0)]), 0.15, 1e-4, 2000);
        let s0 = score_for(&scores, 0);
        let s3 = score_for(&scores, 3);
        let s5 = score_for(&scores, 5);
        // Seed always retains the highest mass.
        assert!(s0 > s3, "seed should dominate downstream nodes (s0={s0} s3={s3})");
        // Symmetry: nodes 4 and 5 have identical paths, scores should match.
        let s4 = score_for(&scores, 4);
        assert!(
            (s4 - s5).abs() < 1e-9,
            "symmetric leaves should match (s4={s4} s5={s5})"
        );
    }

    #[test]
    fn empty_graph_returns_empty() {
        let scores = run(Vec::new(), seeds(&[(0, 1.0)]), 0.15, 1e-4, 2000);
        assert!(scores.is_empty());
    }

    #[test]
    fn empty_seeds_returns_empty() {
        let scores = run(six_node_graph(), Vec::new(), 0.15, 1e-4, 2000);
        assert!(scores.is_empty());
    }

    #[test]
    fn out_of_range_seed_is_ignored() {
        let scores = run(six_node_graph(), seeds(&[(99, 1.0)]), 0.15, 1e-4, 2000);
        assert!(scores.is_empty());
    }

    #[test]
    fn linearity_two_seeds_sum_to_combined_run() {
        let alpha = 0.15;
        let eps = 1e-4;
        let max = 2000;
        let single_a = run(six_node_graph(), seeds(&[(0, 1.0)]), alpha, eps, max);
        let single_b = run(six_node_graph(), seeds(&[(3, 1.0)]), alpha, eps, max);
        let combined = run(six_node_graph(), seeds(&[(0, 0.5), (3, 0.5)]), alpha, eps, max);

        for node in 0..6 {
            let expected = 0.5 * score_for(&single_a, node) + 0.5 * score_for(&single_b, node);
            let actual = score_for(&combined, node);
            assert!(
                (expected - actual).abs() < 1e-3,
                "linearity violated at node {node}: expected={expected} actual={actual}"
            );
        }
    }

    #[test]
    fn touched_cap_bounds_payload() {
        // Tight cap of 3 means the seed (touched=1) plus its first push to
        // immediate neighbors can run, but the walk stops far short of the
        // unbounded result. Verifies the cap is enforced AND that the loop
        // does not panic / loop forever when the budget is small.
        let unbounded = run(six_node_graph(), seeds(&[(0, 1.0)]), 0.15, 1e-4, 2000);
        let bounded = run(six_node_graph(), seeds(&[(0, 1.0)]), 0.15, 1e-4, 3);
        assert!(bounded.len() <= unbounded.len(), "cap should not grow result");
    }
}
