import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import net from "node:net";
import { Readable, Transform } from "node:stream";

const MAX_BYTES = 512 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const RESPONSE_TIMEOUT_MS = 20_000;
const IDLE_TIMEOUT_MS = 30_000;
const ALLOWED_PORTS = new Set(["", "80", "443", "8080", "8443"]);
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_PER_CLIENT = 60;
const MAX_CONCURRENT_PER_CLIENT = 6;

const blocked = new net.BlockList();
for (const [addr, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
]) {
  blocked.addSubnet(addr, prefix, "ipv4");
}
for (const [addr, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
]) {
  blocked.addSubnet(addr, prefix, "ipv6");
}

export function isPublicAddress(ip) {
  const family = net.isIP(ip);
  if (family === 4) return !blocked.check(ip, "ipv4");
  if (family === 6) {
    const mapped = /^(?:0{0,4}:){0,5}:?ffff:(.+)$/i.exec(ip);
    if (mapped) return net.isIPv4(mapped[1]) && isPublicAddress(mapped[1]);
    return !blocked.check(ip, "ipv6");
  }
  return false;
}

class ProxyError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Validates every resolved address at connect time, so a hostname cannot pass
// a pre-check and then resolve to an internal address for the real connection.
function safeLookup(hostname, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  const opts = typeof options === "number" ? { family: options } : options || {};
  dns.lookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) return callback(err);
    if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address))) {
      const e = new Error("Destination resolves to a non-public address");
      e.code = "EBLOCKEDADDR";
      return callback(e);
    }
    if (opts.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

export function validateTarget(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ProxyError(400, "That doesn't look like a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ProxyError(400, "Only http:// and https:// URLs can be downloaded.");
  }
  if (url.username || url.password) {
    throw new ProxyError(400, "URLs with embedded credentials are not supported.");
  }
  if (!ALLOWED_PORTS.has(url.port)) {
    throw new ProxyError(400, `Port ${url.port} is not allowed through the proxy.`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) && !isPublicAddress(host)) {
    throw new ProxyError(403, "Private and local network addresses can't be fetched.");
  }
  if (/^localhost$|\.localhost$|\.local$|\.internal$/i.test(host)) {
    throw new ProxyError(403, "Private and local network addresses can't be fetched.");
  }
  url.hash = "";
  return url;
}

function requestOnce(url, range, signal) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === "https:" ? https : http;
    const headers = {
      "user-agent": "SaimDownloader/1.0 (+proxy)",
      accept: "*/*",
      "accept-encoding": "identity",
    };
    if (range) headers.range = range;
    const req = lib.request(
      url,
      { method: "GET", headers, lookup: safeLookup, signal, agent: false },
      (res) => {
        clearTimeout(timer);
        res.setTimeout(IDLE_TIMEOUT_MS, () =>
          res.destroy(new ProxyError(504, "The remote server stopped sending data.")),
        );
        resolve(res);
      },
    );
    const timer = setTimeout(
      () => req.destroy(new ProxyError(504, "The remote server took too long to respond.")),
      RESPONSE_TIMEOUT_MS,
    );
    req.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.end();
  });
}

function describeNetworkError(err) {
  if (err instanceof ProxyError) return err;
  if (err?.code === "EBLOCKEDADDR") {
    return new ProxyError(403, "Private and local network addresses can't be fetched.");
  }
  if (err?.code === "ENOTFOUND" || err?.code === "EAI_AGAIN") {
    return new ProxyError(502, "The file's host name could not be found.");
  }
  if (err?.code === "ECONNREFUSED") return new ProxyError(502, "The remote server refused the connection.");
  if (err?.code === "ECONNRESET") return new ProxyError(502, "The remote server closed the connection.");
  if (err?.code?.startsWith?.("ERR_TLS") || err?.code?.includes?.("CERT")) {
    return new ProxyError(502, "The remote server's TLS certificate could not be verified.");
  }
  return new ProxyError(502, "Could not reach the remote server.");
}

function filenameFrom(url, disposition) {
  let name = "";
  if (disposition) {
    const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(disposition);
    const plain = /filename\s*=\s*"?([^";]+)"?/.exec(disposition);
    try {
      name = star ? decodeURIComponent(star[1].trim()) : plain ? plain[1].trim() : "";
    } catch {
      name = plain ? plain[1].trim() : "";
    }
  }
  if (!name) {
    const last = url.pathname.split("/").filter(Boolean).pop() || "";
    try {
      name = decodeURIComponent(last);
    } catch {
      name = last;
    }
  }
  name = name.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, "_").replace(/^\.+/, "").slice(0, 200);
  return name || url.hostname || "download";
}

const clients = new Map();

function clientKey(request) {
  const fwd = request.headers.get("x-forwarded-for");
  return (fwd ? fwd.split(",")[0].trim() : request.headers.get("x-real-ip")) || "anonymous";
}

function acquireSlot(key) {
  const now = Date.now();
  if (clients.size > 5000) {
    for (const [k, v] of clients) if (now - v.windowStart > RATE_WINDOW_MS && v.active === 0) clients.delete(k);
  }
  let entry = clients.get(key);
  if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
    entry = { windowStart: now, count: 0, active: entry?.active ?? 0 };
    clients.set(key, entry);
  }
  if (entry.count >= RATE_MAX_PER_CLIENT) {
    throw new ProxyError(429, "Too many proxy requests. Wait a minute and try again.");
  }
  if (entry.active >= MAX_CONCURRENT_PER_CLIENT) {
    throw new ProxyError(429, "Too many simultaneous proxied downloads. Lower the parallel downloads setting.");
  }
  entry.count += 1;
  entry.active += 1;
  let released = false;
  return () => {
    if (!released) {
      released = true;
      entry.active = Math.max(0, entry.active - 1);
    }
  };
}

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

export async function GET(request) {
  const params = new URL(request.url).searchParams;
  const rawTarget = params.get("url");
  if (!rawTarget) return jsonError(400, "Missing the url parameter.");

  const rawRange = request.headers.get("range");
  const range = rawRange && /^bytes=\d{1,15}-\d{0,15}$/.test(rawRange) ? rawRange : null;

  let release;
  try {
    release = acquireSlot(clientKey(request));
  } catch (err) {
    return jsonError(err.status, err.message);
  }

  const upstreamAbort = new AbortController();
  const onClientAbort = () => upstreamAbort.abort();
  request.signal?.addEventListener?.("abort", onClientAbort, { once: true });

  let res;
  let url;
  try {
    url = validateTarget(rawTarget);
    for (let hop = 0; ; hop++) {
      res = await requestOnce(url, range, upstreamAbort.signal);
      const location = res.headers.location;
      if (res.statusCode >= 300 && res.statusCode < 400 && location) {
        res.resume();
        if (hop >= MAX_REDIRECTS) throw new ProxyError(508, "The file redirected too many times.");
        url = validateTarget(new URL(location, url).toString());
        continue;
      }
      break;
    }
  } catch (err) {
    release();
    res?.destroy();
    if (upstreamAbort.signal.aborted) return jsonError(499, "Request canceled.");
    const e = describeNetworkError(err);
    return jsonError(e.status, e.message);
  }

  const status = res.statusCode;
  if (status !== 200 && status !== 206) {
    res.resume();
    release();
    const reason = res.statusMessage ? ` ${res.statusMessage}` : "";
    const hint = status === 416 ? "The requested range is not available." : `The remote server responded ${status}${reason}.`;
    const out = jsonError(status === 416 ? 416 : 502, hint);
    out.headers.set("x-upstream-status", String(status));
    return out;
  }

  const contentLength = Number(res.headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > MAX_BYTES) {
    res.destroy();
    release();
    return jsonError(413, `This file is larger than the proxy's ${MAX_BYTES / 1024 / 1024} MB limit.`);
  }

  let seen = 0;
  const limiter = new Transform({
    transform(chunk, _enc, cb) {
      seen += chunk.length;
      if (seen > MAX_BYTES) return cb(new Error("Proxy size limit exceeded"));
      cb(null, chunk);
    },
  });
  const cleanup = () => {
    release();
    request.signal?.removeEventListener?.("abort", onClientAbort);
  };
  limiter.on("close", cleanup);
  limiter.on("error", () => res.destroy());
  res.on("error", (err) => limiter.destroy(err));
  res.pipe(limiter);

  const name = filenameFrom(url, res.headers["content-disposition"]);
  const headers = new Headers({
    // Served as an inert attachment so proxied HTML or scripts never execute on this origin.
    "content-type": "application/octet-stream",
    "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "cache-control": "no-store",
    "x-upstream-content-type": String(res.headers["content-type"] || "application/octet-stream").slice(0, 200),
    "x-final-url": url.toString().slice(0, 2000),
  });
  if (Number.isFinite(contentLength)) headers.set("content-length", String(contentLength));
  if (res.headers["content-range"]) headers.set("content-range", String(res.headers["content-range"]));
  if (res.headers["accept-ranges"]) headers.set("accept-ranges", String(res.headers["accept-ranges"]));

  return new Response(Readable.toWeb(limiter), { status, headers });
}
