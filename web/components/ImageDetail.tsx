import { useEffect, useState } from "react";
import { REASON_LABELS, type ImageRecord, type Override } from "../../src/types";
import { api, imageUrl, thumbUrl } from "../api";

interface Props {
  image: ImageRecord;
  all: ImageRecord[];
  isReference: boolean;
  localOnly: boolean;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  onOverride: (id: number, o: Override) => void;
  onToggleReference: (id: number) => void;
  onCaptionSaved: (id: number, caption: string) => void;
  onCaptionRegenerated: () => void;
}

const fmt = (v: number | null | undefined, digits = 0) => (v == null ? "—" : v.toFixed(digits));

export function ImageDetail(p: Props) {
  const im = p.image;
  const [caption, setCaption] = useState(im.caption ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setCaption(im.caption ?? "");
    setError(null);
  }, [im.id, im.caption]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "Escape") p.onClose();
      if (e.key === "ArrowLeft") p.onPrev?.();
      if (e.key === "ArrowRight") p.onNext?.();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [p.onClose, p.onPrev, p.onNext]);

  const regenerate = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.regenerateCaption(im.id);
      setCaption(r.caption);
      p.onCaptionRegenerated();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const dupOf = im.dupOf != null ? p.all.find((x) => x.id === im.dupOf) : null;
  const m = im.metrics;
  const t = im.tags;
  const dirty = caption !== (im.caption ?? "");

  return (
    <div className="modal" onClick={p.onClose}>
      <div className="modal-body" onClick={(e) => e.stopPropagation()}>
        <div className="modal-image">
          <img src={imageUrl(im.id)} alt={im.relPath} />
          {p.onPrev && (
            <button className="nav prev" onClick={p.onPrev}>
              ‹
            </button>
          )}
          {p.onNext && (
            <button className="nav next" onClick={p.onNext}>
              ›
            </button>
          )}
        </div>
        <aside className="modal-side">
          <div className="modal-head">
            <div>
              <div className="filename">{im.relPath}</div>
              <div className="muted">
                {im.width}×{im.height} · <span className={`status-text status-${im.status}`}>{im.status}</span>
                {im.score != null && ` · score ${Math.round(im.score * 100)}`}
              </div>
            </div>
            <button className="ghost" onClick={p.onClose}>
              Close
            </button>
          </div>

          <div className="row">
            <button className={im.override === "include" ? "primary" : ""} onClick={() => p.onOverride(im.id, im.override === "include" ? null : "include")}>
              {im.override === "include" ? "✓ Pinned" : "Always include"}
            </button>
            <button className={im.override === "exclude" ? "danger" : ""} onClick={() => p.onOverride(im.id, im.override === "exclude" ? null : "exclude")}>
              {im.override === "exclude" ? "✕ Excluded" : "Always exclude"}
            </button>
            <button className={p.isReference ? "primary" : "ghost"} onClick={() => p.onToggleReference(im.id)} title="Use this face to define who the character is">
              {p.isReference ? "★ Identity reference" : "☆ Use as reference"}
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
                  of <img src={thumbUrl(dupOf.hash)} alt="" /> {dupOf.relPath}
                </span>
              )}
            </div>
          )}

          <h3>Caption</h3>
          <textarea value={caption} onChange={(e) => setCaption(e.target.value)} rows={6} placeholder={im.status === "selected" ? "No caption yet" : "Only selected images are captioned and exported"} />
          <div className="row">
            <button disabled={!dirty} onClick={() => p.onCaptionSaved(im.id, caption)}>
              Save
            </button>
            <button className="ghost" disabled={busy || p.localOnly} title={p.localOnly ? "Dataset is Local only" : undefined} onClick={regenerate}>
              {busy ? "Generating…" : im.caption ? "Regenerate" : "Generate"}
            </button>
          </div>
          {error && <div className="banner error">{error}</div>}

          {t && (
            <>
              <h3>AI review</h3>
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
                <dd>{t.outfit}</dd>
                <dt>Background</dt>
                <dd>{t.background}</dd>
                <dt>Lighting</dt>
                <dd>{t.lighting}</dd>
                <dt>Issues</dt>
                <dd>{t.issues.length ? t.issues.join(", ").replaceAll("_", " ") : "none"}</dd>
                {t.note && (
                  <>
                    <dt>Note</dt>
                    <dd>{t.note}</dd>
                  </>
                )}
              </dl>
            </>
          )}

          <h3>Local metrics</h3>
          <dl className="kv">
            <dt>Aesthetic</dt>
            <dd>{fmt(m.aesthetic, 2)} <span className="muted">(LAION, ~1–10)</span></dd>
            <dt>Identity match</dt>
            <dd>{fmt(m.identity, 2)}</dd>
            <dt>Face sharpness</dt>
            <dd>{fmt(m.faceSharpness)}</dd>
            <dt>Image sharpness</dt>
            <dd>{fmt(m.sharpness)}</dd>
            <dt>Face height</dt>
            <dd>{m.faceHeight == null ? "—" : `${Math.round(m.faceHeight * 100)}% of image`}</dd>
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
  );
}
