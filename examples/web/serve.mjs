#!/usr/bin/env node
// Tiny zero-dependency static server for the web example. Serving over http://localhost
// means the browser sends an Origin the Portico daemon's default CORS already allows.
//
//   node examples/web/serve.mjs        # then open http://localhost:5173

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 5173);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

createServer(async (req, res) => {
  const path = req.url === "/" || !req.url ? "/index.html" : req.url.split("?")[0];
  try {
    const data = await readFile(join(root, path));
    res.writeHead(200, { "Content-Type": TYPES[extname(path)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
}).listen(port, () => {
  console.log(`Web example: http://localhost:${port}`);
  console.log("Make sure the daemon is running: portico start");
});
