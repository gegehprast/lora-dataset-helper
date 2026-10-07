import { describe, expect, test } from "bun:test"
import { suggestCrops } from "../src/crop-suggest"
import type { Analysis, Crop } from "../src/types"
import { face } from "./helpers"

const opts = { minShortSide: 512, otherPersonMinFace: 0.08 }

/** Analysis of a W×H image with faces given as normalized [x1, y1, x2, y2]. */
function analysis(
  W: number,
  H: number,
  ...boxes: [number, number, number, number][]
): Analysis {
  return {
    width: W,
    height: H,
    sharpness: 300,
    brightness: 120,
    darkClip: 0,
    brightClip: 0,
    phash: "0",
    aesthetic: 5,
    faces: boxes.map((bbox) => ({ ...face(), bbox })),
  }
}

const byKind = (s: ReturnType<typeof suggestCrops>, kind: string) =>
  s.find((x) => x.kind === kind)

/** Does crop `c` (normalized) fully contain box `b` (normalized)? */
const containsBox = (c: Crop, b: number[]) =>
  c.x <= b[0] + 1e-6 &&
  c.y <= b[1] + 1e-6 &&
  c.x + c.w >= b[2] - 1e-6 &&
  c.y + c.h >= b[3] - 1e-6

describe("remove other people", () => {
  test("keeps the character's side and cuts the other person out", () => {
    const me = [0.1, 0.2, 0.2, 0.35] as [number, number, number, number]
    const them = [0.7, 0.2, 0.8, 0.35] as [number, number, number, number]
    const s = suggestCrops(analysis(3000, 2000, me, them), null, 0, opts)
    const solo = byKind(s, "solo")
    expect(solo).toBeDefined()
    expect(containsBox(solo!.crop, me)).toBe(true)
    // Ends before the other person's face (and the margin around their body).
    expect(solo!.crop.x + solo!.crop.w).toBeLessThan(0.7)
  })

  test("uses the main face, even when it isn't the largest", () => {
    const big = [0.6, 0.1, 0.9, 0.5] as [number, number, number, number]
    const me = [0.1, 0.3, 0.2, 0.45] as [number, number, number, number]
    const solo = byKind(
      suggestCrops(analysis(3000, 2000, big, me), null, 1, opts),
      "solo",
    )
    expect(containsBox(solo!.crop, me)).toBe(true)
    expect(solo!.crop.x + solo!.crop.w).toBeLessThan(0.6)
  })

  test("close two-person shots: retries with tighter margins", () => {
    // Faces 600 px wide with a 180 px gap: too close for the default margins.
    const me = [0.1, 0.2, 0.3, 0.4] as [number, number, number, number]
    const them = [0.36, 0.2, 0.56, 0.4] as [number, number, number, number]
    const solo = byKind(
      suggestCrops(analysis(3000, 3000, me, them), null, 0, opts),
      "solo",
    )
    expect(solo).toBeDefined()
    expect(containsBox(solo!.crop, me)).toBe(true)
    expect(solo!.crop.x + solo!.crop.w).toBeLessThanOrEqual(0.36)
  })

  test("not offered when the faces overlap (cheek to cheek)", () => {
    const s = suggestCrops(
      analysis(2916, 5184, [0.28, 0.25, 0.61, 0.49], [0.58, 0.22, 0.94, 0.49]),
      null,
      0,
      opts,
    )
    expect(byKind(s, "solo")).toBeUndefined()
  })

  test("not offered when the other faces are small background faces", () => {
    const s = suggestCrops(
      analysis(3000, 2000, [0.1, 0.2, 0.2, 0.35], [0.7, 0.2, 0.72, 0.23]),
      null,
      0,
      opts,
    )
    expect(byKind(s, "solo")).toBeUndefined()
  })
})

describe("close-up and half body", () => {
  test("close-up is 4:5 around the face, when big enough", () => {
    const me = [0.45, 0.1, 0.55, 0.18] as [number, number, number, number] // face 8% of 4000 px
    const close = byKind(
      suggestCrops(analysis(3000, 4000, me), null, 0, opts),
      "closeup",
    )
    expect(close).toBeDefined()
    expect(close!.width / close!.height).toBeCloseTo(4 / 5, 2)
    expect(containsBox(close!.crop, me)).toBe(true)
  })

  test("not offered when the result would be below the minimum size", () => {
    const me = [0.45, 0.1, 0.55, 0.18] as [number, number, number, number]
    const s = suggestCrops(analysis(3000, 4000, me), null, 0, {
      ...opts,
      minShortSide: 1200,
    })
    expect(byKind(s, "closeup")).toBeUndefined()
  })

  test("half body only for full-body shots; nothing for close-ups", () => {
    const full = suggestCrops(
      analysis(3000, 4000, [0.47, 0.1, 0.53, 0.16]),
      null,
      0,
      opts,
    )
    expect(byKind(full, "half")).toBeDefined()
    const half = suggestCrops(
      analysis(3000, 4000, [0.45, 0.1, 0.55, 0.25]),
      null,
      0,
      opts,
    )
    expect(byKind(half, "half")).toBeUndefined()
    expect(byKind(half, "closeup")).toBeDefined()
    const closeup = suggestCrops(
      analysis(3000, 4000, [0.3, 0.2, 0.7, 0.6]),
      null,
      0,
      opts,
    )
    expect(closeup).toEqual([])
  })

  test("stays inside the image when the face is near an edge", () => {
    const close = byKind(
      suggestCrops(analysis(3000, 4000, [0.0, 0.0, 0.08, 0.06]), null, 0, opts),
      "closeup",
    )!
    expect(close.crop.x).toBeGreaterThanOrEqual(0)
    expect(close.crop.y).toBeGreaterThanOrEqual(0)
    expect(close.crop.x + close.crop.w).toBeLessThanOrEqual(1)
    expect(close.crop.y + close.crop.h).toBeLessThanOrEqual(1)
  })
})

test("on an already cropped image, suggestions are in full-image coordinates", () => {
  // Current crop: right half of a 4000×4000 image. The analysis is of that 2000×4000 region;
  // the face spans 0.4–0.6 of it, i.e. 0.7–0.8 of the full image's width.
  const current: Crop = { x: 0.5, y: 0, w: 0.5, h: 1 }
  const s = suggestCrops(
    analysis(2000, 4000, [0.4, 0.1, 0.6, 0.2]),
    current,
    0,
    opts,
  )
  const close = byKind(s, "closeup")
  expect(close).toBeDefined()
  expect(containsBox(close!.crop, [0.7, 0.1, 0.8, 0.2])).toBe(true)
  // 4:5 in pixels of the full 4000×4000 image.
  expect(close!.width / close!.height).toBeCloseTo(4 / 5, 2)
})

test("no faces, no analysis or a failed analysis: no suggestions", () => {
  expect(suggestCrops(analysis(1000, 1000), null, null, opts)).toEqual([])
  expect(suggestCrops(null, null, null, opts)).toEqual([])
  expect(
    suggestCrops({ ...analysis(1000, 1000), error: "x" }, null, null, opts),
  ).toEqual([])
})
