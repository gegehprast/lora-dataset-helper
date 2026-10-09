import { useCallback, useEffect, useRef, useState } from "react"
import type { CropSuggestion } from "../../src/crop-suggest"
import type { Crop, Flip } from "../../src/types"

/** CSS for showing an image flipped. Only the picture is mirrored; boxes drawn over it are
 * in on-screen coordinates, which is what crops are stored in. */
export const flipStyle = (flip: Flip | null | undefined) =>
  flip
    ? {
        transform: `scale(${flip.includes("h") ? -1 : 1}, ${flip.includes("v") ? -1 : 1})`,
      }
    : undefined

const MIN = 0.02

/** Pixel aspect ratios (width / height). null = free. */
export const ASPECTS: { label: string; value: number | null }[] = [
  { label: "Free", value: null },
  { label: "1:1", value: 1 },
  { label: "4:5", value: 4 / 5 },
  { label: "3:4", value: 3 / 4 },
  { label: "2:3", value: 2 / 3 },
  { label: "9:16", value: 9 / 16 },
  { label: "5:4", value: 5 / 4 },
  { label: "4:3", value: 4 / 3 },
  { label: "3:2", value: 3 / 2 },
  { label: "16:9", value: 16 / 9 },
]

type Handle = "move" | "nw" | "ne" | "sw" | "se" | "new"

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v))

/**
 * Fit a box anchored at (ax, ay) and growing towards (px, py), keeping the normalized
 * aspect `na` (w / h in 0–1 units) if given, and staying inside the image.
 */
function fromAnchor(
  ax: number,
  ay: number,
  px: number,
  py: number,
  na: number | null,
): Crop {
  const dirX = px >= ax ? 1 : -1
  const dirY = py >= ay ? 1 : -1
  const maxW = dirX > 0 ? 1 - ax : ax
  const maxH = dirY > 0 ? 1 - ay : ay
  let w = Math.min(Math.abs(px - ax), maxW)
  let h = Math.min(Math.abs(py - ay), maxH)
  if (na) {
    if (w / na > h) h = w / na
    else w = h * na
    if (w > maxW) [w, h] = [maxW, maxW / na]
    if (h > maxH) [h, w] = [maxH, maxH * na]
  }
  w = Math.max(w, MIN)
  h = Math.max(h, MIN)
  return {
    x: dirX > 0 ? ax : ax - w,
    y: dirY > 0 ? ay : ay - h,
    w,
    h,
  }
}

/** Largest box with normalized aspect `na` centred on `c`, no bigger than `c`'s area allows. */
function fitAspect(c: Crop, na: number): Crop {
  const cx = c.x + c.w / 2
  const cy = c.y + c.h / 2
  let w = c.w
  let h = w / na
  if (h > 1) [h, w] = [1, na]
  if (w > 1) [w, h] = [1, 1 / na]
  return {
    x: clamp(cx - w / 2, 0, 1 - w),
    y: clamp(cy - h / 2, 0, 1 - h),
    w,
    h,
  }
}

interface Props {
  src: string
  flip?: Flip | null
  /** The image's saved crop, if any. */
  initial: Crop | null
  /** Box to start with instead of `initial` (e.g. a suggestion). */
  start?: Crop | null
  suggestions?: CropSuggestion[]
  minShortSide: number
  saving: boolean
  onSave: (crop: Crop | null) => void
  onCancel: () => void
}

export function CropEditor({
  src,
  flip,
  initial,
  start,
  suggestions = [],
  minShortSide,
  saving,
  onSave,
  onCancel,
}: Props) {
  const stage = useRef<HTMLDivElement>(null)
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)
  const [rect, setRect] = useState<Crop>(
    start ?? initial ?? { x: 0.1, y: 0.1, w: 0.8, h: 0.8 },
  )
  const [aspect, setAspect] = useState<number | null>(null)
  const drag = useRef<{
    handle: Handle
    start: { x: number; y: number }
    rect: Crop
  } | null>(null)

  // Normalized aspect (w / h in 0–1 units) for the chosen pixel aspect.
  const na = aspect && natural ? (aspect * natural.h) / natural.w : null

  const point = useCallback((e: { clientX: number; clientY: number }) => {
    const r = stage.current?.getBoundingClientRect()
    if (!r) return { x: 0, y: 0 }
    return {
      x: clamp((e.clientX - r.left) / r.width, 0, 1),
      y: clamp((e.clientY - r.top) / r.height, 0, 1),
    }
  }, [])

  const begin = (handle: Handle) => (e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    ;(e.target as Element).setPointerCapture(e.pointerId)
    drag.current = { handle, start: point(e), rect }
  }

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    const p = point(e)
    const r = d.rect
    switch (d.handle) {
      case "move":
        setRect({
          ...r,
          x: clamp(r.x + p.x - d.start.x, 0, 1 - r.w),
          y: clamp(r.y + p.y - d.start.y, 0, 1 - r.h),
        })
        break
      case "new":
        setRect(fromAnchor(d.start.x, d.start.y, p.x, p.y, na))
        break
      default: {
        // Anchor at the corner opposite the dragged one.
        const ax = d.handle.includes("w") ? r.x + r.w : r.x
        const ay = d.handle.includes("n") ? r.y + r.h : r.y
        setRect(fromAnchor(ax, ay, p.x, p.y, na))
      }
    }
  }

  const end = () => {
    drag.current = null
  }

  const chooseAspect = (value: number | null) => {
    setAspect(value)
    if (value && natural)
      setRect((r) => fitAspect(r, (value * natural.h) / natural.w))
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation()
        onCancel()
      }
      const typing =
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLSelectElement
      if (e.key === "Enter" && !saving && !typing) onSave(rect)
    }
    addEventListener("keydown", onKey, true)
    return () => removeEventListener("keydown", onKey, true)
  }, [onCancel, onSave, rect, saving])

  const outW = natural ? Math.round(rect.w * natural.w) : 0
  const outH = natural ? Math.round(rect.h * natural.h) : 0
  const tooSmall = natural != null && Math.min(outW, outH) < minShortSide

  return (
    <div className="crop-editor">
      <div className="crop-toolbar">
        <select
          aria-label="Aspect ratio"
          value={aspect ?? ""}
          onChange={(e) =>
            chooseAspect(e.target.value ? Number(e.target.value) : null)
          }
        >
          {ASPECTS.map((a) => (
            <option key={a.label} value={a.value ?? ""}>
              {a.label}
            </option>
          ))}
        </select>
        <span className={tooSmall ? "warn-text" : "muted"}>
          {natural ? `${outW} × ${outH} px` : "…"}
          {tooSmall && ` · below the ${minShortSide} px minimum`}
        </span>
        <span className="spacer" />
        {initial && (
          <button
            type="button"
            className="ghost"
            disabled={saving}
            onClick={() => onSave(null)}
          >
            Remove crop
          </button>
        )}
        <button
          type="button"
          className="ghost"
          disabled={saving}
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="button"
          className="primary"
          disabled={saving || !natural}
          onClick={() => onSave(rect)}
        >
          {saving ? "Saving…" : "Save crop"}
        </button>
      </div>
      {suggestions.length > 0 && (
        <div className="crop-suggestions">
          <span className="muted">Suggested:</span>
          {suggestions.map((sg) => (
            <button
              type="button"
              key={sg.kind}
              className="small"
              title={`${sg.width} × ${sg.height} px`}
              onClick={() => {
                setAspect(null)
                setRect(sg.crop)
              }}
            >
              {sg.label}
            </button>
          ))}
        </div>
      )}
      <div className="crop-area">
        <div
          ref={stage}
          className="crop-stage"
          onPointerDown={begin("new")}
          onPointerMove={onMove}
          onPointerUp={end}
          onPointerCancel={end}
        >
          <img
            src={src}
            alt=""
            draggable={false}
            style={flipStyle(flip)}
            onLoad={(e) =>
              setNatural({
                w: e.currentTarget.naturalWidth,
                h: e.currentTarget.naturalHeight,
              })
            }
          />
          <div
            className="crop-box"
            style={{
              left: `${rect.x * 100}%`,
              top: `${rect.y * 100}%`,
              width: `${rect.w * 100}%`,
              height: `${rect.h * 100}%`,
            }}
            onPointerDown={begin("move")}
          >
            <span className="third v1" />
            <span className="third v2" />
            <span className="third h1" />
            <span className="third h2" />
            {(["nw", "ne", "sw", "se"] as const).map((h) => (
              <span
                key={h}
                className={`crop-handle ${h}`}
                onPointerDown={begin(h)}
              />
            ))}
          </div>
        </div>
      </div>
      <p className="crop-hint muted">
        Drag the box to move it, its corners to resize, or drag on the image to
        draw a new one. Enter saves, Esc cancels.
      </p>
    </div>
  )
}

/** Read-only view of an image with its crop shown (outside area dimmed). */
export function CropPreview({
  src,
  crop,
  flip,
}: {
  src: string
  crop: Crop
  flip?: Flip | null
}) {
  return (
    <div className="crop-stage readonly">
      <img src={src} alt="" draggable={false} style={flipStyle(flip)} />
      <div
        className="crop-box"
        style={{
          left: `${crop.x * 100}%`,
          top: `${crop.y * 100}%`,
          width: `${crop.w * 100}%`,
          height: `${crop.h * 100}%`,
        }}
      />
    </div>
  )
}
