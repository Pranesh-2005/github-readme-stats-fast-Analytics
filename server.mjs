// Local dev server (not deployed). Run: node server.mjs, then open http://127.0.0.1:4317
// Same /api/stats handler as the Vercel function. No DASH_KEY needed locally.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

// ponytail: tiny .env loader instead of a dotenv dependency
const envPath = join(root, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const { handleStats } = await import("./lib/stats.mjs");
const PORT = Number(process.env.PORT) || 4317;

http
  .createServer(async (req, res) => {
    const path = new URL(req.url, "http://localhost").pathname;
    if (process.env.LOG_REQUESTS) console.log(req.method, req.url); // dev: count what the page requests
    if (path === "/api/stats") return handleStats(req, res);
    if (path === "/" || path === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
      return res.end(await readFile(join(root, "index.html")));
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  })
  .listen(PORT, "127.0.0.1", () => console.log(`Analytics on http://127.0.0.1:${PORT}`));
