const ACTIVE = new Set(["connecting", "downloading"]);
const NOTIFY_INTERVAL_MS = 120;
const SPEED_WINDOW_MS = 3000;

let nextId = 1;

export function parseUrlList(text) {
  const valid = [];
  const invalid = [];
  const seen = new Set();
  text.split(/\r?\n/).forEach((line, index) => {
    const raw = line.trim();
    if (!raw || raw.startsWith("#")) return;
    let url;
    try {
      url = new URL(raw);
    } catch {
      invalid.push({ line: index + 1, value: raw, reason: "Not a valid URL" });
      return;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      invalid.push({ line: index + 1, value: raw, reason: "Only http and https links are supported" });
      return;
    }
    if (seen.has(url.href)) return;
    seen.add(url.href);
    valid.push(url.href);
  });
  return { valid, invalid };
}

export function nameFromUrl(href) {
  try {
    const url = new URL(href);
    const last = url.pathname.split("/").filter(Boolean).pop();
    if (last) return decodeURIComponent(last);
    return url.hostname;
  } catch {
    return "download";
  }
}

function filenameFromDisposition(header) {
  if (!header) return null;
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      /* fall through to the plain filename */
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/.exec(header);
  return plain ? plain[1].trim() : null;
}

function sanitizeFilename(name) {
  const clean = (name || "").replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, "_").replace(/^\.+/, "").slice(0, 200);
  return clean || "download";
}

function totalFromResponse(res, offset) {
  const contentRange = res.headers.get("content-range");
  if (res.status === 206 && contentRange) {
    const match = /\/(\d+)\s*$/.exec(contentRange);
    if (match) return Number(match[1]);
  }
  const length = Number(res.headers.get("content-length"));
  if (Number.isFinite(length) && length > 0) return res.status === 206 ? offset + length : length;
  return null;
}

async function readProxyError(res) {
  try {
    const data = await res.json();
    if (data?.error) return data.error;
  } catch {
    /* body was not JSON */
  }
  return `The proxy responded ${res.status}.`;
}

const PAGE_NOT_FILE =
  "This URL returned a web page, not a downloadable file. Paste a direct file link (for example one that ends in .mp4 or .pdf). Sites like YouTube, Facebook, and Instagram don't expose a direct file URL.";

export function isHtmlMime(mime) {
  if (!mime) return false;
  const type = mime.split(";")[0].trim().toLowerCase();
  return type === "text/html" || type === "application/xhtml+xml";
}

export function looksLikeHtml(bytes) {
  if (!bytes?.byteLength) return false;
  const head = new TextDecoder().decode(bytes.slice(0, 512)).replace(/^\uFEFF/, "").trimStart().toLowerCase();
  return (
    head.startsWith("<!doctype html") ||
    head.startsWith("<html") ||
    head.startsWith("<head") ||
    head.startsWith("<body") ||
    head.startsWith("<!--")
  );
}

export class DownloadManager {
  constructor(settings) {
    this.settings = { mode: "auto", concurrency: 3, autoSave: true, ...settings };
    this.items = [];
    this.runtime = new Map();
    this.listeners = new Set();
    this.snapshot = { items: this.items, settings: this.settings };
    this.notifyTimer = null;
  }

  subscribe = (listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;

  emit() {
    this.snapshot = { items: this.items.slice(), settings: { ...this.settings } };
    this.listeners.forEach((l) => l());
  }

  emitSoon() {
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      this.emit();
    }, NOTIFY_INTERVAL_MS);
  }

  update(id, patch) {
    const index = this.items.findIndex((i) => i.id === id);
    if (index === -1) return null;
    this.items[index] = { ...this.items[index], ...patch };
    return this.items[index];
  }

  get(id) {
    return this.items.find((i) => i.id === id);
  }

  setSettings(patch) {
    this.settings = { ...this.settings, ...patch };
    this.emit();
    this.pump();
  }

  add(urls) {
    for (const url of urls) {
      const id = nextId++;
      this.items.push({
        id,
        url,
        name: nameFromUrl(url),
        status: "queued",
        received: 0,
        total: null,
        speed: 0,
        route: null,
        error: null,
        blobUrl: null,
        mime: null,
        addedAt: Date.now(),
        finishedAt: null,
        saved: false,
      });
      this.runtime.set(id, { chunks: [], controller: null, samples: [] });
    }
    this.emit();
    this.pump();
  }

  pump() {
    let active = this.items.filter((i) => ACTIVE.has(i.status)).length;
    for (const item of this.items) {
      if (active >= this.settings.concurrency) break;
      if (item.status === "queued") {
        active++;
        this.update(item.id, { status: "connecting", error: null });
        this.run(item.id);
      }
    }
    this.emit();
  }

  async run(id) {
    const rt = this.runtime.get(id);
    const item = this.get(id);
    if (!rt || !item) return;

    const { mode } = this.settings;
    let route = item.route && item.received > 0 ? item.route : mode === "proxy" ? "proxy" : "direct";

    for (;;) {
      const controller = new AbortController();
      rt.controller = controller;
      const offset = this.get(id).received;
      const headers = offset > 0 ? { Range: `bytes=${offset}-` } : {};
      const target = route === "proxy" ? `/api/proxy?url=${encodeURIComponent(item.url)}` : item.url;
      this.update(id, { route, status: "connecting" });
      this.emitSoon();

      let res;
      try {
        res = await fetch(target, { signal: controller.signal, headers, cache: "no-store", credentials: "omit" });
      } catch (err) {
        if (controller.signal.aborted) return this.handleAbort(id, controller.signal.reason);
        if (route === "direct" && mode === "auto") {
          route = "proxy";
          continue;
        }
        const message =
          route === "direct"
            ? "The browser couldn't fetch this file directly (the server blocks cross-origin downloads, or the network failed). Switch to Auto or Proxy mode."
            : "Couldn't reach the download proxy. Check your connection and try again.";
        return this.fail(id, message);
      }

      if (!res.ok) {
        if (route === "proxy") return this.fail(id, await readProxyError(res));
        if (mode === "auto" && res.status !== 404 && res.status !== 410 && res.status !== 416) {
          route = "proxy";
          continue;
        }
        return this.fail(id, `The server responded ${res.status}${res.statusText ? ` ${res.statusText}` : ""}.`);
      }

      if (offset > 0 && res.status !== 206) {
        rt.chunks = [];
        this.update(id, { received: 0 });
      }
      const startAt = res.status === 206 ? offset : 0;
      const disposition = filenameFromDisposition(res.headers.get("content-disposition"));
      const mime =
        (route === "proxy" ? res.headers.get("x-upstream-content-type") : res.headers.get("content-type")) ||
        "application/octet-stream";
      const normalizedMime = mime.split(";")[0].trim();
      // CORS-open CDNs sometimes return an HTML error/watch page with HTTP 200. In Auto mode
      // that still means "try the proxy"; only fail once the proxy (or Direct/Proxy mode) agrees.
      if (isHtmlMime(normalizedMime)) {
        try {
          res.body?.cancel?.();
        } catch {
          /* ignore cancel failures */
        }
        if (route === "direct" && mode === "auto") {
          route = "proxy";
          continue;
        }
        return this.fail(id, PAGE_NOT_FILE);
      }
      this.update(id, {
        status: "downloading",
        total: totalFromResponse(res, startAt),
        mime: normalizedMime,
        name: sanitizeFilename(disposition || this.get(id).name),
      });
      rt.samples = [{ t: performance.now(), bytes: startAt }];
      this.emit();

      try {
        await this.consume(id, res.body, rt);
      } catch (err) {
        if (controller.signal.aborted) return this.handleAbort(id, controller.signal.reason);
        if (err?.code === "HTML_PAGE") {
          if (route === "direct" && mode === "auto") {
            rt.chunks = [];
            this.update(id, { received: 0, total: null });
            route = "proxy";
            continue;
          }
          return this.fail(id, PAGE_NOT_FILE);
        }
        return this.fail(id, "The connection dropped mid-download. Retry to continue from where it stopped.");
      }
      return this.complete(id);
    }
  }

  async consume(id, body, rt) {
    if (!body) return;
    const reader = body.getReader();
    let inspected = rt.chunks.some((c) => c?.byteLength);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!inspected && value?.byteLength) {
        inspected = true;
        if (looksLikeHtml(value)) {
          try {
            await reader.cancel();
          } catch {
            /* ignore */
          }
          const err = new Error("HTML_PAGE");
          err.code = "HTML_PAGE";
          throw err;
        }
      }
      rt.chunks.push(value);
      const current = this.get(id);
      const received = current.received + value.byteLength;
      const now = performance.now();
      rt.samples.push({ t: now, bytes: received });
      while (rt.samples.length > 2 && now - rt.samples[0].t > SPEED_WINDOW_MS) rt.samples.shift();
      const first = rt.samples[0];
      const elapsed = (now - first.t) / 1000;
      const speed = elapsed > 0.2 ? (received - first.bytes) / elapsed : current.speed;
      const total = current.total != null && received > current.total ? null : current.total;
      this.update(id, { received, speed, total });
      this.emitSoon();
    }
  }

  complete(id) {
    const rt = this.runtime.get(id);
    const item = this.get(id);
    const blob = new Blob(rt.chunks, { type: item.mime || "application/octet-stream" });
    const expected = item.total;
    if (blob.size === 0) {
      rt.chunks = [];
      rt.controller = null;
      return this.fail(id, "The download finished with an empty file. The link may not point at a real file.");
    }
    // Only treat a short body as truncated when Content-Length promised more bytes.
    if (Number.isFinite(expected) && expected > 0 && blob.size < expected) {
      // Keep chunks so Retry can Range-resume from item.received.
      rt.controller = null;
      this.update(id, { received: blob.size, total: expected, speed: 0 });
      return this.fail(
        id,
        `The download stopped early (${blob.size.toLocaleString()} of ${expected.toLocaleString()} bytes). Retry to continue from where it stopped.`,
      );
    }
    rt.chunks = [];
    rt.controller = null;
    this.update(id, {
      status: "done",
      blobUrl: URL.createObjectURL(blob),
      total: blob.size,
      received: blob.size,
      speed: 0,
      finishedAt: Date.now(),
    });
    if (this.settings.autoSave) this.save(id);
    this.emit();
    this.pump();
  }

  fail(id, message) {
    const rt = this.runtime.get(id);
    if (rt) rt.controller = null;
    this.update(id, { status: "error", error: message, speed: 0 });
    this.emit();
    this.pump();
  }

  handleAbort(id, reason) {
    const rt = this.runtime.get(id);
    if (rt) rt.controller = null;
    if (reason === "pause") {
      this.update(id, { status: "paused", speed: 0 });
    } else {
      if (rt) rt.chunks = [];
      this.update(id, { status: "canceled", speed: 0, received: 0, total: null });
    }
    this.emit();
    this.pump();
  }

  pause(id) {
    const item = this.get(id);
    if (!item) return;
    if (item.status === "queued") {
      this.update(id, { status: "paused" });
      this.emit();
    } else if (ACTIVE.has(item.status)) {
      this.runtime.get(id)?.controller?.abort("pause");
    }
  }

  resume(id) {
    const item = this.get(id);
    if (!item || !["paused", "error", "canceled"].includes(item.status)) return;
    this.update(id, { status: "queued", error: null });
    this.pump();
  }

  cancel(id) {
    const item = this.get(id);
    if (!item) return;
    const rt = this.runtime.get(id);
    if (ACTIVE.has(item.status)) {
      rt?.controller?.abort("cancel");
    } else if (item.status === "queued" || item.status === "paused") {
      if (rt) rt.chunks = [];
      this.update(id, { status: "canceled", received: 0, total: null, speed: 0 });
      this.emit();
    }
  }

  remove(id) {
    const item = this.get(id);
    if (!item) return;
    this.runtime.get(id)?.controller?.abort("cancel");
    if (item.blobUrl) URL.revokeObjectURL(item.blobUrl);
    this.runtime.delete(id);
    this.items = this.items.filter((i) => i.id !== id);
    this.emit();
    this.pump();
  }

  save(id) {
    const item = this.get(id);
    if (!item?.blobUrl) return;
    const a = document.createElement("a");
    a.href = item.blobUrl;
    a.download = item.name;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    this.update(id, { saved: true });
    this.emit();
  }

  pauseAll() {
    this.items.forEach((i) => (i.status === "queued" || ACTIVE.has(i.status)) && this.pause(i.id));
    this.emit();
  }

  resumeAll() {
    this.items.forEach((i) => i.status === "paused" && this.update(i.id, { status: "queued" }));
    this.pump();
  }

  clearFinished() {
    this.items
      .filter((i) => ["done", "canceled", "error"].includes(i.status))
      .forEach((i) => this.remove(i.id));
  }
}
