import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import JSZip from "jszip";
import {
  DEFAULT_CONFIG,
  type CrawlConfig,
  type CrawlError,
  type CrawledImage,
  type CrawledPage,
  type CrawlJob,
} from "./shared";
import "./popup.css";

interface State {
  jobs: CrawlJob[];
  job?: CrawlJob;
  pages: CrawledPage[];
  images: CrawledImage[];
  errors: CrawlError[];
  pageCount: number;
  imageCount: number;
  errorCount: number;
}
interface ProgressPayload {
  job: CrawlJob;
  pageCount: number;
  imageCount: number;
  errorCount: number;
}
const empty: State = {
  jobs: [],
  pages: [],
  images: [],
  errors: [],
  pageCount: 0,
  imageCount: 0,
  errorCount: 0,
};
const message = <T,>(payload: unknown): Promise<T> =>
  new Promise((resolve, reject) =>
    chrome.runtime.sendMessage(payload, (value) =>
      chrome.runtime.lastError
        ? reject(new Error(chrome.runtime.lastError.message))
        : resolve(value),
    ),
  );

function App() {
  const [state, setState] = useState<State>(empty);
  const [config, setConfig] = useState<CrawlConfig>(DEFAULT_CONFIG);
  const [tab, setTab] = useState<"dashboard" | "new" | "detail">("dashboard");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState(false);
  const refresh = async (id?: string, detail = false) => {
    try {
      setState(await message<State>({ type: "GET_STATE", id, detail }));
    } catch (e) {
      setError(String(e));
    }
  };
  useEffect(() => {
    void refresh(undefined, tab === "detail");
    const listener = (m: { type?: string; payload?: ProgressPayload }) => {
      if (m.type !== "PROGRESS" || !m.payload) return;
      setState((old) =>
        old.job && old.job.id !== m.payload!.job.id
          ? old
          : {
              ...old,
              job: m.payload!.job,
              pageCount: m.payload!.pageCount,
              imageCount: m.payload!.imageCount,
              errorCount: m.payload!.errorCount,
            },
      );
    };
    chrome.runtime.onMessage.addListener(listener);
    const timer = setInterval(
      () =>
        void refresh(
          tab === "detail" ? state.job?.id : undefined,
          tab === "detail",
        ),
      1500,
    );
    return () => {
      clearInterval(timer);
      chrome.runtime.onMessage.removeListener(listener);
    };
  }, [tab, state.job?.id]);
  const update = <K extends keyof CrawlConfig>(key: K, value: CrawlConfig[K]) =>
    setConfig((old) => ({ ...old, [key]: value }));
  const start = async () => {
    setError("");
    try {
      const tabs = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      const startUrl =
        config.mode === "current-page"
          ? tabs[0]?.url || config.startUrl
          : config.startUrl;
      const response = await message<{
        ok: boolean;
        error?: string;
        job?: CrawlJob;
      }>({
        type: "START_CRAWL",
        config: { ...config, startUrl },
        tabId: tabs[0]?.id,
      });
      if (!response.ok) throw new Error(response.error);
      await refresh(response.job?.id, true);
      setTab("detail");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const control = async (action: "pause" | "resume" | "stop") => {
    if (!state.job) return;
    await message({ type: "CONTROL_CRAWL", id: state.job.id, action });
    await refresh(state.job.id, true);
  };
  const exportZip = async () => {
    if (!state.job || exporting) return;
    setError("");
    setExporting(true);
    try {
      const zip = new JSZip();
      const folder = zip.folder("images")!;
      const exported: CrawledImage[] = [];
      for (const image of state.images) {
        try {
          const response = await fetch(image.url);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          folder.file(image.filename, await response.blob());
          exported.push({
            ...image,
            status: "downloaded",
            mimeType: response.headers.get("content-type") || undefined,
          });
        } catch {
          /* keep metadata even if one download fails */
        }
      }
      zip.file("metadata/images.json", JSON.stringify(exported, null, 2));
      zip.file("metadata/pages.json", JSON.stringify(state.pages, null, 2));
      zip.file("metadata/crawl.json", JSON.stringify(state.job, null, 2));
      // Images are already compressed; STORE avoids JSZip allocating extra
      // buffers for deflation and streamFiles keeps individual entries small.
      const blob = await zip.generateAsync({
        type: "blob",
        compression: "STORE",
        streamFiles: true,
      });
      await downloadBlob(blob, `vju-images-${state.job.id}.zip`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(
        /array buffer|allocation|memory/i.test(message)
          ? "Export ZIP thất bại vì tổng dung lượng ảnh quá lớn. Hãy export theo từng đợt hoặc giảm số ảnh trong crawl."
          : `Export ZIP thất bại: ${message}`,
      );
    } finally {
      setExporting(false);
    }
  };
  const downloadOne = async (image: CrawledImage) => {
    const blob = await (await fetch(image.url)).blob();
    downloadBlob(blob, image.filename);
  };
  const visible = useMemo(
    () =>
      state.images.filter((image) =>
        `${image.filename} ${image.url} ${image.alt || ""}`
          .toLowerCase()
          .includes(search.toLowerCase()),
      ),
    [state.images, search],
  );
  return (
    <div className="app">
      <header>
        <div>
          <strong>VJU Image Crawler</strong>
          <small>Chrome extension · MVP</small>
        </div>
        <span className={`status ${state.job?.status || "idle"}`}>
          {state.job?.status || "idle"}
        </span>
      </header>
      {error && <div className="error">{error}</div>}
      <nav>
        <button
          className={tab === "dashboard" ? "active" : ""}
          onClick={() => setTab("dashboard")}
        >
          Dashboard
        </button>
        <button
          className={tab === "new" ? "active" : ""}
          onClick={() => setTab("new")}
        >
          New crawl
        </button>
        {state.job && (
          <button
            className={tab === "detail" ? "active" : ""}
            onClick={() => setTab("detail")}
          >
            Crawl detail
          </button>
        )}
      </nav>
      {tab === "dashboard" && (
        <Dashboard
          state={state}
          open={(id) => {
            const selected = id || state.jobs.at(-1)?.id;
            if (selected)
              void (async () => {
                await refresh(selected, true);
                setTab("detail");
              })();
          }}
        />
      )}
      {tab === "new" && (
        <NewCrawl config={config} update={update} start={start} />
      )}
      {tab === "detail" && state.job && (
        <Detail
          state={state}
          visible={visible}
          search={search}
          setSearch={setSearch}
          control={control}
          exportZip={exportZip}
          exporting={exporting}
          downloadOne={downloadOne}
        />
      )}
    </div>
  );
}

function Dashboard({
  state,
  open,
}: {
  state: State;
  open: (id: string) => void;
}) {
  const total = state.jobs.length;
  const completed = state.jobs.filter(
    (job) => job.status === "completed",
  ).length;
  return (
    <section>
      <div className="stats">
        <Stat label="Total crawls" value={total} />
        <Stat label="Completed" value={completed} />
        <Stat label="Images found" value={state.imageCount} />
        <Stat label="Pages" value={state.pageCount} />
      </div>
      <div className="panel">
        <div className="panel-head">
          <h2>Crawl history</h2>
          <button className="primary" onClick={() => open("")}>
            Open latest
          </button>
        </div>
        {state.jobs.length === 0 ? (
          <p className="muted">Chưa có crawl. Mở New crawl để bắt đầu.</p>
        ) : (
          <div className="history">
            {[...state.jobs].reverse().map((job) => (
              <button
                className="history-row"
                key={job.id}
                onClick={() => open(job.id)}
              >
                <span>
                  <b>{new URL(job.startUrl).hostname}</b>
                  <small>
                    {new Date(job.createdAt).toLocaleString("vi-VN")} ·{" "}
                    {job.mode}
                  </small>
                </span>
                <span className={`status ${job.status}`}>{job.status}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat">
      <small>{label}</small>
      <strong>{value}</strong>
    </div>
  );
}

function NewCrawl({
  config,
  update,
  start,
}: {
  config: CrawlConfig;
  update: <K extends keyof CrawlConfig>(key: K, value: CrawlConfig[K]) => void;
  start: () => void;
}) {
  return (
    <section className="panel form">
      <h2>New crawl</h2>
      <label>
        Start URL
        <input
          value={config.startUrl}
          onChange={(e) => update("startUrl", e.target.value)}
        />
      </label>
      <div className="two">
        <label>
          Mode
          <select
            value={config.mode}
            onChange={(e) =>
              update("mode", e.target.value as CrawlConfig["mode"])
            }
          >
            <option value="current-page">Current page</option>
            <option value="website">Website</option>
            <option value="pattern">URL pattern</option>
          </select>
        </label>
        <label>
          Max pages
          <input
            type="number"
            min="1"
            max="5000"
            value={config.maxPages}
            onChange={(e) => update("maxPages", Number(e.target.value))}
          />
        </label>
      </div>
      {config.mode === "pattern" && (
        <label>
          Pattern
          <input
            value={config.pattern}
            onChange={(e) => update("pattern", e.target.value)}
            placeholder="https://vju.ac.vn/tin-tuc/*"
          />
        </label>
      )}
      <div className="two">
        <label>
          Max depth
          <input
            type="number"
            min="0"
            max="30"
            value={config.maxDepth}
            onChange={(e) => update("maxDepth", Number(e.target.value))}
          />
        </label>
        <label>
          Concurrency
          <select
            value={config.concurrency}
            onChange={(e) => update("concurrency", Number(e.target.value))}
          >
            <option value="1">1</option>
            <option value="2">2</option>
            <option value="3">3</option>
            <option value="5">5</option>
          </select>
        </label>
      </div>
      <div className="two">
        <label>
          Delay
          <select
            value={config.requestDelayMs}
            onChange={(e) => update("requestDelayMs", Number(e.target.value))}
          >
            <option value="0">0 ms</option>
            <option value="250">250 ms</option>
            <option value="500">500 ms</option>
            <option value="1000">1000 ms</option>
            <option value="2000">2000 ms</option>
          </select>
        </label>
        <label>
          Retries
          <input
            type="number"
            min="0"
            max="5"
            value={config.retryCount}
            onChange={(e) => update("retryCount", Number(e.target.value))}
          />
        </label>
      </div>
      <fieldset>
        <legend>Extract</legend>
        <Check
          label="srcset / picture"
          value={config.includeSrcset}
          onChange={(v) => update("includeSrcset", v)}
        />
        <Check
          label="Lazy images"
          value={config.includeLazyImages}
          onChange={(v) => update("includeLazyImages", v)}
        />
        <Check
          label="Background images"
          value={config.includeBackgroundImages}
          onChange={(v) => update("includeBackgroundImages", v)}
        />
        <Check
          label="OG / Twitter meta"
          value={config.includeMetaImages}
          onChange={(v) => update("includeMetaImages", v)}
        />
        <Check
          label="Render dynamic content"
          value={config.renderDynamicContent}
          onChange={(v) => update("renderDynamicContent", v)}
        />
      </fieldset>
      <button className="primary wide" onClick={start}>
        Start crawl
      </button>
    </section>
  );
}
function Check({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="check">
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}

function Detail({
  state,
  visible,
  search,
  setSearch,
  control,
  exportZip,
  exporting,
  downloadOne,
}: {
  state: State;
  visible: CrawledImage[];
  search: string;
  setSearch: (value: string) => void;
  control: (action: "pause" | "resume" | "stop") => void;
  exportZip: () => void;
  exporting: boolean;
  downloadOne: (image: CrawledImage) => void;
}) {
  const done = state.pages.filter((page) => page.status === "completed").length;
  const [limit, setLimit] = useState(60);
  useEffect(() => setLimit(60), [search, visible.length]);
  const running = state.job?.status === "running";
  const displayed = visible.slice(0, limit);
  return (
    <section>
      <div className="progress panel">
        <div className="panel-head">
          <div>
            <h2>Crawl detail</h2>
            <p className="muted">{state.job?.startUrl}</p>
          </div>
          <div className="actions">
            {running ? (
              <button onClick={() => control("pause")}>Pause</button>
            ) : state.job?.status === "paused" ? (
              <button onClick={() => control("resume")}>Resume</button>
            ) : null}
            {!["completed", "stopped", "failed"].includes(
              state.job?.status || "",
            ) && (
              <button className="danger" onClick={() => control("stop")}>
                Stop
              </button>
            )}
            <button className="primary" disabled={exporting} onClick={exportZip}>
              {exporting ? "Đang tạo ZIP…" : "Export ZIP"}
            </button>
          </div>
        </div>
        {exporting && <p className="muted">Đang tải ảnh và nén thành ZIP, vui lòng chờ…</p>}
        <div className="bar">
          <i
            style={{
              width: `${state.job?.maxPages ? Math.min(100, (done / state.job.maxPages) * 100) : 0}%`,
            }}
          />
        </div>
        <div className="stats compact">
          <Stat label="Pages" value={done} />
          <Stat label="Images" value={state.imageCount} />
          <Stat label="Errors" value={state.errorCount} />
        </div>
      </div>
      <div className="panel">
        <div className="panel-head">
          <h2>Images ({visible.length})</h2>
          <input
            className="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search images…"
          />
        </div>
        {displayed.length ? (
          <>
            <div className="grid">
              {displayed.map((image) => (
                <ImageCard
                  key={image.id}
                  image={image}
                  download={() => downloadOne(image)}
                />
              ))}
            </div>
            {displayed.length < visible.length && (
              <button
                className="wide"
                onClick={() => setLimit((value) => value + 60)}
              >
                Load more ({visible.length - displayed.length})
              </button>
            )}
          </>
        ) : (
          <p className="muted">Chưa tìm thấy ảnh.</p>
        )}
      </div>
    </section>
  );
}

function ImageCard({
  image,
  download,
}: {
  image: CrawledImage;
  download: () => void;
}) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    let objectUrl = "";
    let alive = true;
    fetch(image.url)
      .then((response) => response.blob())
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        if (alive) setSrc(objectUrl);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [image.url]);
  const context = image.sourceContexts?.[0];
  return (
    <article className="card">
      <img
        src={src}
        loading="lazy"
        onError={(e) => {
          e.currentTarget.style.opacity = "0.2";
        }}
      />
      <div>
        <b title={image.url}>{image.filename}</b>
        <small>
          {context?.section || "Không xác định section"}
          {context?.selector ? ` · ${context.selector}` : ""}
        </small>
        <small>
          {image.discoveredFrom} · {image.sourcePages.length} page(s)
        </small>
        <button onClick={download}>Download</button>
      </div>
    </article>
  );
}

async function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({ url, filename, saveAs: false });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}

createRoot(document.getElementById("root")!).render(<App />);
