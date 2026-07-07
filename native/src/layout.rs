use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;

pub const LAYOUT_SCHEMA_VERSION: u32 = 1;
const EPSILON: f64 = 1e-9;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LayoutNode {
    id: String,
    size: f64,
}

#[derive(Clone, Deserialize)]
struct LayoutEdge {
    from: String,
    to: String,
    weight: f64,
}

#[derive(Clone, Copy, Deserialize)]
struct Point {
    x: f64,
    y: f64,
    z: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LayoutInput {
    nodes: Vec<LayoutNode>,
    edges: Vec<LayoutEdge>,
    initial_positions: Option<HashMap<String, Point>>,
}

#[derive(Clone, Copy)]
struct MutablePoint {
    x: f64,
    y: f64,
    z: f64,
}

pub fn fnv1a32(input: &str) -> u32 {
    let mut hash = 0x811c9dc5u32;
    for unit in input.encode_utf16() {
        hash ^= unit as u32;
        hash = hash.wrapping_mul(0x01000193);
    }
    hash
}

pub struct Mulberry32 {
    value: u32,
}

impl Mulberry32 {
    pub fn new(seed: u32) -> Self {
        Self { value: seed }
    }

    pub fn next(&mut self) -> f64 {
        self.value = self.value.wrapping_add(0x6d2b79f5);
        let mut t = self.value;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        ((t ^ (t >> 14)) as f64) / 4_294_967_296.0
    }
}

fn hash_layout_input(nodes: &[LayoutNode], edges: &[LayoutEdge]) -> String {
    let mut hash = Sha256::new();
    for node in nodes {
        hash.update(format!("n\0{}\0{}\n", node.id, format_js_number(node.size)));
    }
    for edge in edges {
        hash.update(format!("e\0{}\0{}\0{}\n", edge.from, edge.to, format_js_number(edge.weight)));
    }
    hex::encode(hash.finalize())
}

fn initial_point(rand: &mut Mulberry32, width: f64) -> MutablePoint {
    let u = rand.next();
    let v = rand.next();
    let theta = 2.0 * std::f64::consts::PI * u;
    let phi = (2.0 * v - 1.0).acos();
    let radius = width * (0.25 + rand.next() * 0.25);
    MutablePoint {
        x: radius * phi.sin() * theta.cos(),
        y: radius * phi.cos(),
        z: radius * phi.sin() * theta.sin(),
    }
}

fn round6(value: f64) -> f64 {
    let rounded = ((value * 1_000_000.0) + 0.5).floor() / 1_000_000.0;
    if rounded == 0.0 { 0.0 } else { rounded }
}

fn format_js_number(value: f64) -> String {
    if !value.is_finite() {
        return "0".to_string();
    }
    let normalized = if value == 0.0 { 0.0 } else { value };
    if normalized.fract() == 0.0 {
        format!("{:.0}", normalized)
    } else {
        serde_json::to_string(&normalized).unwrap_or_else(|_| "0".to_string())
    }
}

pub fn compute_layout_json(input_json: &str, seed: u32, iterations: u32) -> napi::Result<String> {
    let input: LayoutInput = serde_json::from_str(input_json)
        .map_err(|error| napi::Error::from_reason(format!("invalid layout input: {error}")))?;
    let mut nodes = input.nodes;
    nodes.sort_by(|a, b| a.id.cmp(&b.id));
    let mut edges = input.edges;
    edges.sort_by(|a, b| a.from.cmp(&b.from).then_with(|| a.to.cmp(&b.to)).then_with(|| a.weight.total_cmp(&b.weight)));

    let input_hash = hash_layout_input(&nodes, &edges);
    let width = 100.0_f64.max((nodes.len().max(1) as f64).sqrt() * 100.0);
    let area = width * width;
    let k = (area / nodes.len().max(1) as f64).sqrt();
    let mut rand = Mulberry32::new(seed);
    let initial_positions = input.initial_positions.unwrap_or_default();

    // Index-based hot loop mirroring src/graph/layout/force-layout.ts:
    // identical float op order, O(1) slot lookups instead of string maps.
    let count = nodes.len();
    let mut index_by_id: HashMap<&str, usize> = HashMap::with_capacity(count);
    for (i, node) in nodes.iter().enumerate() {
        index_by_id.insert(node.id.as_str(), i);
    }
    let mut px = vec![0.0f64; count];
    let mut py = vec![0.0f64; count];
    let mut pz = vec![0.0f64; count];
    for (i, node) in nodes.iter().enumerate() {
        let point = initial_positions
            .get(&node.id)
            .map(|p| MutablePoint { x: p.x, y: p.y, z: p.z })
            .unwrap_or_else(|| initial_point(&mut rand, width));
        px[i] = point.x;
        py[i] = point.y;
        pz[i] = point.z;
    }
    let edge_count = edges.len();
    let mut edge_from = vec![-1i64; edge_count];
    let mut edge_to = vec![-1i64; edge_count];
    let mut edge_weight = vec![0.0f64; edge_count];
    for (e, edge) in edges.iter().enumerate() {
        edge_from[e] = index_by_id.get(edge.from.as_str()).map(|&i| i as i64).unwrap_or(-1);
        edge_to[e] = index_by_id.get(edge.to.as_str()).map(|&i| i as i64).unwrap_or(-1);
        edge_weight[e] = edge.weight;
    }
    let mut disp_x = vec![0.0f64; count];
    let mut disp_y = vec![0.0f64; count];
    let mut disp_z = vec![0.0f64; count];

    let mut temp = width / 10.0;
    for _ in 0..iterations {
        disp_x.fill(0.0);
        disp_y.fill(0.0);
        disp_z.fill(0.0);

        for i in 0..count {
            for j in (i + 1)..count {
                let dx = px[i] - px[j];
                let dy = py[i] - py[j];
                let dz = pz[i] - pz[j];
                let dist = (dx * dx + dy * dy + dz * dz).sqrt().max(EPSILON);
                let force = (k * k) / dist;
                let fx = (dx / dist) * force;
                let fy = (dy / dist) * force;
                let fz = (dz / dist) * force;
                disp_x[i] += fx;
                disp_y[i] += fy;
                disp_z[i] += fz;
                disp_x[j] -= fx;
                disp_y[j] -= fy;
                disp_z[j] -= fz;
            }
        }

        for e in 0..edge_count {
            let from = edge_from[e];
            let to = edge_to[e];
            if from < 0 || to < 0 {
                continue;
            }
            let from = from as usize;
            let to = to as usize;
            let dx = px[from] - px[to];
            let dy = py[from] - py[to];
            let dz = pz[from] - pz[to];
            let dist = (dx * dx + dy * dy + dz * dz).sqrt().max(EPSILON);
            let force = ((dist * dist) / k) * edge_weight[e].max(0.1);
            let fx = (dx / dist) * force;
            let fy = (dy / dist) * force;
            let fz = (dz / dist) * force;
            disp_x[from] -= fx;
            disp_y[from] -= fy;
            disp_z[from] -= fz;
            disp_x[to] += fx;
            disp_y[to] += fy;
            disp_z[to] += fz;
        }

        for i in 0..count {
            let len = (disp_x[i] * disp_x[i] + disp_y[i] * disp_y[i] + disp_z[i] * disp_z[i])
                .sqrt()
                .max(EPSILON);
            px[i] += (disp_x[i] / len) * len.min(temp);
            py[i] += (disp_y[i] / len) * len.min(temp);
            pz[i] += (disp_z[i] / len) * len.min(temp);
        }
        temp *= 0.95;
    }

    let mut out = String::new();
    out.push_str(r#"{"layoutSchemaVersion":"#);
    out.push_str(&LAYOUT_SCHEMA_VERSION.to_string());
    out.push_str(r#","seed":"#);
    out.push_str(&seed.to_string());
    out.push_str(r#","iterations":"#);
    out.push_str(&iterations.to_string());
    out.push_str(r#","inputHash":"#);
    out.push_str(&serde_json::to_string(&input_hash).unwrap());
    out.push_str(r#","positions":["#);
    for (index, node) in nodes.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        out.push_str(r#"{"id":"#);
        out.push_str(&serde_json::to_string(&node.id).unwrap());
        out.push_str(r#","x":"#);
        out.push_str(&format_js_number(round6(px[index])));
        out.push_str(r#","y":"#);
        out.push_str(&format_js_number(round6(py[index])));
        out.push_str(r#","z":"#);
        out.push_str(&format_js_number(round6(pz[index])));
        out.push('}');
    }
    out.push_str("]}");
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::{fnv1a32, Mulberry32};

    #[test]
    fn fnv1a32_matches_typescript_vectors() {
        assert_eq!(fnv1a32(""), 2166136261);
        assert_eq!(fnv1a32("sdl-mcp"), 210320563);
        assert_eq!(fnv1a32("unicode-🚀"), 1117605722);
    }

    #[test]
    fn mulberry32_matches_typescript_vectors() {
        let mut rng = Mulberry32::new(123456789);
        let values = [rng.next(), rng.next(), rng.next()];
        assert!((values[0] - 0.2577907438389957).abs() < f64::EPSILON);
        assert!((values[1] - 0.9707721115555614).abs() < f64::EPSILON);
        assert!((values[2] - 0.7853280142880976).abs() < f64::EPSILON);
    }
}
