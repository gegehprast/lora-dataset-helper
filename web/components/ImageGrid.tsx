import { memo } from "react"
import { type ImageRecord, type Override, REASON_LABELS } from "../../src/types"
import { thumbUrl } from "../api"

interface Props {
  images: ImageRecord[]
  references: number[]
  onOpen: (id: number) => void
  onOverride: (id: number, o: Override) => void
}

export function ImageGrid({ images, references, onOpen, onOverride }: Props) {
  return (
    <div className="grid">
      {images.map((im) => (
        <Card
          key={im.id}
          im={im}
          isRef={references.includes(im.id)}
          onOpen={onOpen}
          onOverride={onOverride}
        />
      ))}
    </div>
  )
}

const FRAMING_SHORT = { closeup: "close", half: "half", full: "full" } as const

const Card = memo(function Card({
  im,
  isRef,
  onOpen,
  onOverride,
}: {
  im: ImageRecord
  isRef: boolean
  onOpen: (id: number) => void
  onOverride: (id: number, o: Override) => void
}) {
  return (
    <div className={`card status-${im.status}`} title={im.relPath}>
      <div className="thumb">
        <button
          type="button"
          className="thumb-open"
          onClick={() => onOpen(im.id)}
          aria-label={`Open ${im.relPath}`}
        >
          <img src={thumbUrl(im.thumb)} loading="lazy" alt={im.relPath} />
        </button>
        <div className="card-badges">
          {im.score != null && (
            <span className="badge score">{Math.round(im.score * 100)}</span>
          )}
          {im.framing && (
            <span className="badge">{FRAMING_SHORT[im.framing]}</span>
          )}
          {im.override && (
            <span className={`badge override-${im.override}`}>
              {im.override === "include" ? "pinned" : "excluded"}
            </span>
          )}
          {isRef && <span className="badge ref">ref</span>}
          {im.crop && <span className="badge">crop</span>}
          {im.flip && <span className="badge">flip</span>}
          {im.status === "selected" && im.caption && (
            <span
              className={`badge ${im.captionStale ? "caption-stale" : "caption"}`}
              title={
                im.captionStale
                  ? "Caption written before the crop or flip"
                  : "Has a caption"
              }
            >
              txt{im.captionStale && " !"}
            </span>
          )}
        </div>
        <div className="card-actions">
          {im.override !== "include" && (
            <button
              type="button"
              className="icon"
              title="Always include"
              onClick={() => onOverride(im.id, "include")}
            >
              ✓
            </button>
          )}
          {im.override !== "exclude" && (
            <button
              type="button"
              className="icon"
              title="Always exclude"
              onClick={() => onOverride(im.id, "exclude")}
            >
              ✕
            </button>
          )}
          {im.override && (
            <button
              type="button"
              className="icon"
              title="Let the AI decide"
              onClick={() => onOverride(im.id, null)}
            >
              ↺
            </button>
          )}
        </div>
      </div>
      {im.reasons.length > 0 && (
        <div className="card-reasons">
          {im.reasons.slice(0, 2).map((r) => (
            <span key={r} className="reason">
              {REASON_LABELS[r] ?? r}
            </span>
          ))}
          {im.reasons.length > 2 && (
            <span className="reason">+{im.reasons.length - 2}</span>
          )}
        </div>
      )}
    </div>
  )
})
