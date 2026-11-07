import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { DownloadManager, parseUrlList } from "./lib/downloadManager.js";
import { formatBytes, formatEta, formatSpeed, hostOf } from "./lib/format.js";
import { Icon } from "./Icon.jsx";

const SETTINGS_KEY = "downloader:settings";

const SAMPLE_URLS = [
  "https://upload.wikimedia.org/wikipedia/commons/4/47/PNG_transparency_demonstration_1.png",
  "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf",
  "https://speed.cloudflare.com/__down?bytes=25000000",
  "https://proof.ovh.net/files/10Mb.dat",
].join("\n");

const MODES = [
  { value: "auto", label: "Auto", hint: "Try direct, fall back to the proxy" },
  { value: "direct", label: "Direct", hint: "Browser only; needs CORS" },
  { value: "proxy", label: "Proxy", hint: "Always route through the server" },
];

const STATUS_LABEL = {
  queued: "Queued",
  connecting: "Connecting",
  downloading: "Downloading",
  paused: "Paused",
  done: "Complete",
  error: "Failed",
  canceled: "Canceled",
};

function loadSettings() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    return {
      mode: MODES.some((m) => m.value === parsed.mode) ? parsed.mode : "auto",
      concurrency: [1, 2, 3, 4, 5, 6].includes(parsed.concurrency) ? parsed.concurrency : 3,
      autoSave: typeof parsed.autoSave === "boolean" ? parsed.autoSave : true,
    };
  } catch {
    return {};
  }
}

const manager = new DownloadManager(loadSettings());

export default function App() {
  const { items, settings } = useSyncExternalStore(manager.subscribe, manager.getSnapshot);
  const [text, setText] = useState("");
  const [invalid, setInvalid] = useState([]);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  const stats = useMemo(() => {
    const active = items.filter((i) => i.status === "downloading" || i.status === "connecting");
    return {
      total: items.length,
      active: active.length,
      done: items.filter((i) => i.status === "done").length,
      failed: items.filter((i) => i.status === "error").length,
      paused: items.filter((i) => i.status === "paused").length,
      pending: items.filter((i) => i.status === "queued").length,
      speed: active.reduce((sum, i) => sum + (i.speed || 0), 0),
      bytes: items.reduce((sum, i) => sum + (i.received || 0), 0),
    };
  }, [items]);

  const lineCount = useMemo(() => text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("#")).length, [text]);

  function handleSubmit(event) {
    event.preventDefault();
    const { valid, invalid: bad } = parseUrlList(text);
    const existing = new Set(
      items.filter((i) => !["done", "canceled", "error"].includes(i.status)).map((i) => i.url),
    );
    const fresh = valid.filter((u) => !existing.has(u));
    const skipped = valid.length - fresh.length;
    setInvalid(bad);
    if (fresh.length) manager.add(fresh);
    if (!valid.length && !bad.length) {
      setNotice({ tone: "warn", text: "Paste at least one file link, one per line." });
      return;
    }
    const parts = [];
    if (fresh.length) parts.push(`Added ${fresh.length} file${fresh.length === 1 ? "" : "s"} to the queue`);
    if (skipped) parts.push(`${skipped} already in the queue`);
    if (parts.length) setNotice({ tone: fresh.length ? "ok" : "warn", text: parts.join(" · ") });
    setText(bad.map((b) => b.value).join("\n"));
  }

  function handleKeyDown(event) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) handleSubmit(event);
  }

  const hasFinished = items.some((i) => ["done", "canceled", "error"].includes(i.status));
  const canPauseAll = stats.active + stats.pending > 0;
  const unsaved = items.filter((i) => i.status === "done" && !i.saved);

  return (
    <div className="shell">
      <header className="top">
        <div className="brand">
          <span className="logo" aria-hidden="true">
            <Icon name="download" />
          </span>
          <div>
            <h1>Downloader</h1>
            <p>Queue file links, watch them stream in, save them to your device.</p>
          </div>
        </div>
        <div className="top-stats" aria-live="polite">
          <Stat label="Speed" value={formatSpeed(stats.speed)} />
          <Stat label="Received" value={formatBytes(stats.bytes)} />
          <Stat label="Done" value={`${stats.done}/${stats.total}`} />
        </div>
      </header>

      <main className="grid">
        <section className="card composer" aria-labelledby="add-title">
          <div className="card-head">
            <h2 id="add-title">Add files</h2>
            <button type="button" className="link-btn" onClick={() => setText(SAMPLE_URLS)}>
              Use sample links
            </button>
          </div>
          <form onSubmit={handleSubmit}>
            <label htmlFor="urls" className="sr-only">
              File URLs, one per line
            </label>
            <textarea
              id="urls"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={"https://example.com/report.pdf\nhttps://example.com/photo.jpg"}
              spellCheck={false}
              rows={6}
              aria-invalid={invalid.length > 0}
              aria-describedby={invalid.length ? "url-errors" : undefined}
            />
            {invalid.length > 0 && (
              <div id="url-errors" className="inline-error" role="alert">
                <Icon name="alert" />
                <div>
                  <strong>
                    {invalid.length} line{invalid.length === 1 ? "" : "s"} skipped
                  </strong>
                  <ul>
                    {invalid.slice(0, 4).map((b) => (
                      <li key={b.line}>
                        Line {b.line}: <code>{b.value.length > 48 ? `${b.value.slice(0, 48)}…` : b.value}</code> — {b.reason}
                      </li>
                    ))}
                    {invalid.length > 4 && <li>…and {invalid.length - 4} more</li>}
                  </ul>
                </div>
              </div>
            )}
            <div className="composer-foot">
              <span className="muted small">
                {lineCount ? `${lineCount} link${lineCount === 1 ? "" : "s"}` : "One link per line"} · Ctrl/⌘ + Enter
              </span>
              <button type="submit" className="btn primary" disabled={!text.trim()}>
                <Icon name="plus" /> Add to queue
              </button>
            </div>
          </form>
        </section>

        <section className="card settings" aria-labelledby="settings-title">
          <h2 id="settings-title">Settings</h2>
          <fieldset className="field">
            <legend>Download route</legend>
            <div className="segmented" role="radiogroup">
              {MODES.map((m) => (
                <button
                  key={m.value}
                  type="button"
                  role="radio"
                  aria-checked={settings.mode === m.value}
                  className={settings.mode === m.value ? "active" : ""}
                  onClick={() => manager.setSettings({ mode: m.value })}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <p className="muted small">{MODES.find((m) => m.value === settings.mode)?.hint}</p>
          </fieldset>
          <div className="field">
            <label htmlFor="concurrency">Parallel downloads</label>
            <div className="range-row">
              <input
                id="concurrency"
                type="range"
                min={1}
                max={6}
                value={settings.concurrency}
                onChange={(e) => manager.setSettings({ concurrency: Number(e.target.value) })}
              />
              <output htmlFor="concurrency">{settings.concurrency}</output>
            </div>
          </div>
          <label className="toggle">
            <input
              type="checkbox"
              checked={settings.autoSave}
              onChange={(e) => manager.setSettings({ autoSave: e.target.checked })}
            />
            <span className="track" aria-hidden="true" />
            <span>Save to device when complete</span>
          </label>
        </section>

        <section className="card queue" aria-labelledby="queue-title">
          <div className="card-head">
            <h2 id="queue-title">
              Queue <span className="count">{items.length}</span>
            </h2>
            <div className="toolbar">
              {unsaved.length > 0 && (
                <button type="button" className="btn ghost" onClick={() => unsaved.forEach((i) => manager.save(i.id))}>
                  <Icon name="save" /> Save all ({unsaved.length})
                </button>
              )}
              {stats.paused > 0 && (
                <button type="button" className="btn ghost" onClick={() => manager.resumeAll()}>
                  <Icon name="play" /> Resume all
                </button>
              )}
              {canPauseAll && (
                <button type="button" className="btn ghost" onClick={() => manager.pauseAll()}>
                  <Icon name="pause" /> Pause all
                </button>
              )}
              {hasFinished && (
                <button type="button" className="btn ghost" onClick={() => manager.clearFinished()}>
                  <Icon name="broom" /> Clear finished
                </button>
              )}
            </div>
          </div>

          {items.length === 0 ? (
            <div className="empty">
              <div className="empty-icon">
                <Icon name="inbox" />
              </div>
              <p>Your queue is empty.</p>
              <p className="muted small">Paste links above, or try the sample links to see it in action.</p>
            </div>
          ) : (
            <ul className="items">
              {items.map((item) => (
                <QueueItem key={item.id} item={item} />
              ))}
            </ul>
          )}
        </section>
      </main>

      <footer className="foot muted small">
        Files are assembled in your browser's memory, then saved with your browser's normal download flow. The proxy
        only fetches public addresses and caps files at 512 MB.
      </footer>

      {notice && (
        <div className={`toast ${notice.tone}`} role="status">
          {notice.text}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
    </div>
  );
}

function QueueItem({ item }) {
  const { status, received, total, speed } = item;
  const percent = total ? Math.min(100, (received / total) * 100) : null;
  const active = status === "downloading" || status === "connecting";
  const indeterminate = active && percent == null;
  const eta = status === "downloading" && total ? formatEta(total - received, speed) : null;

  let detail;
  if (status === "done") detail = `${formatBytes(total)}${item.mime ? ` · ${item.mime}` : ""}`;
  else if (status === "canceled") detail = "Canceled";
  else if (status === "error" && !received) detail = "Nothing downloaded";
  else if (status === "queued") detail = "Waiting for a free slot";
  else if (status === "connecting") detail = received ? `Reconnecting at ${formatBytes(received)}` : "Connecting…";
  else detail = total ? `${formatBytes(received)} of ${formatBytes(total)}` : `${formatBytes(received)} received`;

  return (
    <li className={`item ${status}`}>
      <div className={`file-icon ${status}`} aria-hidden="true">
        <Icon name={status === "done" ? "check" : status === "error" ? "alert" : "file"} />
      </div>
      <div className="item-body">
        <div className="item-top">
          <div className="item-title">
            <span className="name" title={item.name}>
              {item.name}
            </span>
            <span className="host" title={item.url}>
              {hostOf(item.url)}
            </span>
          </div>
          <div className="badges">
            {item.route && (
              <span
                className={`chip route ${item.route}`}
                title={item.route === "proxy" ? "Fetched through the server proxy" : "Fetched directly by your browser"}
              >
                {item.route === "proxy" ? "Proxy" : "Direct"}
              </span>
            )}
            <span className={`chip status ${status}`}>{STATUS_LABEL[status]}</span>
          </div>
        </div>

        <div
          className={`bar ${status}${indeterminate ? " indeterminate" : ""}`}
          role="progressbar"
          aria-label={`${item.name} progress`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent != null ? Math.round(percent) : undefined}
        >
          <span style={{ width: `${status === "done" ? 100 : percent ?? 0}%` }} />
        </div>

        <div className="item-meta">
          <span>{detail}</span>
          {percent != null && status !== "done" && status !== "canceled" && <span>{percent.toFixed(percent < 10 ? 1 : 0)}%</span>}
          {status === "downloading" && <span>{formatSpeed(speed)}</span>}
          {eta && <span className="muted">{eta}</span>}
        </div>

        {status === "error" && (
          <p className="item-error" role="alert">
            {item.error}
          </p>
        )}
      </div>

      <div className="actions">
        {(active || status === "queued") && (
          <IconButton label="Pause" icon="pause" onClick={() => manager.pause(item.id)} />
        )}
        {status === "paused" && <IconButton label="Resume" icon="play" onClick={() => manager.resume(item.id)} />}
        {(status === "error" || status === "canceled") && (
          <IconButton label="Retry" icon="retry" onClick={() => manager.resume(item.id)} />
        )}
        {status === "done" && (
          <IconButton label={item.saved ? "Save again" : "Save to device"} icon="save" primary onClick={() => manager.save(item.id)} />
        )}
        {(active || status === "queued" || status === "paused") && (
          <IconButton label="Cancel" icon="stop" onClick={() => manager.cancel(item.id)} />
        )}
        {!active && <IconButton label="Remove from list" icon="close" onClick={() => manager.remove(item.id)} />}
      </div>
    </li>
  );
}

function IconButton({ label, icon, onClick, primary }) {
  return (
    <button type="button" className={`icon-btn${primary ? " primary" : ""}`} onClick={onClick} title={label} aria-label={label}>
      <Icon name={icon} />
    </button>
  );
}
