import type { Analysis, Crop } from "./types"

export type SuggestionKind = "solo" | "closeup" | "half"

export interface CropSuggestion {
  kind: SuggestionKind
  label: string
  crop: Crop
  /** Output size in pixels. */
  width: number
  height: number
}

interface Options {
  minShortSide: number
  /** Other faces at least this tall (fraction of the full image height) count as people. */
  otherPersonMinFace: number
}

/** Pixel-space box: x1, y1, x2, y2. */
type Box = [number, number, number, number]

const area = (b: Box) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1])
const contains = (outer: Box, inner: Box) =>
  outer[0] <= inner[0] &&
  outer[1] <= inner[1] &&
  outer[2] >= inner[2] &&
  outer[3] >= inner[3]
const overlaps = (a: Box, b: Box) =>
  a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]

/**
 * A crop of the given pixel size and aspect (w/h) around the face centre, with the face centre
 * at `faceY` (fraction from the top), shifted to stay inside the image and shrunk if needed.
 */
function framed(
  face: Box,
  W: number,
  H: number,
  height: number,
  aspect: number,
  faceY: number,
): Box {
  let h = Math.min(height, H)
  let w = h * aspect
  if (w > W) [w, h] = [W, W / aspect]
  const cx = (face[0] + face[2]) / 2
  const cy = (face[1] + face[3]) / 2
  const x = Math.min(W - w, Math.max(0, cx - w / 2))
  const y = Math.min(H - h, Math.max(0, cy - faceY * h))
  return [x, y, x + w, y + h]
}

/**
 * Crop suggestions from the face positions of the local analysis. Works on the full image:
 * if the image is already cropped, face boxes are mapped back from the cropped region.
 * Suggestions are only offered when they make sense and the result still meets
 * `minShortSide`.
 */
export function suggestCrops(
  analysis: Analysis | null,
  currentCrop: Crop | null,
  mainFace: number | null,
  opts: Options,
): CropSuggestion[] {
  if (!analysis || analysis.error || !analysis.faces?.length) return []
  const c = currentCrop ?? { x: 0, y: 0, w: 1, h: 1 }
  // Full-image size in pixels, recovered from the analyzed (cropped) size.
  const W = analysis.width / c.w
  const H = analysis.height / c.h
  const toFull = (b: [number, number, number, number]): Box => [
    (c.x + b[0] * c.w) * W,
    (c.y + b[1] * c.h) * H,
    (c.x + b[2] * c.w) * W,
    (c.y + b[3] * c.h) * H,
  ]
  const faces = analysis.faces.map((f) => toFull(f.bbox))
  const mainIdx = mainFace ?? 0
  const main = faces[mainIdx]
  if (!main) return []
  const fh = main[3] - main[1]

  const out: CropSuggestion[] = []
  const add = (kind: SuggestionKind, label: string, b: Box) => {
    const width = Math.round(b[2] - b[0])
    const height = Math.round(b[3] - b[1])
    if (Math.min(width, height) < opts.minShortSide) return
    const crop: Crop = {
      x: round(b[0] / W),
      y: round(b[1] / H),
      w: round((b[2] - b[0]) / W),
      h: round((b[3] - b[1]) / H),
    }
    if (crop.w > 0.98 && crop.h > 0.98) return // basically the whole image
    out.push({ kind, label, crop, width, height })
  }

  // 1. Remove other people: cut away each significant other person (face + body below it).
  const others = faces
    .filter(
      (f, i) => i !== mainIdx && (f[3] - f[1]) / H >= opts.otherPersonMinFace,
    )
    .sort((a, b) => area(b) - area(a))
  if (others.length) {
    // Try generous margins first, then tighter ones for close two-person shots.
    for (const [keepPad, personPad] of MARGINS) {
      const rect = cutAway(main, others, W, H, keepPad, personPad)
      if (rect) {
        add("solo", "Remove other people", rect)
        break
      }
    }
  }

  const faceShare = fh / H
  // 2. Close-up (head and shoulders, 4:5) when the image isn't one already.
  if (faceShare < 0.28) {
    add("closeup", "Close-up", framed(main, W, H, fh * 2.8, 4 / 5, 0.42))
  }
  // 3. Half body (3:4) from full-body shots.
  if (faceShare < 0.1) {
    add("half", "Half body", framed(main, W, H, fh * 6.5, 3 / 4, 0.2))
  }
  return out
}

/** [room kept around the character's head, extra width around each other person] in face sizes. */
const MARGINS: [number, number][] = [
  [0.3, 0.6],
  [0.15, 0.3],
  [0.05, 0.08],
]

/**
 * The largest rectangle that keeps the main face (plus `keepPad`) and excludes every other
 * person, modelled as their face widened by `personPad` and extended down to the bottom (body).
 * null if they can't be separated.
 */
function cutAway(
  main: Box,
  others: Box[],
  W: number,
  H: number,
  keepPad: number,
  personPad: number,
): Box | null {
  const fw = main[2] - main[0]
  const fh = main[3] - main[1]
  const keep: Box = [
    main[0] - fw * keepPad,
    main[1] - fh * keepPad,
    main[2] + fw * keepPad,
    main[3] + fh * keepPad * 1.5,
  ]
  let rect: Box = [0, 0, W, H]
  for (const f of others) {
    const w = f[2] - f[0]
    const h = f[3] - f[1]
    const person: Box = [
      f[0] - w * personPad,
      f[1] - h * personPad,
      f[2] + w * personPad,
      H,
    ]
    if (!overlaps(rect, person)) continue
    const candidates: Box[] = [
      [rect[0], rect[1], Math.min(rect[2], person[0]), rect[3]], // keep left of them
      [Math.max(rect[0], person[2]), rect[1], rect[2], rect[3]], // keep right
      [rect[0], rect[1], rect[2], Math.min(rect[3], person[1])], // keep above
    ]
    const options = candidates.filter((o) => contains(o, keep))
    if (!options.length) return null
    rect = options.reduce((best, o) => (area(o) > area(best) ? o : best))
  }
  return rect
}

const round = (n: number) => Math.round(n * 1e5) / 1e5
