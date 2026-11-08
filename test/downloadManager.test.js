import { test } from "node:test";
import assert from "node:assert/strict";
import { DownloadManager, isHtmlMime, looksLikeHtml, parseUrlList } from "../src/lib/downloadManager.js";

test("parseUrlList keeps http(s) links and skips junk", () => {
  const { valid, invalid } = parseUrlList("https://a.test/x.mp4\nnot-a-url\nftp://a.test/y\nhttps://a.test/x.mp4\n");
  assert.deepEqual(valid, ["https://a.test/x.mp4"]);
  assert.equal(invalid.length, 2);
});

test("isHtmlMime detects page responses", () => {
  assert.equal(isHtmlMime("text/html; charset=utf-8"), true);
  assert.equal(isHtmlMime("application/xhtml+xml"), true);
  assert.equal(isHtmlMime("video/mp4"), false);
  assert.equal(isHtmlMime("application/octet-stream"), false);
});

test("looksLikeHtml sniffs page bodies even when the type lies", () => {
  assert.equal(looksLikeHtml(new TextEncoder().encode("<!DOCTYPE html><html>")), true);
  assert.equal(looksLikeHtml(new TextEncoder().encode("  <html lang=en>")), true);
  assert.equal(looksLikeHtml(new TextEncoder().encode("\uFEFF<head></head>")), true);
  assert.equal(looksLikeHtml(new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70])), false);
});

function mockFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => {
    globalThis.fetch = original;
  };
}

function responseFrom({ status = 200, body, headers = {} }) {
  return new Response(body, { status, headers });
}

test("refuses HTML watch/error pages instead of saving them as the file", async () => {
  const restore = mockFetch(async () =>
    responseFrom({
      body: "<!DOCTYPE html><html><body>watch</body></html>",
      headers: { "content-type": "text/html; charset=utf-8", "content-length": "42" },
    }),
  );
  try {
    const mgr = new DownloadManager({ mode: "direct", autoSave: false, concurrency: 1 });
    const done = new Promise((resolve) => {
      mgr.subscribe(() => {
        const item = mgr.items[0];
        if (item?.status === "error" || item?.status === "done") resolve(item);
      });
    });
    mgr.add(["https://video.example/watch?v=1"]);
    const item = await done;
    assert.equal(item.status, "error");
    assert.match(item.error, /web page, not a downloadable file/i);
    assert.equal(item.blobUrl, null);
  } finally {
    restore();
  }
});

test("auto mode falls back to proxy when direct returns an HTML error page", async () => {
  let calls = 0;
  const bytes = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);
  const restore = mockFetch(async (input) => {
    calls += 1;
    const url = String(input);
    if (url.includes("/api/proxy")) {
      return responseFrom({
        body: bytes,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(bytes.byteLength),
          "x-upstream-content-type": "video/mp4",
          "content-disposition": "attachment; filename*=UTF-8''clip.mp4",
        },
      });
    }
    return responseFrom({
      body: "<html><body>hotlink blocked</body></html>",
      headers: { "content-type": "text/html", "content-length": "40" },
    });
  });
  try {
    const mgr = new DownloadManager({ mode: "auto", autoSave: false, concurrency: 1 });
    const done = new Promise((resolve) => {
      mgr.subscribe(() => {
        const item = mgr.items[0];
        if (item?.status === "error" || item?.status === "done") resolve(item);
      });
    });
    mgr.add(["https://cdn.example/clip.mp4"]);
    const item = await done;
    assert.equal(item.status, "done");
    assert.equal(item.route, "proxy");
    assert.equal(calls, 2);
  } finally {
    restore();
  }
});

test("sniffs HTML when content-type is wrong", async () => {
  const restore = mockFetch(async () =>
    responseFrom({
      body: "<html><body>blocked</body></html>",
      headers: { "content-type": "application/octet-stream", "content-length": "33" },
    }),
  );
  try {
    const mgr = new DownloadManager({ mode: "direct", autoSave: false, concurrency: 1 });
    const done = new Promise((resolve) => {
      mgr.subscribe(() => {
        const item = mgr.items[0];
        if (item?.status === "error" || item?.status === "done") resolve(item);
      });
    });
    mgr.add(["https://cdn.example/clip.mp4"]);
    const item = await done;
    assert.equal(item.status, "error");
    assert.match(item.error, /web page, not a downloadable file/i);
  } finally {
    restore();
  }
});

test("marks short bodies as incomplete instead of complete", async () => {
  const restore = mockFetch(async () =>
    responseFrom({
      body: "partial",
      headers: { "content-type": "video/mp4", "content-length": "1000" },
    }),
  );
  try {
    const mgr = new DownloadManager({ mode: "direct", autoSave: false, concurrency: 1 });
    const done = new Promise((resolve) => {
      mgr.subscribe(() => {
        const item = mgr.items[0];
        if (item?.status === "error" || item?.status === "done") resolve(item);
      });
    });
    mgr.add(["https://cdn.example/movie.mp4"]);
    const item = await done;
    assert.equal(item.status, "error");
    assert.match(item.error, /stopped early/i);
    assert.equal(item.received, 7);
  } finally {
    restore();
  }
});

test("saves a real binary body as done", async () => {
  const bytes = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  const restore = mockFetch(async () =>
    responseFrom({
      body: bytes,
      headers: { "content-type": "video/mp4", "content-length": String(bytes.byteLength) },
    }),
  );
  try {
    const mgr = new DownloadManager({ mode: "direct", autoSave: false, concurrency: 1 });
    const done = new Promise((resolve) => {
      mgr.subscribe(() => {
        const item = mgr.items[0];
        if (item?.status === "error" || item?.status === "done") resolve(item);
      });
    });
    mgr.add(["https://cdn.example/ok.mp4"]);
    const item = await done;
    assert.equal(item.status, "done");
    assert.equal(item.received, bytes.byteLength);
    assert.ok(item.blobUrl);
  } finally {
    restore();
  }
});
