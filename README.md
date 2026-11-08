# Saim Downloader

Paste one or many **direct file URLs** (links that point at the file itself, often ending in `.mp4`, `.pdf`, `.zip`, …), watch them download with live progress, and save them to your device.

Watch/share pages from YouTube, Facebook, Instagram, and similar sites are HTML pages, not file URLs — this app will refuse them instead of saving a broken file that won't open in VLC.

- Per-file progress: bytes, percent, speed, and time left
- Pause/resume (resumes with HTTP Range requests when the server supports them), cancel, retry, remove
- Configurable parallel downloads, optional auto-save on completion
- **Auto** route: the browser streams files directly with `fetch` when the server allows CORS, and falls back to the server proxy (`/api/proxy`) when it doesn't. **Direct** and **Proxy** modes force one route.

## Run locally

Requires Node 20.19+.

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # proxy tests (hit a few real public URLs)
npm run build && npm start   # production build served on :4173, proxy included
```

## Proxy

`api/proxy.js` exports a web-standard `GET(request)` handler; Vite mounts it in dev and preview. It:

- only fetches `http`/`https` URLs on public IP addresses (checked at connect time and on every redirect, so DNS tricks can't reach private networks)
- caps files at 512 MB, times out stalled servers, and rate-limits each client
- serves everything as an `application/octet-stream` attachment with a sandbox CSP, so proxied content never runs on this origin

Downloads are assembled in browser memory before saving, so very large files are limited by available RAM.
