import { useEffect, useState } from "react"
import type { CropSuggestion } from "../../src/crop-suggest"
import type { Crop } from "../../src/types"
import { type ImageRecord, type Override, REASON_LABELS } from "../../src/types"
import { api, imageUrl, thumbUrl } from "../api"
import { CropEditor, CropPreview } from "./CropEditor"

interface Props {
  image: ImageRecord
  all: ImageRecord[]
  isReference: boolean
  localOnly: boolean
  minShortSide: number
  onClose: () => void
  onPrev?: () => void
  onNext?: () => void
  onOverride: (id: number, o: Override) => void
  onToggleReference: (id: number) => void
  onCaptionSaved: (id: number, caption: string) => void
  onCaptionRegenerated: () => void
  /** Save (or with null, remove) the crop. Rejects with a message on failure. */
  onCrop: (id: number, crop: Crop | null) => Promise<void>
  onReview: (id: number) => Promise<void>
}

const fmt = (v: number | null | undefined, digits = 0) =>
  v == null ? "—" : v.toFixed(digits)

export function ImageDetail(p: Props) {
  const im = p.image
  const [caption, setCaption] = useState(im.caption ?? "")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cropping, setCropping] = useState(false)
  const [cropStart, setCropStart] = useState<Crop | null>(null)
  const [suggestions, setSuggestions] = useState<CropSuggestion[]>([])

  // Suggestions depend on the analysis, which changes with the crop (thumb) and status.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch when the crop or analysis changes
  useEffect(() => {
    api.cropSuggestions(im.id).then(setSuggestions, () => setSuggestions([]))
  }, [im.id, im.thumb, im.status])

  const openCrop = (start: Crop | null) => {
    setCropStart(start)
    setCropping(true)
  }
  const solo = suggestions.find((sg) => sg.kind === "solo")
  const [cropSaving, setCropSaving] = useState(false)
  const [reviewing, setReviewing] = useState(false)

  // The parent remounts this component per image (key), so only caption updates need syncing.
  useEffect(() => {
    setCaption(im.caption ?? "")
  }, [im.caption])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (cropping || e.target instanceof HTMLTextAreaElement) return
      if (e.key === "Escape") p.onClose()
      if (e.key === "ArrowLeft") p.onPrev?.()
      if (e.key === "ArrowRight") p.onNext?.()
    }
    addEventListener("keydown", onKey)
    return () => removeEventListener("keydown", onKey)
  }, [cropping, p.onClose, p.onPrev, p.onNext])

  const regenerate = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await api.regenerateCaption(im.id)
      setCaption(r.caption)
      p.onCaptionRegenerated()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const saveCrop = async (crop: Crop | null) => {
    setCropSaving(true)
    setError(null)
    try {
      await p.onCrop(im.id, crop)
      setCropping(false)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setCropSaving(false)
    }
  }

  const review = async () => {
    setReviewing(true)
    setError(null)
    try {
      await p.onReview(im.id)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setReviewing(false)
    }
  }

  const dupOf = im.dupOf != null ? p.all.find((x) => x.id === im.dupOf) : null
  const m = im.metrics
  const t = im.tags
  const dirty = caption !== (im.caption ?? "")

  return (
    <div
      className="modal"
      role="dialog"
      aria-modal="true"
      aria-label={im.relPath}
      onClick={(e) => {
        if (e.target === e.currentTarget && !cropping) p.onClose()
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !cropping) p.onClose()
      }}
    >
      <div className="modal-body">
        <div className="modal-image">
          {cropping ? (
            <CropEditor
              src={imageUrl(im.id)}
              initial={im.crop}
              start={cropStart}
              suggestions={suggestions}
              minShortSide={p.minShortSide}
              saving={cropSaving}
              onSave={saveCrop}
              onCancel={() => setCropping(false)}
            />
          ) : im.crop ? (
            <CropPreview src={imageUrl(im.id)} crop={im.crop} />
          ) : (
            <img src={imageUrl(im.id)} alt={im.relPath} />
          )}
          {!cropping && p.onPrev && (
            <button type="button" className="nav prev" onClick={p.onPrev}>
              ‹
            </button>
          )}
          {!cropping && p.onNext && (
            <button type="button" className="nav next" onClick={p.onNext}>
              ›
            </button>
          )}
        </div>
        <aside className="modal-side">
          <div className="modal-head">
            <div>
              <div className="filename">{im.relPath}</div>
              <div className="muted">
                {im.width}×{im.height}
                {im.crop && " (cropped)"} ·{" "}
                <span className={`status-text status-${im.status}`}>
                  {im.status}
                </span>
                {im.score != null && ` · score ${Math.round(im.score * 100)}`}
              </div>
            </div>
            <button type="button" className="ghost" onClick={p.onClose}>
              Close
            </button>
          </div>

          <div className="row">
            <button
              type="button"
              className={im.override === "include" ? "primary" : ""}
              onClick={() =>
                p.onOverride(
                  im.id,
                  im.override === "include" ? null : "include",
                )
              }
            >
              {im.override === "include" ? "✓ Pinned" : "Always include"}
            </button>
            <button
              type="button"
              className={im.override === "exclude" ? "danger" : ""}
              onClick={() =>
                p.onOverride(
                  im.id,
                  im.override === "exclude" ? null : "exclude",
                )
              }
            >
              {im.override === "exclude" ? "✕ Excluded" : "Always exclude"}
            </button>
            <button
              type="button"
              className={p.isReference ? "primary" : "ghost"}
              onClick={() => p.onToggleReference(im.id)}
              title="Use this face to define who the character is"
            >
              {p.isReference ? "★ Identity reference" : "☆ Use as reference"}
            </button>
            <button
              type="button"
              className={im.crop ? "primary" : "ghost"}
              disabled={cropping}
              onClick={() => openCrop(null)}
            >
              ✂ {im.crop ? "Edit crop" : "Crop"}
            </button>
          </div>

          {im.reasons.length > 0 && (
            <div className="reasons">
              {im.reasons.map((r) => (
                <span key={r} className="reason">
                  {REASON_LABELS[r] ?? r}
                </span>
              ))}
              {dupOf && (
                <span className="dup">
                  of <img src={thumbUrl(dupOf.thumb)} alt="" /> {dupOf.relPath}
                </span>
              )}
              {solo && im.reasons.includes("multiple_people") && !cropping && (
                <button
                  type="button"
                  className="small"
                  title={`Suggested crop: ${solo.width} × ${solo.height} px`}
                  onClick={() => openCrop(solo.crop)}
                >
                  ✂ Crop out others
                </button>
              )}
            </div>
          )}

          <h3>Caption</h3>
          {im.captionStale && (
            <div className="banner warn small">
              Written before the image was cropped. Check it, or click
              Regenerate.
            </div>
          )}
          <textarea
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            rows={6}
            placeholder={
              im.status === "selected"
                ? "No caption yet"
                : "Only selected images are captioned and exported"
            }
          />
          <div className="row">
            <button
              type="button"
              disabled={!dirty}
              onClick={() => p.onCaptionSaved(im.id, caption)}
            >
              Save
            </button>
            <button
              type="button"
              className="ghost"
              disabled={busy || p.localOnly}
              title={p.localOnly ? "Dataset is Local only" : undefined}
              onClick={regenerate}
            >
              {busy ? "Generating…" : im.caption ? "Regenerate" : "Generate"}
            </button>
          </div>
          {error && <div className="banner error">{error}</div>}

          <div className="section-head">
            <h3>AI review</h3>
            <button
              type="button"
              className="ghost small"
              disabled={reviewing || p.localOnly || im.status === "pending"}
              title={
                p.localOnly
                  ? "Dataset is Local only"
                  : im.status === "pending"
                    ? "Analyze the image locally first"
                    : "Send this image (cropped, if cropped) to the review model"
              }
              onClick={review}
            >
              {reviewing
                ? "Reviewing…"
                : t
                  ? "Review again"
                  : "Review this image"}
            </button>
          </div>
          {!t && <p className="muted small-text">Not reviewed yet.</p>}
          {t && (
            <dl className="kv">
              <dt>Quality</dt>
              <dd>{t.quality}/10</dd>
              <dt>Framing</dt>
              <dd>{t.framing}</dd>
              <dt>View / camera</dt>
              <dd>
                {t.view.replace("_", " ")} · {t.camera.replace("_", " ")}
              </dd>
              <dt>Pose</dt>
              <dd>{t.pose}</dd>
              <dt>Expression</dt>
              <dd>{t.expression}</dd>
              <dt>Outfit</dt>
              <dd>
                {t.outfit}

                {im.outfitGroup &&
                  im.outfitGroup !== t.outfit.toLowerCase() && (
                    <span className="muted"> · group: {im.outfitGroup}</span>
                  )}
              </dd>
              <dt>Setting</dt>
              <dd>{t.setting?.replaceAll("_", " ") ?? "—"}</dd>
              <dt>Background</dt>
              <dd>{t.background}</dd>
              <dt>Lighting</dt>
              <dd>{t.lighting}</dd>
              <dt>Issues</dt>
              <dd>
                {t.issues.length
                  ? t.issues.join(", ").replaceAll("_", " ")
                  : "none"}
              </dd>
              {t.note && (
                <>
                  <dt>Note</dt>
                  <dd>{t.note}</dd>
                </>
              )}
            </dl>
          )}

          <h3>Local metrics</h3>
          <dl className="kv">
            <dt>Aesthetic</dt>
            <dd>
              {fmt(m.aesthetic, 2)}{" "}
              <span className="muted">(LAION, ~1–10)</span>
            </dd>
            <dt>Identity match</dt>
            <dd>{fmt(m.identity, 2)}</dd>
            <dt>Face sharpness</dt>
            <dd>{fmt(m.faceSharpness)}</dd>
            <dt>Image sharpness</dt>
            <dd>{fmt(m.sharpness)}</dd>
            <dt>Face height</dt>
            <dd>
              {m.faceHeight == null
                ? "—"
                : `${Math.round(m.faceHeight * 100)}% of image`}
            </dd>
            <dt>Head yaw</dt>
            <dd>{m.yaw == null ? "—" : `${Math.round(m.yaw)}°`}</dd>
            <dt>Faces found</dt>
            <dd>{m.faceCount}</dd>
            <dt>Brightness</dt>
            <dd>{fmt(m.brightness)}</dd>
          </dl>
        </aside>
      </div>
    </div>
  )
}
