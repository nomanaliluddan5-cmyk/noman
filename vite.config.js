import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { Readable } from "node:stream";
import { GET as proxyGET } from "./api/proxy.js";

function nodeToWebRequest(req, res) {
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) controller.abort();
  });
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
    else if (value != null) headers.set(key, value);
  }
  headers.set("x-forwarded-for", req.socket.remoteAddress || "local");
  return new Request(`http://${req.headers.host || "localhost"}${req.originalUrl || req.url}`, {
    method: req.method,
    headers,
    signal: controller.signal,
  });
}

async function proxyMiddleware(req, res, next) {
  const path = (req.originalUrl || req.url || "").split("?")[0];
  if (path !== "/api/proxy") return next();
  if (req.method !== "GET") {
    res.writeHead(405, { allow: "GET", "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed." }));
    return;
  }
  try {
    const response = await proxyGET(nodeToWebRequest(req, res));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (!response.body) return res.end();
    const body = Readable.fromWeb(response.body);
    body.on("error", () => res.destroy());
    res.on("close", () => body.destroy());
    body.pipe(res);
  } catch {
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Proxy failure." }));
  }
}

const downloadProxy = () => ({
  name: "download-proxy",
  configureServer(server) {
    server.middlewares.use(proxyMiddleware);
  },
  configurePreviewServer(server) {
    server.middlewares.use(proxyMiddleware);
  },
});

export default defineConfig({
  plugins: [react(), downloadProxy()],
});
