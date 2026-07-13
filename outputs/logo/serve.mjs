import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const types = { ".svg": "image/svg+xml", ".html": "text/html; charset=utf-8" };

createServer(async (req, res) => {
  const rel = req.url === "/" ? "preview.html" : decodeURIComponent(req.url.slice(1));
  const fp = normalize(join(root, rel));
  if (!fp.startsWith(root)) { res.writeHead(403); res.end(); return; }
  try {
    const data = await readFile(fp);
    res.writeHead(200, { "Content-Type": types[extname(fp)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
}).listen(4173, "127.0.0.1");
console.log("logo preview on http://127.0.0.1:4173/");
