const svg = d3.select("#graph");
const rootG = svg.append("g");
const linksG = rootG.append("g");
const nodesG = rootG.append("g");

const state = {
  nodes: [],
  links: [],
  simulation: null,
  maxNodes: 200,
};

const colorByKind = {
  function: "#0d9488",
  method: "#0284c7",
  class: "#2563eb",
  interface: "#0891b2",
  type: "#16a34a",
  module: "#64748b",
  constructor: "#f59e0b",
  variable: "#7c3aed",
};

const edgeColor = {
  call: "#fb923c",
  import: "#60a5fa",
  config: "#c084fc",
};

function setNodeDetails(node) {
  const details = document.getElementById("nodeDetails");
  details.textContent = node
    ? JSON.stringify(node, null, 2)
    : "Select a node";
}

function dedupeGraph(nodes, links) {
  const maxNodes = Number(document.getElementById("maxNodes").value || "200");
  const nodeMap = new Map();
  for (const node of nodes) {
    if (!node || !node.id) continue;
    if (!nodeMap.has(node.id)) {
      nodeMap.set(node.id, node);
    }
    if (nodeMap.size >= maxNodes) break;
  }
  const nodeIds = new Set(nodeMap.keys());
  const edgeMap = new Map();
  for (const link of links) {
    const key = `${link.source}->${link.target}:${link.type}`;
    if (edgeMap.has(key)) continue;
    if (!nodeIds.has(link.source) || !nodeIds.has(link.target)) continue;
    edgeMap.set(key, link);
  }
  return {
    nodes: Array.from(nodeMap.values()),
    links: Array.from(edgeMap.values()),
  };
}

function renderGraph() {
  const graph = dedupeGraph(state.nodes, state.links);
  state.nodes = graph.nodes;
  state.links = graph.links;

  if (state.simulation) {
    state.simulation.stop();
  }

  linksG.selectAll("*").remove();
  nodesG.selectAll("*").remove();

  const link = linksG
    .selectAll("line")
    .data(state.links, (d) => `${d.source}:${d.target}:${d.type}`)
    .join("line")
    .attr("stroke", (d) => edgeColor[d.type] || "#94a3b8")
    .attr("stroke-opacity", 0.65)
    .attr("stroke-width", (d) => Math.max(1, Math.min(4, d.weight || 1)));

  const node = nodesG
    .selectAll("circle")
    .data(state.nodes, (d) => d.id)
    .join("circle")
    .attr("r", (d) => Math.max(5, Math.min(20, d.size || 8)))
    .attr("fill", (d) => colorByKind[d.kind] || "#64748b")
    .attr("stroke", "#ffffff")
    .attr("stroke-width", 1.3)
    .on("click", async (_, d) => {
      setNodeDetails(d);
      await expandNode(d.id);
    });

  node.append("title").text((d) => `${d.label} (${d.kind})`);

  const label = nodesG
    .selectAll("text")
    .data(state.nodes, (d) => `label:${d.id}`)
    .join("text")
    .text((d) => d.label)
    .attr("font-size", 10)
    .attr("fill", "#334155");

  const skipAnimation = state.nodes.length > 100;
  state.simulation = d3
    .forceSimulation(state.nodes)
    .force(
      "link",
      d3
        .forceLink(state.links)
        .id((d) => d.id)
        .distance(skipAnimation ? 65 : 95),
    )
    .force("charge", d3.forceManyBody().strength(skipAnimation ? -80 : -140))
    .force(
      "center",
      d3.forceCenter(
        Number(svg.attr("width")) / 2,
        Number(svg.attr("height")) / 2,
      ),
    )
    .on("tick", () => {
      link
        .attr("x1", (d) => d.source.x)
        .attr("y1", (d) => d.source.y)
        .attr("x2", (d) => d.target.x)
        .attr("y2", (d) => d.target.y);
      node.attr("cx", (d) => d.x).attr("cy", (d) => d.y);
      label.attr("x", (d) => d.x + 8).attr("y", (d) => d.y + 3);
    });

  if (skipAnimation) {
    for (let i = 0; i < 80; i += 1) {
      state.simulation.tick();
    }
    state.simulation.stop();
  }
}

async function requestJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json();
}

async function loadGraph() {
  const repoId = document.getElementById("repoId").value.trim();
  const symbolId = document.getElementById("symbolId").value.trim();
  const maxNodes = document.getElementById("maxNodes").value.trim() || "200";
  state.maxNodes = Number(maxNodes);

  const endpoint = symbolId
    ? `/api/graph/${encodeURIComponent(repoId)}/symbol/${encodeURIComponent(symbolId)}/neighborhood?maxNodes=${encodeURIComponent(maxNodes)}`
    : `/api/graph/${encodeURIComponent(repoId)}/slice/preview?maxNodes=${encodeURIComponent(maxNodes)}`;

  const data = await requestJson(endpoint);
  state.nodes = data.nodes || [];
  state.links = data.links || [];
  renderGraph();
}

async function loadBlastRadius() {
  const repoId = document.getElementById("repoId").value.trim();
  const fromVersion = document.getElementById("fromVersion").value.trim();
  const toVersion = document.getElementById("toVersion").value.trim();
  const maxNodes = document.getElementById("maxNodes").value.trim() || "200";
  if (!fromVersion || !toVersion) return;
  const data = await requestJson(
    `/api/graph/${encodeURIComponent(repoId)}/blast-radius/${encodeURIComponent(fromVersion)}/${encodeURIComponent(toVersion)}?maxNodes=${encodeURIComponent(maxNodes)}`,
  );
  state.nodes = (data.nodes || []).map((node) => ({
    ...node,
    blast: true,
  }));
  state.links = data.links || [];
  renderGraph();
}

async function expandNode(symbolId) {
  const repoId = document.getElementById("repoId").value.trim();
  const maxNodes = document.getElementById("maxNodes").value.trim() || "200";
  const data = await requestJson(
    `/api/graph/${encodeURIComponent(repoId)}/symbol/${encodeURIComponent(symbolId)}/neighborhood?maxNodes=${encodeURIComponent(maxNodes)}`,
  );
  state.nodes = state.nodes.concat(data.nodes || []);
  state.links = state.links.concat(data.links || []);
  renderGraph();
}

function applyFilter() {
  const query = document.getElementById("filter").value.trim().toLowerCase();
  nodesG.selectAll("circle").attr("opacity", (d) => {
    if (!query) return 1;
    return d.label.toLowerCase().includes(query) ? 1 : 0.2;
  });
  nodesG.selectAll("text").attr("opacity", (d) => {
    if (!query) return 1;
    return d.label.toLowerCase().includes(query) ? 1 : 0.15;
  });
}

function exportSvg() {
  const serializer = new XMLSerializer();
  const raw = serializer.serializeToString(svg.node());
  const blob = new Blob([raw], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "sdl-graph.svg";
  a.click();
  URL.revokeObjectURL(url);
}

function exportPng() {
  const serializer = new XMLSerializer();
  const raw = serializer.serializeToString(svg.node());
  const encoded = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(raw)}`;
  const image = new Image();
  image.onload = () => {
    const canvas = document.createElement("canvas");
    canvas.width = Number(svg.attr("width"));
    canvas.height = Number(svg.attr("height"));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0);
    const a = document.createElement("a");
    a.href = canvas.toDataURL("image/png");
    a.download = "sdl-graph.png";
    a.click();
  };
  image.src = encoded;
}

svg.call(
  d3.zoom().scaleExtent([0.2, 4]).on("zoom", (event) => {
    rootG.attr("transform", event.transform);
  }),
);

document.getElementById("loadBtn").addEventListener("click", () => {
  loadGraph().catch((error) => {
    setNodeDetails({ error: String(error) });
  });
});
document.getElementById("blastBtn").addEventListener("click", () => {
  loadBlastRadius().catch((error) => {
    setNodeDetails({ error: String(error) });
  });
});
document.getElementById("filter").addEventListener("input", applyFilter);
document.getElementById("exportSvgBtn").addEventListener("click", exportSvg);
document.getElementById("exportPngBtn").addEventListener("click", exportPng);

loadGraph().catch((error) => {
  setNodeDetails({ error: String(error) });
});
