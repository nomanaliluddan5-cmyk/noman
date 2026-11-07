import { test } from "node:test";
import assert from "node:assert/strict";
import { GET, isPublicAddress, validateTarget } from "../api/proxy.js";

const call = (target, headers = {}) =>
  GET(new Request(`http://localhost/api/proxy?url=${encodeURIComponent(target)}`, { headers }));

test("classifies addresses", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "192.168.1.1", "::1", "fe80::1", "::ffff:127.0.0.1", "fd00::1"]) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) {
    assert.equal(isPublicAddress(ip), true, ip);
  }
});

test("rejects unsafe targets before connecting", () => {
  for (const url of ["ftp://example.com/a", "http://127.0.0.1/", "http://[::1]/", "http://localhost/", "http://user:pw@example.com/", "http://example.com:22/"]) {
    assert.throws(() => validateTarget(url), undefined, url);
  }
});

test("blocks hostnames that resolve to private addresses", async () => {
  const res = await call("http://localtest.me/");
  assert.equal(res.status, 403);
});

test("missing url parameter is a 400", async () => {
  const res = await GET(new Request("http://localhost/api/proxy"));
  assert.equal(res.status, 400);
});

test("streams a real public file as an inert attachment", async () => {
  const res = await call("https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/octet-stream");
  assert.match(res.headers.get("content-disposition"), /dummy\.pdf/);
  assert.match(res.headers.get("x-upstream-content-type"), /application\/pdf/);
  const body = new Uint8Array(await res.arrayBuffer());
  assert.equal(body.length, Number(res.headers.get("content-length")));
  assert.equal(new TextDecoder().decode(body.slice(0, 5)), "%PDF-");
});

test("forwards range requests for resuming", async () => {
  const res = await call("https://proof.ovh.net/files/10Mb.dat", { range: "bytes=10485700-" });
  assert.equal(res.status, 206);
  assert.equal((await res.arrayBuffer()).byteLength, 60);
});

test("reports upstream errors clearly", async () => {
  const res = await call("https://www.w3.org/this-file-does-not-exist-12345.bin");
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /404/);
});
