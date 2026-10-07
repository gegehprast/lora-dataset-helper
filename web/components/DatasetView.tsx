import { useCallback, useEffect, useMemo, useState } from "react";
import type { Framing, ImageRecord, ImageStatus, JobKind, JobState, Override, Settings } from "../../src/types";
import { api, type DatasetData } from "../api";
import { ImageDetail } from "./ImageDetail";
import { ImageGrid } from "./ImageGrid";
import { SettingsPanel } from "./SettingsPanel";

type Filter = ImageStatus | "all";
const FILTERS: { id: Filter; label: string }[] = [
  { id: "selected", label: "Selected" },
  { id: "reserve", label: "Reserve" },
  { id: "rejected", label: "Rejected" },
  { id: "pending", label: "Not analyzed" },
  { id: "all", label: "All" },
];

export function DatasetView({ name }: { name: string }) {
  const [data, setData] = useState<DatasetData | null>(null);
  const [job, setJob] = useState<JobState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("selected");
  const [sort, setSort] = useState<"score" | "name">("score");
  const [openId, setOpenId] = useState<number | null>(null);
  const [showSettings, setShowSettings] = useState(true);

  const apply = useCallback((d: DatasetData) => {
    setData(d);
    setJob(d.job);
  }, []);

  const reload = useCallback(() => api.dataset(name).then(apply, (e) => setError(e.message)), [name, apply]);
  useEffect(() => {
    reload();
  }, [reload]);

  // Poll the running job; reload the dataset when it finishes.
  useEffect(() => {
    if (!job?.running) return;
    const t = setInterval(async () => {
      const j = await api.job(name).catch(() => null);
      setJob(j);
      if (!j?.running) reload();
    }, 700);
    return () => clearInterval(t);
  }, [job?.running, name, reload]);

  const run = async (kind: JobKind, body?: object) => {
    setError(null);
    try {
      setJob(await api.startJob(name, kind, body));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const guarded = (p: Promise<DatasetData>) => p.then(apply, (e) => setError(e.message));
  const onOverride = (id: number, o: Override) => guarded(api.setOverride(id, o));
  const onSettings = (patch: Partial<Settings>) => guarded(api.saveSettings(name, patch));

  const images = data?.images ?? [];
  const counts = useMemo(() => {
    const c: Record<Filter, number> = { selected: 0, reserve: 0, rejected: 0, pending: 0, all: images.length };
    for (const im of images) c[im.status]++;
    return c;
  }, [images]);

  const visible = useMemo(() => {
    const list = filter === "all" ? images : images.filter((im) => im.status === filter);
    return [...list].sort((a, b) =>
      sort === "score" ? (b.score ?? -1) - (a.score ?? -1) : a.relPath.localeCompare(b.relPath),
    );
  }, [images, filter, sort]);

  if (!data) return <main className="page">{error ? <div className="banner error">{error}</div> : "Loading…"}</main>;

  const busy = !!job?.running;
  const s = data.settings;
  const selected = images.filter((im) => im.status === "selected");
  const analyzed = images.filter((im) => im.status !== "pending").length;
  const tagged = images.filter((im) => im.tags).length;
  const captioned = selected.filter((im) => im.caption?.trim()).length;
  const openImage = images.find((im) => im.id === openId);
  const openIndex = visible.findIndex((im) => im.id === openId);

  return (
    <div className={`dataset-layout ${showSettings ? "" : "settings-hidden"}`}>
      <main className="dataset-main">
        {s.localOnly && (
          <div className="banner local">
            🔒 <b>Local only</b>: this dataset's images are never sent to Venice. AI review and captioning are off; you can still write captions by hand.
          </div>
        )}
        <section className="pipeline">
          <Step n={1} title="Analyze locally" detail={`${analyzed}/${images.length || "?"} analyzed`}>
            <button disabled={busy} onClick={() => run("analyze")}>
              Scan &amp; analyze
            </button>
          </Step>
          <Step n={2} title="AI review" detail={s.localOnly ? "Off: dataset is Local only" : `${tagged} reviewed by ${s.tagModel}`}>
            <button disabled={busy || !analyzed || s.localOnly} onClick={() => run("tag")}>
              Review with Venice
            </button>
          </Step>
          <Step n={3} title="Caption" detail={`${captioned}/${selected.length} captioned${s.localOnly ? " · AI off (Local only)" : ""}`}>
            <button disabled={busy || !selected.length || s.localOnly} onClick={() => run("caption")}>
              Caption missing
            </button>
            <button
              className="ghost"
              disabled={busy || !selected.length || s.localOnly}
              onClick={() => confirm("Regenerate captions for all selected images, replacing manual edits?") && run("caption", { overwrite: true })}
            >
              Redo all
            </button>
          </Step>
          <Step n={4} title="Export" detail={`to data/output/${name}/`}>
            <button disabled={busy || !selected.length} onClick={() => run("export")}>
              Export
            </button>
          </Step>
          <div className="pipeline-side">
            <button className="primary" disabled={busy} onClick={() => run("auto")} title={s.localOnly ? "Step 1 only (Local only)" : "Steps 1 and 2"}>
              Run 1 + 2
            </button>
            <button className="ghost" onClick={() => setShowSettings((v) => !v)}>
              {showSettings ? "Hide settings" : "Settings"}
            </button>
          </div>
        </section>

        <JobBar job={job} onCancel={() => api.cancel(name).then(setJob)} />
        {error && (
          <div className="banner error" onClick={() => setError(null)}>
            {error}
          </div>
        )}

        <SelectionStats selected={selected} settings={s} />

        <div className="toolbar">
          <div className="tabs">
            {FILTERS.map((f) => (
              <button key={f.id} className={filter === f.id ? "tab active" : "tab"} onClick={() => setFilter(f.id)}>
                {f.label} <span className="count">{counts[f.id]}</span>
              </button>
            ))}
          </div>
          <label className="sort">
            Sort
            <select value={sort} onChange={(e) => setSort(e.target.value as "score" | "name")}>
              <option value="score">Score</option>
              <option value="name">Name</option>
            </select>
          </label>
        </div>

        {!images.length && (
          <div className="empty">
            No images indexed yet. Add images to <code>data/input/{name}/</code> and click <b>Scan &amp; analyze</b>.
          </div>
        )}
        <ImageGrid images={visible} references={s.referenceImageIds} onOpen={setOpenId} onOverride={onOverride} />
      </main>

      {showSettings && <SettingsPanel settings={s} onChange={onSettings} />}

      {openImage && (
        <ImageDetail
          image={openImage}
          all={images}
          isReference={s.referenceImageIds.includes(openImage.id)}
          localOnly={s.localOnly}
          onClose={() => setOpenId(null)}
          onPrev={openIndex > 0 ? () => setOpenId(visible[openIndex - 1]!.id) : undefined}
          onNext={openIndex >= 0 && openIndex < visible.length - 1 ? () => setOpenId(visible[openIndex + 1]!.id) : undefined}
          onOverride={onOverride}
          onToggleReference={(id) => guarded(api.toggleReference(id))}
          onCaptionSaved={(id, caption) => guarded(api.setCaption(id, caption))}
          onCaptionRegenerated={reload}
        />
      )}
    </div>
  );
}

function Step({ n, title, detail, children }: { n: number; title: string; detail: string; children: React.ReactNode }) {
  return (
    <div className="step">
      <div className="step-head">
        <span className="step-n">{n}</span>
        <div>
          <div className="step-title">{title}</div>
          <div className="step-detail">{detail}</div>
        </div>
      </div>
      <div className="step-actions">{children}</div>
    </div>
  );
}

function JobBar({ job, onCancel }: { job: JobState | null; onCancel: () => void }) {
  if (!job) return null;
  const pct = job.total ? Math.round((job.done / job.total) * 100) : null;
  if (!job.running) {
    if (job.finishedAt && Date.now() - job.finishedAt > 5 * 60_000) return null;
    return (
      <div className={`banner ${job.error ? "error" : "ok"}`}>
        <b>{job.kind}</b>: {job.error ?? job.message ?? "Done"}
      </div>
    );
  }
  return (
    <div className="jobbar">
      <div className="jobbar-text">
        <span className="spinner" /> {job.stage}
        {job.total ? ` — ${job.done}/${job.total}` : ""}
      </div>
      <div className="progress">
        <div className={`progress-fill ${pct == null ? "indeterminate" : ""}`} style={{ width: `${pct ?? 100}%` }} />
      </div>
      <button className="ghost small" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

const FRAMINGS: Framing[] = ["closeup", "half", "full"];
const FRAMING_LABEL: Record<Framing, string> = { closeup: "Close-up", half: "Half body", full: "Full body" };

function SelectionStats({ selected, settings }: { selected: ImageRecord[]; settings: Settings }) {
  if (!selected.length) return null;
  const mixTotal = FRAMINGS.reduce((a, f) => a + settings.framingMix[f], 0) || 1;
  const views = new Map<string, number>();
  for (const im of selected) {
    const v = im.tags?.view ?? "unknown";
    views.set(v, (views.get(v) ?? 0) + 1);
  }
  return (
    <div className="stats">
      <div className="stat">
        <span className="stat-value">
          {selected.length}
          <small>/{settings.targetCount}</small>
        </span>
        <span className="stat-label">selected</span>
      </div>
      {FRAMINGS.map((f) => (
        <div className="stat" key={f}>
          <span className="stat-value">
            {selected.filter((im) => im.framing === f).length}
            <small>/{Math.round((settings.targetCount * settings.framingMix[f]) / mixTotal)}</small>
          </span>
          <span className="stat-label">{FRAMING_LABEL[f]}</span>
        </div>
      ))}
      <div className="stat views">
        <span className="stat-label">Views</span>
        <span>
          {[...views.entries()].map(([v, n]) => (
            <span key={v} className="chip">
              {v.replace("_", " ")} {n}
            </span>
          ))}
        </span>
      </div>
    </div>
  );
}
