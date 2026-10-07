import { useCallback, useEffect, useMemo, useState } from "react"
import {
  type Framing,
  type ImageRecord,
  type ImageStatus,
  type JobKind,
  type JobState,
  type Override,
  type Settings,
  VARIETY_ATTRIBUTES,
  VARIETY_LABELS,
  type VarietyAttribute,
} from "../../src/types"
import { api, type DatasetData } from "../api"
import { ImageDetail } from "./ImageDetail"
import { ImageGrid } from "./ImageGrid"
import { SettingsPanel } from "./SettingsPanel"

type Filter = ImageStatus | "all"
const FILTERS: { id: Filter; label: string }[] = [
  { id: "selected", label: "Selected" },
  { id: "reserve", label: "Reserve" },
  { id: "rejected", label: "Rejected" },
  { id: "pending", label: "Not analyzed" },
  { id: "all", label: "All" },
]

export function DatasetView({ name }: { name: string }) {
  const [data, setData] = useState<DatasetData | null>(null)
  const [job, setJob] = useState<JobState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>("selected")
  // Filter by a review attribute value, e.g. one outfit group. null = any value.
  const [attr, setAttr] = useState<VarietyAttribute>("outfit")
  const [attrValue, setAttrValue] = useState<string | null>(null)
  const [sort, setSort] = useState<"score" | "name">("score")
  const [openId, setOpenId] = useState<number | null>(null)
  const [showSettings, setShowSettings] = useState(true)

  const apply = useCallback((d: DatasetData) => {
    setData(d)
    setJob(d.job)
  }, [])

  const reload = useCallback(
    () => api.dataset(name).then(apply, (e) => setError(e.message)),
    [name, apply],
  )
  useEffect(() => {
    reload()
  }, [reload])

  // Poll the running job; reload the dataset when it finishes.
  useEffect(() => {
    if (!job?.running) return
    const t = setInterval(async () => {
      const j = await api.job(name).catch(() => null)
      setJob(j)
      if (!j?.running) reload()
    }, 700)
    return () => clearInterval(t)
  }, [job?.running, name, reload])

  const run = async (kind: JobKind, body?: object) => {
    setError(null)
    try {
      setJob(await api.startJob(name, kind, body))
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const guarded = (p: Promise<DatasetData>) =>
    p.then(apply, (e) => setError(e.message))
  const onOverride = (id: number, o: Override) =>
    guarded(api.setOverride(id, o))
  const onSettings = (patch: Partial<Settings>) =>
    guarded(api.saveSettings(name, patch))

  const images = data?.images ?? []
  const attrOptions = useMemo(
    () => attributeOptions(images, attr),
    [images, attr],
  )

  const attrImages = useMemo(() => {
    if (attrValue == null) return images
    return images.filter((im) => {
      const v = attributeValue(im, attr)
      return attrValue === NOT_REVIEWED ? v == null : v === attrValue
    })
  }, [images, attr, attrValue])

  const counts = useMemo(() => {
    const c: Record<Filter, number> = {
      selected: 0,
      reserve: 0,
      rejected: 0,
      pending: 0,
      all: attrImages.length,
    }
    for (const im of attrImages) c[im.status]++
    return c
  }, [attrImages])

  const visible = useMemo(() => {
    const list =
      filter === "all"
        ? attrImages
        : attrImages.filter((im) => im.status === filter)
    return [...list].sort((a, b) =>
      sort === "score"
        ? (b.score ?? -1) - (a.score ?? -1)
        : a.relPath.localeCompare(b.relPath),
    )
  }, [attrImages, filter, sort])

  const pickAttribute = (a: VarietyAttribute, value: string | null) => {
    setAttr(a)
    setAttrValue(value)
  }

  if (!data)
    return (
      <main className="page">
        {error ? <div className="banner error">{error}</div> : "Loading…"}
      </main>
    )

  const busy = !!job?.running
  const s = data.settings
  const selected = images.filter((im) => im.status === "selected")
  const analyzed = images.filter((im) => im.status !== "pending").length
  const tagged = images.filter((im) => im.tags).length
  const captioned = selected.filter((im) => im.caption?.trim()).length
  const openImage = images.find((im) => im.id === openId)
  const openIndex = visible.findIndex((im) => im.id === openId)
  const prevImage = openIndex > 0 ? visible[openIndex - 1] : undefined
  const nextImage = openIndex >= 0 ? visible[openIndex + 1] : undefined

  return (
    <div className={`dataset-layout ${showSettings ? "" : "settings-hidden"}`}>
      <main className="dataset-main">
        {s.localOnly && (
          <div className="banner local">
            🔒 <b>Local only</b>: this dataset's images are never sent to
            Venice. AI review and captioning are off; you can still write
            captions by hand.
          </div>
        )}
        <section className="pipeline">
          <Step
            n={1}
            title="Analyze locally"
            detail={`${analyzed}/${images.length || "?"} analyzed`}
          >
            <button
              type="button"
              disabled={busy}
              onClick={() => run("analyze")}
            >
              Scan &amp; analyze
            </button>
          </Step>
          <Step
            n={2}
            title="AI review"
            detail={
              s.localOnly
                ? "Off: dataset is Local only"
                : `${tagged} reviewed by ${s.tagModel}`
            }
          >
            <button
              type="button"
              disabled={busy || !analyzed || s.localOnly}
              onClick={() => run("tag")}
            >
              Review with Venice
            </button>
          </Step>
          <Step
            n={3}
            title="Caption"
            detail={`${captioned}/${selected.length} captioned${s.localOnly ? " · AI off (Local only)" : ""}`}
          >
            <button
              type="button"
              disabled={busy || !selected.length || s.localOnly}
              onClick={() => run("caption")}
            >
              Caption missing
            </button>
            <button
              type="button"
              className="ghost"
              disabled={busy || !selected.length || s.localOnly}
              onClick={() =>
                confirm(
                  "Regenerate captions for all selected images, replacing manual edits?",
                ) && run("caption", { overwrite: true })
              }
            >
              Redo all
            </button>
          </Step>
          <Step n={4} title="Export" detail={`to data/output/${name}/`}>
            <button
              type="button"
              disabled={busy || !selected.length}
              onClick={() => run("export")}
            >
              Export
            </button>
          </Step>
          <div className="pipeline-side">
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => run("auto")}
              title={s.localOnly ? "Step 1 only (Local only)" : "Steps 1 and 2"}
            >
              Run 1 + 2
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => setShowSettings((v) => !v)}
            >
              {showSettings ? "Hide settings" : "Settings"}
            </button>
          </div>
        </section>

        <JobBar job={job} onCancel={() => api.cancel(name).then(setJob)} />
        {error && (
          <div className="banner error">
            {error}{" "}
            <button
              type="button"
              className="ghost small"
              onClick={() => setError(null)}
            >
              Dismiss
            </button>
          </div>
        )}

        <SelectionStats
          selected={selected}
          settings={s}
          onPick={pickAttribute}
        />

        <div className="toolbar">
          <div className="tabs">
            {FILTERS.map((f) => (
              <button
                type="button"
                key={f.id}
                className={filter === f.id ? "tab active" : "tab"}
                onClick={() => setFilter(f.id)}
              >
                {f.label} <span className="count">{counts[f.id]}</span>
              </button>
            ))}
          </div>
          <div className="attr-filter">
            <select
              aria-label="Filter by attribute"
              value={attr}
              onChange={(e) =>
                pickAttribute(e.target.value as VarietyAttribute, null)
              }
            >
              {VARIETY_ATTRIBUTES.map((a) => (
                <option key={a} value={a}>
                  {VARIETY_LABELS[a]}
                </option>
              ))}
            </select>
            <select
              aria-label={`Filter by ${VARIETY_LABELS[attr].toLowerCase()}`}
              className={attrValue != null ? "active" : ""}
              value={attrValue ?? ""}
              onChange={(e) => setAttrValue(e.target.value || null)}
            >
              <option value="">Any {VARIETY_LABELS[attr].toLowerCase()}</option>
              {attrOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.value === NOT_REVIEWED ? "Not reviewed" : pretty(o.value)}{" "}
                  ({o.selected} selected / {o.total})
                </option>
              ))}
            </select>
            {attrValue != null && (
              <button
                type="button"
                className="ghost small"
                onClick={() => setAttrValue(null)}
              >
                Clear
              </button>
            )}
          </div>
          <label className="sort">
            Sort
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as "score" | "name")}
            >
              <option value="score">Score</option>
              <option value="name">Name</option>
            </select>
          </label>
        </div>

        {!images.length && (
          <div className="empty">
            No images indexed yet. Add images to <code>data/input/{name}/</code>{" "}
            and click <b>Scan &amp; analyze</b>.
          </div>
        )}
        <ImageGrid
          images={visible}
          references={s.referenceImageIds}
          onOpen={setOpenId}
          onOverride={onOverride}
        />
      </main>

      {showSettings && <SettingsPanel settings={s} onChange={onSettings} />}

      {openImage && (
        <ImageDetail
          key={openImage.id}
          image={openImage}
          all={images}
          isReference={s.referenceImageIds.includes(openImage.id)}
          localOnly={s.localOnly}
          onClose={() => setOpenId(null)}
          onPrev={prevImage ? () => setOpenId(prevImage.id) : undefined}
          onNext={nextImage ? () => setOpenId(nextImage.id) : undefined}
          onOverride={onOverride}
          onToggleReference={(id) => guarded(api.toggleReference(id))}
          onCaptionSaved={(id, caption) => guarded(api.setCaption(id, caption))}
          onCaptionRegenerated={reload}
        />
      )}
    </div>
  )
}

function Step({
  n,
  title,
  detail,
  children,
}: {
  n: number
  title: string
  detail: string
  children: React.ReactNode
}) {
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
  )
}

function JobBar({
  job,
  onCancel,
}: {
  job: JobState | null
  onCancel: () => void
}) {
  if (!job) return null
  const pct = job.total ? Math.round((job.done / job.total) * 100) : null
  if (!job.running) {
    if (job.finishedAt && Date.now() - job.finishedAt > 5 * 60_000) return null
    return (
      <div className={`banner ${job.error ? "error" : "ok"}`}>
        <b>{job.kind}</b>: {job.error ?? job.message ?? "Done"}
      </div>
    )
  }
  return (
    <div className="jobbar">
      <div className="jobbar-text">
        <span className="spinner" /> {job.stage}
        {job.total ? ` — ${job.done}/${job.total}` : ""}
      </div>
      <div className="progress">
        <div
          className={`progress-fill ${pct == null ? "indeterminate" : ""}`}
          style={{ width: `${pct ?? 100}%` }}
        />
      </div>
      <button type="button" className="ghost small" onClick={onCancel}>
        Cancel
      </button>
    </div>
  )
}

const FRAMINGS: Framing[] = ["closeup", "half", "full"]
const FRAMING_LABEL: Record<Framing, string> = {
  closeup: "Close-up",
  half: "Half body",
  full: "Full body",
}

function SelectionStats({
  selected,
  settings,
  onPick,
}: {
  selected: ImageRecord[]
  settings: Settings
  onPick: (a: VarietyAttribute, value: string) => void
}) {
  if (!selected.length) return null
  const mixTotal = FRAMINGS.reduce((a, f) => a + settings.framingMix[f], 0) || 1
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
            <small>
              /
              {Math.round(
                (settings.targetCount * settings.framingMix[f]) / mixTotal,
              )}
            </small>
          </span>
          <span className="stat-label">{FRAMING_LABEL[f]}</span>
        </div>
      ))}
      <VarietySummary selected={selected} settings={settings} onPick={onPick} />
    </div>
  )
}

/** Share above which one value is flagged as dominating the selection. */
const DOMINANT_SHARE = 0.4

function attributeValue(im: ImageRecord, a: VarietyAttribute): string | null {
  const t = im.tags
  if (!t) return null
  if (a === "outfit") return im.outfitGroup ?? (t.outfit || null)
  return (t[a] as string | undefined) ?? null
}

function VarietySummary({
  selected,
  settings,
  onPick,
}: {
  selected: ImageRecord[]
  settings: Settings
  onPick: (a: VarietyAttribute, value: string) => void
}) {
  const reviewed = selected.filter((im) => im.tags).length
  return (
    <div className="stat variety">
      <span className="stat-label">
        Variety of the selection
        {reviewed < selected.length &&
          ` (${selected.length - reviewed} not reviewed yet)`}
      </span>
      {reviewed === 0 ? (
        <span className="muted small-text">
          Run the AI review to see outfits, settings and expressions.
        </span>
      ) : (
        <ul>
          {VARIETY_ATTRIBUTES.map((a) => {
            const counts = new Map<string, number>()
            for (const im of selected) {
              const v = attributeValue(im, a)
              if (v) counts.set(v, (counts.get(v) ?? 0) + 1)
            }
            const known = [...counts.values()].reduce((x, y) => x + y, 0)
            const [top, topN] = [...counts.entries()].sort(
              (x, y) => y[1] - x[1],
            )[0] ?? ["", 0]
            const dominant = known >= 5 && topN / known > DOMINANT_SHARE
            const on = settings.varietyAttributes[a]
            return (
              <li key={a} className={on ? "" : "off"}>
                <span className="variety-name">
                  {VARIETY_LABELS[a]}
                  {!on && <small> (not balanced)</small>}
                </span>
                <span>
                  {counts.size} {counts.size === 1 ? "kind" : "kinds"}
                  {top && (
                    <>
                      {" · most: "}
                      <button
                        type="button"
                        className={`link${dominant ? " warn-text" : ""}`}
                        title="Show these images"
                        onClick={() => onPick(a, top)}
                      >
                        {pretty(top)} ×{topN}
                        {dominant && " ⚠"}
                      </button>
                    </>
                  )}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

/** Option value for images without a review (no attribute value yet). */
const NOT_REVIEWED = "\u0000not-reviewed"

const pretty = (v: string) => v.replaceAll("_", " ")

/** Values of attribute `a` across the dataset, most common first, with selected counts. */
function attributeOptions(images: ImageRecord[], a: VarietyAttribute) {
  const byValue = new Map<string, { total: number; selected: number }>()
  for (const im of images) {
    if (im.status === "pending") continue
    const v = attributeValue(im, a) ?? NOT_REVIEWED
    const entry = byValue.get(v) ?? { total: 0, selected: 0 }
    entry.total++
    if (im.status === "selected") entry.selected++
    byValue.set(v, entry)
  }
  return [...byValue.entries()]
    .map(([value, c]) => ({ value, ...c }))
    .sort(
      (x, y) =>
        Number(x.value === NOT_REVIEWED) - Number(y.value === NOT_REVIEWED) ||
        y.total - x.total ||
        x.value.localeCompare(y.value),
    )
}
