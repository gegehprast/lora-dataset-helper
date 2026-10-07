import sharp, { type Sharp } from "sharp"
import type { Crop } from "./types"

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

export const cropJson = (c: Crop | null) => (c ? JSON.stringify(c) : null)

export function cropFromJson(json: string | null): Crop | null {
  return json ? (JSON.parse(json) as Crop) : null
}

/** Short stable id for a crop, used in thumbnail names. */
export function cropKey(c: Crop): string {
  const h = new Bun.CryptoHasher("sha1")
  h.update(JSON.stringify([c.x, c.y, c.w, c.h]))
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

/**
 * The image, EXIF-rotated, with the crop applied. Rotation happens first (via a raw, lossless
 * intermediate) so crop coordinates always refer to the image as the user saw it.
 */
export async function loadImage(
  path: string,
  crop: Crop | null,
): Promise<Sharp> {
  if (!crop) return sharp(path).rotate()
  const { data, info } = await sharp(path)
    .rotate()
    .raw()
    .toBuffer({ resolveWithObject: true })
  return sharp(data, {
    raw: { width: info.width, height: info.height, channels: info.channels },
  }).extract(cropPixels(crop, info.width, info.height))
}
