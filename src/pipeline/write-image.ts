import { rmSync } from "node:fs"
import { extname, join } from "node:path"
import sharp from "sharp"
import {
  cropPixels,
  jpegBlockSize,
  jpegtranTransform,
  loadImage,
  snapCropInward,
} from "../crop"
import type { Crop, Flip, JpegImperfect } from "../types"

export interface WriteResult {
  /** File name written (stem + extension). */
  name: string
  method: "jpeg-lossless" | "jpeg-lossless-trimmed" | "png" | "webp-lossless"
  note?: string
}

/** Run jpegtran; true on success. */
async function jpegtran(args: string[]): Promise<boolean> {
  const proc = Bun.spawn(["jpegtran", ...args], {
    stdout: "ignore",
    stderr: "pipe",
  })
  return (await proc.exited) === 0
}

const hasJpegtran = () => Bun.which("jpegtran") != null

/** The 2×2 matrix of jpegtran transform args (inverse of jpegtranTransform's lookup). */
function opMatrix(args: string[]): [number, number, number, number] {
  const key = args.join(" ")
  const table: Record<string, [number, number, number, number]> = {
    "": [1, 0, 0, 1],
    "-flip horizontal": [-1, 0, 0, 1],
    "-rotate 180": [-1, 0, 0, -1],
    "-flip vertical": [1, 0, 0, -1],
    "-transpose": [0, 1, 1, 0],
    "-rotate 90": [0, -1, 1, 0],
    "-transverse": [0, -1, -1, 0],
    "-rotate 270": [0, 1, -1, 0],
  }
  return table[key] ?? [1, 0, 0, 1]
}

/**
 * Map a pixel rectangle in the displayed image back to the stored image (before the
 * transform `m`). Both are axis-aligned; m is orthogonal, so its inverse is its transpose.
 */
function rectToStored(
  rect: { left: number; top: number; width: number; height: number },
  m: [number, number, number, number],
  stored: { w: number; h: number },
) {
  const swap = m[0] === 0
  const disp = swap ? { w: stored.h, h: stored.w } : stored
  const corner = (x: number, y: number) => {
    const u = x - disp.w / 2
    const v = y - disp.h / 2
    // inverse = transpose
    return [
      m[0] * u + m[2] * v + stored.w / 2,
      m[1] * u + m[3] * v + stored.h / 2,
    ]
  }
  const a = corner(rect.left, rect.top)
  const b = corner(rect.left + rect.width, rect.top + rect.height)
  const left = Math.round(Math.min(a[0], b[0]))
  const top = Math.round(Math.min(a[1], b[1]))
  return {
    left,
    top,
    width: Math.round(Math.max(a[0], b[0])) - left,
    height: Math.round(Math.max(a[1], b[1])) - top,
  }
}

/**
 * Lossless JPEG path (no recompression; only the ICC profile is kept):
 * 1. crop in the *stored* orientation, with the top-left corner snapped inward to the block
 *    grid;
 * 2. apply EXIF rotation + flip as one DCT-domain transform. If the size isn't a multiple of
 *    the block size, either trim the partial edge blocks (< 16 px) or give up (→ PNG).
 * Both steps can only shrink the picture, never include anything outside the crop.
 */
async function writeJpeg(
  source: string,
  dest: string,
  crop: Crop | null,
  flip: Flip | null,
  imperfect: JpegImperfect,
): Promise<"perfect" | "trimmed" | null> {
  const meta = await sharp(source).metadata()
  const transform = jpegtranTransform(meta.orientation, flip)
  const tmp = `${dest}.crop.tmp`
  try {
    let input = source
    if (crop) {
      const m = opMatrix(transform)
      const stored = { w: meta.width ?? 0, h: meta.height ?? 0 }
      const swap = m[0] === 0
      const disp = swap ? { w: stored.h, h: stored.w } : stored
      const want = rectToStored(cropPixels(crop, disp.w, disp.h), m, stored)
      const block = jpegBlockSize(
        new Uint8Array(await Bun.file(source).arrayBuffer()),
      )
      const r = snapCropInward(want, block)
      const ok = await jpegtran([
        "-copy",
        "icc",
        "-crop",
        `${r.width}x${r.height}+${r.left}+${r.top}`,
        "-outfile",
        tmp,
        source,
      ])
      if (!ok) return null
      input = tmp
    }
    const base = ["-copy", "icc", ...transform]
    if (await jpegtran([...base, "-perfect", "-outfile", dest, input]))
      return "perfect"
    if (
      imperfect === "trim" &&
      (await jpegtran([...base, "-trim", "-outfile", dest, input]))
    )
      return "trimmed"
    return null
  } finally {
    rmSync(tmp, { force: true })
  }
}

/**
 * Write an export image without metadata, with EXIF rotation, flip and crop applied, and
 * without lossy recompression:
 * - JPEG: jpegtran (see writeJpeg). Falls back to PNG when a perfect transform isn't
 *   possible and `imperfect` is "png", or when jpegtran isn't installed.
 * - WebP: lossless WebP of the decoded pixels.
 * - PNG and anything else: PNG.
 */
export async function writeCleanImage(
  source: string,
  destDir: string,
  stem: string,
  edits: { crop: Crop | null; flip: Flip | null },
  imperfect: JpegImperfect = "trim",
): Promise<WriteResult> {
  const ext = extname(source).toLowerCase()
  let note: string | undefined
  if (ext === ".jpg" || ext === ".jpeg") {
    if (hasJpegtran()) {
      const name = `${stem}${ext}`
      const r = await writeJpeg(
        source,
        join(destDir, name),
        edits.crop,
        edits.flip,
        imperfect,
      )
      if (r === "perfect") return { name, method: "jpeg-lossless" }
      if (r === "trimmed")
        return {
          name,
          method: "jpeg-lossless-trimmed",
          note: "edge trimmed by less than one 16 px block to rotate losslessly",
        }
      rmSync(join(destDir, name), { force: true })
      note = "JPEG couldn't be transformed losslessly; saved as PNG"
    } else {
      note = "jpegtran isn't installed; saved as PNG"
    }
  }
  const img = await loadImage(source, edits.crop, edits.flip)
  if (ext === ".webp") {
    const name = `${stem}.webp`
    await img.webp({ lossless: true }).toFile(join(destDir, name))
    return { name, method: "webp-lossless" }
  }
  const name = `${stem}.png`
  await img.png().toFile(join(destDir, name))
  return { name, method: "png", note }
}
