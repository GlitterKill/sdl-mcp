use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommunityResult {
    pub node_labels: HashMap<usize, usize>,
    pub communities: HashMap<usize, Vec<usize>>,
    pub unclustered: Vec<usize>,
}

pub fn label_propagation(
    edges: &[(usize, usize)],
    node_count: usize,
    max_iterations: usize,
) -> CommunityResult {
    let mut adj: Vec<Vec<usize>> = vec![Vec::new(); node_count];

    for &(src, dst) in edges {
        if src < node_count && dst < node_count {
            adj[src].push(dst);
            adj[dst].push(src);
        }
    }

    let mut labels: Vec<usize> = (0..node_count).collect();
    let mut label_counts: Vec<usize> = vec![0; node_count];

    for _ in 0..max_iterations {
        let mut changed = false;

        for node in 0..node_count {
            if adj[node].is_empty() {
                continue;
            }

            let mut max_count = 0usize;
            for &neighbor in &adj[node] {
                let lbl = labels[neighbor];
                label_counts[lbl] += 1;
                if label_counts[lbl] > max_count {
                    max_count = label_counts[lbl];
                }
            }

            let mut best_label = labels[node];
            for &neighbor in &adj[node] {
                let lbl = labels[neighbor];
                if label_counts[lbl] == max_count && lbl < best_label {
                    best_label = lbl;
                }
            }

            for &neighbor in &adj[node] {
                label_counts[labels[neighbor]] = 0;
            }

            if best_label != labels[node] {
                labels[node] = best_label;
                changed = true;
            }
        }

        if !changed {
            break;
        }
    }

    let mut label_to_min: Vec<usize> = (0..node_count).collect();
    for node in 0..node_count {
        let label = labels[node];
        if label < node_count && node < label_to_min[label] {
            label_to_min[label] = node;
        }
    }

    let mut final_labels: Vec<usize> = Vec::with_capacity(node_count);
    for node in 0..node_count {
        let canonical = label_to_min[labels[node]];
        final_labels.push(canonical);
    }

    let mut communities: HashMap<usize, Vec<usize>> = HashMap::new();
    let mut unclustered: Vec<usize> = Vec::new();

    for node in 0..node_count {
        if adj[node].is_empty() {
            unclustered.push(node);
        } else {
            communities.entry(final_labels[node]).or_default().push(node);
        }
    }
    for nodes in communities.values_mut() {
        nodes.sort();
    }
    unclustered.sort();

    let node_labels: HashMap<usize, usize> = (0..node_count)
        .map(|node| {
            if adj[node].is_empty() {
                (node, usize::MAX)
            } else {
                (node, final_labels[node])
            }
        })
        .collect();

    CommunityResult {
        node_labels,
        communities,
        unclustered,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    fn create_two_community_graph() -> (Vec<(usize, usize)>, usize) {
        let mut edges = Vec::new();
        for i in 0..50 {
            for j in (i + 1)..50 {
                edges.push((i, j));
            }
        }
        for i in 50..100 {
            for j in (i + 1)..100 {
                edges.push((i, j));
            }
        }
        edges.push((25, 75));
        (edges, 100)
    }

    fn create_single_component_graph() -> (Vec<(usize, usize)>, usize) {
        let mut edges = Vec::new();
        let node_count = 50;
        for i in 0..node_count {
            for j in (i + 1)..node_count {
                edges.push((i, j));
            }
        }
        (edges, node_count)
    }

    fn create_graph_with_singletons() -> (Vec<(usize, usize)>, usize) {
        let mut edges = Vec::new();
        for i in 0..20 {
            for j in (i + 1)..20 {
                edges.push((i, j));
            }
        }
        for i in 20..40 {
            for j in (i + 1)..40 {
                edges.push((i, j));
            }
        }
        (edges, 50)
    }

    #[test]
    fn test_two_communities() {
        let (edges, node_count) = create_two_community_graph();
        let result = label_propagation(&edges, node_count, 100);
        assert_eq!(result.communities.len(), 2);
        let mut sizes: Vec<usize> = result.communities.values().map(|v| v.len()).collect();
        sizes.sort();
        assert_eq!(sizes, vec![50, 50]);
        assert_eq!(result.unclustered.len(), 0);
    }

    #[test]
    fn test_single_component() {
        let (edges, node_count) = create_single_component_graph();
        let result = label_propagation(&edges, node_count, 100);
        assert_eq!(result.communities.len(), 1);
        let total: usize = result.communities.values().map(|v| v.len()).sum();
        assert_eq!(total, 50);
    }

    #[test]
    fn test_singletons() {
        let (edges, node_count) = create_graph_with_singletons();
        let result = label_propagation(&edges, node_count, 100);
        assert_eq!(result.unclustered.len(), 10);
        for s in &result.unclustered {
            assert!(*s >= 40 && *s < 50);
        }
        assert_eq!(result.communities.len(), 2);
    }

    #[test]
    fn test_determinism() {
        let (edges, node_count) = create_two_community_graph();
        let r1 = label_propagation(&edges, node_count, 100);
        let r2 = label_propagation(&edges, node_count, 100);
        assert_eq!(r1.node_labels, r2.node_labels);
        assert_eq!(r1.communities, r2.communities);
        assert_eq!(r1.unclustered, r2.unclustered);
    }

    #[test]
    fn test_performance() {
        let node_count = 5000usize;
        let mut edges = Vec::with_capacity(50000);
        for i in 0..node_count {
            for j in 1..=10usize {
                let neighbor = (i + j) % node_count;
                if i < neighbor {
                    edges.push((i, neighbor));
                }
            }
        }
        let mut rng: u64 = 12345;
        use std::collections::HashSet;
        let mut seen: HashSet<(usize, usize)> = edges.iter().cloned().collect();
        while edges.len() < 50000 {
            rng = rng.wrapping_mul(1103515245).wrapping_add(12345);
            let src = ((rng >> 16) as usize) % node_count;
            rng = rng.wrapping_mul(1103515245).wrapping_add(12345);
            let dst = ((rng >> 16) as usize) % node_count;
            let (a, b) = if src < dst { (src, dst) } else { (dst, src) };
            if a != b && seen.insert((a, b)) {
                edges.push((a, b));
            }
        }
        let start = Instant::now();
        let result = label_propagation(&edges, node_count, 100);
        let duration = start.elapsed();
        let total: usize = result.communities.values().map(|v| v.len()).sum();
        println!("{} nodes, {} edges, {} comms, {} clustered, {} unclustered, {:?}",
            node_count, edges.len(), result.communities.len(), total, result.unclustered.len(), duration);
        assert!(duration.as_millis() < 100, "took {:?}", duration);
    }
}
