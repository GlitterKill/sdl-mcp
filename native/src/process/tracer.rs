use std::collections::{HashMap, HashSet};

pub const DEFAULT_MAX_DEPTH: u32 = 20;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallEdge {
    pub caller_id: String,
    pub callee_id: String,
}

#[derive(Debug, Clone)]
pub struct TraceStep {
    pub symbol_id: String,
    pub step_order: u32,
}

#[derive(Debug, Clone)]
pub struct TraceResult {
    pub process_id: String,
    pub entry_symbol_id: String,
    pub steps: Vec<TraceStep>,
    pub depth: u32,
}

#[derive(Debug, Clone)]
pub struct TracerConfig {
    pub max_depth: u32,
}

impl Default for TracerConfig {
    fn default() -> Self {
        Self {
            max_depth: DEFAULT_MAX_DEPTH,
        }
    }
}

pub struct ProcessTracer {
    config: TracerConfig,
}

impl ProcessTracer {
    pub fn new(config: Option<TracerConfig>) -> Self {
        Self {
            config: config.unwrap_or_default(),
        }
    }

    pub fn trace(&self, entry_symbol_id: &str, edges: &[CallEdge]) -> TraceResult {
        let process_id = format!("trace:{}", entry_symbol_id);
        let mut steps = Vec::new();
        let mut visited = HashSet::new();
        let mut adjacency: HashMap<String, Vec<String>> = HashMap::new();
        let mut max_depth_reached: u32 = 0;

        for edge in edges {
            adjacency
                .entry(edge.caller_id.clone())
                .or_default()
                .push(edge.callee_id.clone());
        }

        for callees in adjacency.values_mut() {
            callees.sort();
            callees.dedup();
        }

        self.dfs(
            entry_symbol_id,
            0,
            &mut steps,
            &mut visited,
            &adjacency,
            &mut max_depth_reached,
        );

        TraceResult {
            process_id,
            entry_symbol_id: entry_symbol_id.to_string(),
            steps,
            depth: max_depth_reached,
        }
    }

    pub fn trace_multiple(&self, entry_symbol_ids: &[String], edges: &[CallEdge]) -> Vec<TraceResult> {
        entry_symbol_ids
            .iter()
            .map(|entry_id| self.trace(entry_id, edges))
            .collect()
    }

    fn dfs(
        &self,
        current_id: &str,
        depth: u32,
        steps: &mut Vec<TraceStep>,
        visited: &mut HashSet<String>,
        adjacency: &HashMap<String, Vec<String>>,
        max_depth_reached: &mut u32,
    ) {
        if depth > self.config.max_depth {
            return;
        }

        if visited.contains(current_id) {
            return;
        }

        *max_depth_reached = (*max_depth_reached).max(depth);
        visited.insert(current_id.to_string());
        steps.push(TraceStep {
            symbol_id: current_id.to_string(),
            step_order: steps.len() as u32,
        });

        if let Some(callees) = adjacency.get(current_id) {
            for callee_id in callees {
                self.dfs(
                    callee_id,
                    depth + 1,
                    steps,
                    visited,
                    adjacency,
                    max_depth_reached,
                );
            }
        }
    }
}

impl TraceResult {
    pub fn symbol_ids(&self) -> Vec<&str> {
        self.steps.iter().map(|s| s.symbol_id.as_str()).collect()
    }

    pub fn contains_cycle(&self) -> bool {
        let mut seen = HashSet::new();
        for step in &self.steps {
            if !seen.insert(&step.symbol_id) {
                return true;
            }
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    fn edge(caller: &str, callee: &str) -> CallEdge {
        CallEdge {
            caller_id: caller.to_string(),
            callee_id: callee.to_string(),
        }
    }

    #[test]
    fn test_linear_chain() {
        let tracer = ProcessTracer::new(None);
        let edges = vec![
            edge("a", "b"),
            edge("b", "c"),
            edge("c", "d"),
        ];

        let result = tracer.trace("a", &edges);

        assert_eq!(result.entry_symbol_id, "a");
        assert_eq!(result.steps.len(), 4);
        assert_eq!(result.steps[0].symbol_id, "a");
        assert_eq!(result.steps[0].step_order, 0);
        assert_eq!(result.steps[1].symbol_id, "b");
        assert_eq!(result.steps[1].step_order, 1);
        assert_eq!(result.steps[2].symbol_id, "c");
        assert_eq!(result.steps[2].step_order, 2);
        assert_eq!(result.steps[3].symbol_id, "d");
        assert_eq!(result.steps[3].step_order, 3);
        assert!(!result.contains_cycle());
    }

    #[test]
    fn test_diamond() {
        let tracer = ProcessTracer::new(None);
        let edges = vec![
            edge("a", "b"),
            edge("a", "c"),
            edge("b", "d"),
            edge("c", "d"),
        ];

        let result = tracer.trace("a", &edges);

        assert_eq!(result.entry_symbol_id, "a");
        assert_eq!(result.steps.len(), 4);

        let symbol_ids: Vec<&str> = result.symbol_ids();
        assert!(symbol_ids.contains(&"a"));
        assert!(symbol_ids.contains(&"b"));
        assert!(symbol_ids.contains(&"c"));
        assert!(symbol_ids.contains(&"d"));

        assert_eq!(symbol_ids[0], "a");

        assert!(!result.contains_cycle());
    }

    #[test]
    fn test_cycle() {
        let tracer = ProcessTracer::new(None);
        let edges = vec![
            edge("a", "b"),
            edge("b", "c"),
            edge("c", "a"),
        ];

        let result = tracer.trace("a", &edges);

        assert_eq!(result.steps.len(), 3);
        let symbol_ids: Vec<&str> = result.symbol_ids();
        assert_eq!(symbol_ids[0], "a");
        assert!(symbol_ids.contains(&"b"));
        assert!(symbol_ids.contains(&"c"));

        assert!(!result.contains_cycle());
    }

    #[test]
    fn test_depth_limit() {
        let config = TracerConfig {
            max_depth: 3,
        };
        let tracer = ProcessTracer::new(Some(config));

        let edges: Vec<CallEdge> = (0..10)
            .map(|i| edge(&format!("n{}", i), &format!("n{}", i + 1)))
            .collect();

        let result = tracer.trace("n0", &edges);

        assert_eq!(result.steps.len(), 4);
        assert_eq!(result.steps[0].symbol_id, "n0");
        assert_eq!(result.steps[1].symbol_id, "n1");
        assert_eq!(result.steps[2].symbol_id, "n2");
        assert_eq!(result.steps[3].symbol_id, "n3");
    }

    #[test]
    fn test_multiple_entries() {
        let tracer = ProcessTracer::new(None);
        let edges = vec![
            edge("a", "b"),
            edge("b", "c"),
            edge("x", "y"),
            edge("y", "z"),
        ];

        let results = tracer.trace_multiple(&["a".to_string(), "x".to_string()], &edges);

        assert_eq!(results.len(), 2);

        assert_eq!(results[0].entry_symbol_id, "a");
        assert_eq!(results[0].steps.len(), 3);
        let ids0: Vec<&str> = results[0].symbol_ids();
        assert!(ids0.contains(&"a"));
        assert!(ids0.contains(&"b"));
        assert!(ids0.contains(&"c"));

        assert_eq!(results[1].entry_symbol_id, "x");
        assert_eq!(results[1].steps.len(), 3);
        let ids1: Vec<&str> = results[1].symbol_ids();
        assert!(ids1.contains(&"x"));
        assert!(ids1.contains(&"y"));
        assert!(ids1.contains(&"z"));
    }

    #[test]
    fn test_performance_5k_nodes_50k_edges() {
        let tracer = ProcessTracer::new(None);

        let num_nodes = 5_000;
        let edges_per_node = 10;
        let mut edges = Vec::with_capacity(num_nodes * edges_per_node);

        for i in 0..num_nodes {
            for j in 1..=edges_per_node {
                let target = (i + j) % num_nodes;
                edges.push(edge(&format!("n{}", i), &format!("n{}", target)));
            }
        }

        assert_eq!(edges.len(), 50_000);

        let start = Instant::now();
        let result = tracer.trace("n0", &edges);
        let elapsed = start.elapsed();

        println!(
            "Performance test: {} steps in {:?}",
            result.steps.len(),
            elapsed
        );

        assert!(
            elapsed.as_millis() < 200,
            "Tracing took {:?}, expected < 200ms",
            elapsed
        );
        assert!(result.steps.len() <= num_nodes);
    }

    #[test]
    fn test_empty_edges() {
        let tracer = ProcessTracer::new(None);
        let result = tracer.trace("a", &[]);

        assert_eq!(result.steps.len(), 1);
        assert_eq!(result.steps[0].symbol_id, "a");
    }

    #[test]
    fn test_disconnected_graph() {
        let tracer = ProcessTracer::new(None);
        let edges = vec![
            edge("a", "b"),
            edge("x", "y"),
        ];

        let result = tracer.trace("a", &edges);

        assert_eq!(result.steps.len(), 2);
        let ids: Vec<&str> = result.symbol_ids();
        assert!(ids.contains(&"a"));
        assert!(ids.contains(&"b"));
        assert!(!ids.contains(&"x"));
        assert!(!ids.contains(&"y"));
    }

    #[test]
    fn test_self_loop() {
        let tracer = ProcessTracer::new(None);
        let edges = vec![
            edge("a", "a"),
        ];

        let result = tracer.trace("a", &edges);

        assert_eq!(result.steps.len(), 1);
        assert_eq!(result.steps[0].symbol_id, "a");
    }

    #[test]
    fn test_default_config() {
        let config = TracerConfig::default();
        assert_eq!(config.max_depth, DEFAULT_MAX_DEPTH);
        assert_eq!(DEFAULT_MAX_DEPTH, 20);
    }
}
