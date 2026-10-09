import sharp, { type Sharp } from "sharp"
import type { Crop, Flip } from "./types"

/** Crops smaller than this (fraction of width/height) are rejected as accidental. */
const MIN_SIZE = 0.02

/** Validate and normalize a crop from untrusted input. null/undefined = no crop. */
export function parseCrop(value: unknown): Crop | null {
  if (value == null) return null
  const c = value as Partial<Crop>
  const nums = [c.x, c.y, c.w, c.h]
  if (!nums.every((n) => typeof n === "number" && Number.isFinite(n))) {
    throw new Error("Crop needs numeric x, y, w, h")
  }
  const round = (n: number) => Math.round(n * 1e5) / 1e5
  const x = round(Math.min(1, Math.max(0, c.x as number)))
  const y = round(Math.min(1, Math.max(0, c.y as number)))
  const w = round(Math.min(1 - x, c.w as number))
  const h = round(Math.min(1 - y, c.h as number))
  if (w < MIN_SIZE || h < MIN_SIZE) throw new Error("Crop is too small")
  // A crop covering the whole image is no crop.
  if (x === 0 && y === 0 && w === 1 && h === 1) return null
  return { x, y, w, h }
}

/** Validate a flip from untrusted input: "h", "v", "hv" or null. */
export function parseFlip(value: unknown): Flip | null {
  if (value == null || value === "") return null
  if (value === "h" || value === "v" || value === "hv") return value
  throw new Error(`Invalid flip: ${String(value)}`)
}

export const cropJson = (c: Crop | null) => (c ? JSON.stringify(c) : null)

export function cropFromJson(json: string | null): Crop | null {
  return json ? (JSON.parse(json) as Crop) : null
}

export const flipFromDb = (v: string | null): Flip | null =>
  v === "h" || v === "v" || v === "hv" ? v : null

/** Short stable id for a crop and flip, used in thumbnail names. */
export function editKey(c: Crop | null, flip: Flip | null = null): string {
  const h = new Bun.CryptoHasher("sha1")
  h.update(JSON.stringify([c ? [c.x, c.y, c.w, c.h] : null, flip]))
  return h.digest("hex").slice(0, 8)
}

/** The crop in pixels of an image of the given (oriented) size, clamped to the image. */
export function cropPixels(c: Crop, width: number, height: number) {
  const left = Math.min(width - 1, Math.max(0, Math.round(c.x * width)))
  const top = Math.min(height - 1, Math.max(0, Math.round(c.y * height)))
  return {
    left,
    top,
    width: Math.max(1, Math.min(width - left, Math.round(c.w * width))),
    height: Math.max(1, Math.min(height - top, Math.round(c.h * height))),
  }
}

/** Mirror a crop so it keeps covering the same content after flipping the image. */
export function mirrorCrop(c: Crop, axis: "h" | "v"): Crop {
  const r = (n: number) => Math.round(n * 1e5) / 1e5
  return axis === "h"
    ? { ...c, x: r(1 - c.x - c.w) }
    : { ...c, y: r(1 - c.y - c.h) }
}

/**
 * The image as the user sees it: EXIF-rotated, then flipped, then cropped. Each step goes
 * through a raw (lossless) intermediate, because sharp would otherwise apply flips and
 * extracts *before* the EXIF rotation, and crops are drawn on the rotated, flipped view.
 */
export async function loadImage(
  path: string,
  crop: Crop | null,
  flip: Flip | null = null,
): Promise<Sharp> {
  if (!crop && !flip) return sharp(path).rotate()
  let { data, info } = await sharp(path)
    .rotate()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const raw = () => ({
    raw: { width: info.width, height: info.height, channels: info.channels },
  })
  if (flip) {
    let img = sharp(data, raw())
    if (flip.includes("h")) img = img.flop()
    if (flip.includes("v")) img = img.flip()
    ;({ data, info } = await img.raw().toBuffer({ resolveWithObject: true }))
  }
  const img = sharp(data, raw())
  return crop ? img.extract(cropPixels(crop, info.width, info.height)) : img
}

// ---------- lossless JPEG transforms ----------

/**
 * The 8 rotations/mirrors of a rectangle, as 2×2 matrices acting on centred (x, y) with y
 * pointing down, together with the matching jpegtran arguments.
 */
const OPS: { args: string[]; m: [number, number, number, number] }[] = [
  { args: [], m: [1, 0, 0, 1] },
  { args: ["-flip", "horizontal"], m: [-1, 0, 0, 1] },
  { args: ["-rotate", "180"], m: [-1, 0, 0, -1] },
  { args: ["-flip", "vertical"], m: [1, 0, 0, -1] },
  { args: ["-transpose"], m: [0, 1, 1, 0] },
  { args: ["-rotate", "90"], m: [0, -1, 1, 0] },
  { args: ["-transverse"], m: [0, -1, -1, 0] },
  { args: ["-rotate", "270"], m: [0, 1, -1, 0] },
]

/** EXIF orientation 1–8 → the transform that makes the stored pixels upright. */
const ORIENTATION_OP = [0, 0, 1, 2, 3, 4, 5, 6, 7]

const mul = (a: number[], b: number[]) => [
  a[0] * b[0] + a[1] * b[2],
  a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2],
  a[2] * b[1] + a[3] * b[3],
]

/**
 * jpegtran arguments that turn the stored pixels into what the user sees: first the EXIF
 * orientation, then the user's flip. [] = nothing to do.
 */
export function jpegtranTransform(
  orientation: number | undefined,
  flip: Flip | null,
): string[] {
  let m: number[] = OPS[ORIENTATION_OP[orientation ?? 1] ?? 0].m
  if (flip?.includes("h")) m = mul(OPS[1].m, m)
  if (flip?.includes("v")) m = mul(OPS[3].m, m)
  const op = OPS.find((o) => o.m.every((v, i) => v === m[i]))
  return op ? op.args : []
}

/** Block size (iMCU) of a JPEG from its SOF marker: 8 or 16 px per axis. */
export function jpegBlockSize(buf: Uint8Array): { w: number; h: number } {
  let i = 2
  while (i + 4 < buf.length) {
    if (buf[i] !== 0xff) {
      i++
      continue
    }
    const marker = buf[i + 1]
    const len = (buf[i + 2] << 8) | buf[i + 3]
    // SOF0–SOF15 except DHT (C4), JPG (C8) and DAC (CC).
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      const n = buf[i + 9]
      let maxH = 1
      let maxV = 1
      for (let c = 0; c < n; c++) {
        const s = buf[i + 11 + c * 3]
        maxH = Math.max(maxH, s >> 4)
        maxV = Math.max(maxV, s & 15)
      }
      return { w: maxH * 8, h: maxV * 8 }
    }
    i += 2 + len
  }
  return { w: 16, h: 16 }
}

/**
 * Snap a pixel crop inward to the JPEG block grid so jpegtran can cut it losslessly. Only the
 * left and top edges need to sit on the grid; they move right/down by less than one block,
 * so the result never includes anything outside the requested crop.
 */
export function snapCropInward(
  px: { left: number; top: number; width: number; height: number },
  block: { w: number; h: number },
) {
  const left = Math.ceil(px.left / block.w) * block.w
  const top = Math.ceil(px.top / block.h) * block.h
  return {
    left,
    top,
    width: Math.max(1, px.width - (left - px.left)),
    height: Math.max(1, px.height - (top - px.top)),
  }
}
