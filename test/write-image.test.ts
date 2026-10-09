import { beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import sharp, { type Sharp } from "sharp"
import { jpegBlockSize, jpegtranTransform, loadImage } from "../src/crop"
import { writeCleanImage } from "../src/pipeline/write-image"
import type { Crop, Flip } from "../src/types"

const dir = mkdtempSync(join(tmpdir(), "lora-write-"))
const FLIPS: (Flip | null)[] = [null, "h", "v", "hv"]

/** A noisy (hard to compress, every pixel distinct) JPEG with an EXIF orientation and GPS-ish metadata. */
async function photo(
  name: string,
  w: number,
  h: number,
  orientation: number,
  subsampling: "4:4:4" | "4:2:0",
) {
  const path = join(dir, name)
  await sharp({
    create: {
      width: w,
      height: h,
      channels: 3,
      background: "#000",
      noise: { type: "gaussian", mean: 128, sigma: 50 },
    },
  })
    .withMetadata({
      orientation,
      exif: { IFD0: { Make: "TestCam", Model: "Secret Phone" } },
    })
    .jpeg({ quality: 92, chromaSubsampling: subsampling })
    .toFile(path)
  return path
}

async function pixels(img: Sharp) {
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true })
  return { data, w: info.width, h: info.height }
}

/** Max per-channel difference between two equally sized images. */
function maxDiff(a: Buffer, b: Buffer) {
  let m = 0
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]))
  return m
}

const INVERSE: Record<string, string[]> = {
  "-rotate 90": ["-rotate", "270"],
  "-rotate 270": ["-rotate", "90"],
}

/**
 * Apply the inverse jpegtran transform to the export and compare with the source's stored
 * (un-rotated) pixels. Identical DCT coefficients decode identically, so this is exact.
 */
async function undoesExactly(
  src: string,
  dest: string,
  o: number,
  flip: Flip | null,
) {
  const t = jpegtranTransform(o, flip)
  const inverse = INVERSE[t.join(" ")] ?? t
  const back = join(dir, `back-${o}-${flip}.jpg`)
  const proc = Bun.spawn([
    "jpegtran",
    ...inverse,
    "-perfect",
    "-outfile",
    back,
    dest,
  ])
  if ((await proc.exited) !== 0) return false
  const a = await pixels(sharp(src)) // no .rotate(): stored orientation
  const b = await pixels(sharp(back))
  return a.w === b.w && a.h === b.h && a.data.equals(b.data)
}

let out: string
beforeAll(() => {
  out = join(dir, "out")
  mkdirSync(out, { recursive: true })
})

describe("jpegtranTransform", () => {
  test("EXIF orientations map to the expected jpegtran operations", () => {
    expect(jpegtranTransform(1, null)).toEqual([])
    expect(jpegtranTransform(6, null)).toEqual(["-rotate", "90"])
    expect(jpegtranTransform(8, null)).toEqual(["-rotate", "270"])
    expect(jpegtranTransform(3, null)).toEqual(["-rotate", "180"])
    // Upright + both flips = 180°; orientation 2 (mirrored) + h flip = upright.
    expect(jpegtranTransform(1, "hv")).toEqual(["-rotate", "180"])
    expect(jpegtranTransform(2, "h")).toEqual([])
  })
})

describe("lossless JPEG export", () => {
  for (let o = 1; o <= 8; o++) {
    for (const flip of FLIPS) {
      test(`orientation ${o}, flip ${flip ?? "none"}: same pixels as the app shows, no metadata`, async () => {
        const src = await photo(`o${o}-${flip}.jpg`, 64, 48, o, "4:4:4")
        const r = await writeCleanImage(src, out, `o${o}-${flip}`, {
          crop: null,
          flip,
        })
        expect(r.method).toBe("jpeg-lossless")
        const dest = join(out, r.name)
        const meta = await sharp(dest).metadata()
        expect(meta.orientation).toBeUndefined()
        expect(meta.exif).toBeUndefined()
        expect(readFileSync(dest).includes(Buffer.from("Secret Phone"))).toBe(
          false,
        )

        const want = await pixels(await loadImage(src, null, flip))
        const got = await pixels(sharp(dest))
        expect([got.w, got.h]).toEqual([want.w, want.h])
        // Geometry right: only IDCT rounding differs (transposing ops swap the order of the
        // decoder's row/column passes). A wrong rotation or recompression differs by far more.
        expect(maxDiff(got.data, want.data)).toBeLessThanOrEqual(4)
        // No recompression: undoing the transform gives back the stored pixels bit for bit.
        expect(await undoesExactly(src, dest, o, flip)).toBe(true)
      })
    }
  }

  test("crops are cut losslessly and match the requested region", async () => {
    // 64×64, 4:4:4 (8 px blocks); this crop lands on block edges in every orientation.
    const crop: Crop = { x: 0.25, y: 0.125, w: 0.5, h: 0.75 }
    for (const o of [1, 6, 3, 8, 5]) {
      for (const flip of FLIPS) {
        const src = await photo(`c${o}-${flip}.jpg`, 64, 64, o, "4:4:4")
        const r = await writeCleanImage(src, out, `c${o}-${flip}`, {
          crop,
          flip,
        })
        expect(r.method).toBe("jpeg-lossless")
        const want = await pixels(await loadImage(src, crop, flip))
        const got = await pixels(sharp(join(out, r.name)))
        expect([got.w, got.h]).toEqual([want.w, want.h])
        expect(maxDiff(got.data, want.data)).toBeLessThanOrEqual(4)
      }
    }
  })

  test("crops off the block grid shrink inward, never outward", async () => {
    const src = await photo("snap.jpg", 160, 160, 6, "4:2:0") // 16 px blocks, rotated
    const crop: Crop = { x: 0.13, y: 0.21, w: 0.5, h: 0.4 }
    const r = await writeCleanImage(src, out, "snap", { crop, flip: null })
    const got = await sharp(join(out, r.name)).metadata()
    const exact = { w: Math.round(0.5 * 160), h: Math.round(0.4 * 160) }
    expect(got.width).toBeLessThanOrEqual(exact.w)
    expect(got.height).toBeLessThanOrEqual(exact.h)
    expect(exact.w - (got.width ?? 0)).toBeLessThan(16 * 2)
    expect(exact.h - (got.height ?? 0)).toBeLessThan(16 * 2)
  })

  test("sizes that can't rotate perfectly: trimmed by less than a block, or PNG", async () => {
    const src = await photo("odd.jpg", 70, 50, 6, "4:2:0") // not multiples of 16
    const trimmed = await writeCleanImage(
      src,
      out,
      "odd",
      { crop: null, flip: null },
      "trim",
    )
    expect(trimmed.method).toBe("jpeg-lossless-trimmed")
    const t = await sharp(join(out, trimmed.name)).metadata()
    // Rotated 90°: 50×70 displayed, minus less than one block per axis.
    expect(t.width).toBeGreaterThan(50 - 16)
    expect(t.width).toBeLessThanOrEqual(50)
    expect(t.height).toBeGreaterThan(70 - 16)
    expect(t.height).toBeLessThanOrEqual(70)

    const png = await writeCleanImage(
      src,
      out,
      "odd-png",
      { crop: null, flip: null },
      "png",
    )
    expect(png.method).toBe("png")
    expect(png.name).toBe("odd-png.png")
    const want = await pixels(await loadImage(src, null, null))
    const got = await pixels(sharp(join(out, png.name)))
    expect(got.data.equals(want.data)).toBe(true) // PNG is bit-exact
  })

  test("block size is read from the JPEG header", async () => {
    expect(
      jpegBlockSize(readFileSync(await photo("s444.jpg", 32, 32, 1, "4:4:4"))),
    ).toEqual({ w: 8, h: 8 })
    expect(
      jpegBlockSize(readFileSync(await photo("s420.jpg", 32, 32, 1, "4:2:0"))),
    ).toEqual({ w: 16, h: 16 })
  })
})

describe("other formats", () => {
  test("PNG: lossless, metadata dropped, flip applied", async () => {
    const src = join(dir, "p.png")
    await sharp({
      create: {
        width: 40,
        height: 30,
        channels: 3,
        background: "#000",
        noise: { type: "gaussian", mean: 128, sigma: 50 },
      },
    })
      .withMetadata({ exif: { IFD0: { Model: "Secret Phone" } } })
      .png()
      .toFile(src)
    const r = await writeCleanImage(src, out, "p", { crop: null, flip: "h" })
    expect(r.method).toBe("png")
    expect(
      readFileSync(join(out, r.name)).includes(Buffer.from("Secret Phone")),
    ).toBe(false)
    const want = await pixels(await loadImage(src, null, "h"))
    expect(
      (await pixels(sharp(join(out, r.name)))).data.equals(want.data),
    ).toBe(true)
  })

  test("WebP: written as lossless WebP", async () => {
    const src = join(dir, "w.webp")
    await sharp({
      create: {
        width: 40,
        height: 30,
        channels: 3,
        background: "#000",
        noise: { type: "gaussian", mean: 128, sigma: 50 },
      },
    })
      .webp({ quality: 80 })
      .toFile(src)
    const r = await writeCleanImage(src, out, "w", {
      crop: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 },
      flip: null,
    })
    expect(r.method).toBe("webp-lossless")
    const want = await pixels(
      await loadImage(src, { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, null),
    )
    expect(
      (await pixels(sharp(join(out, r.name)))).data.equals(want.data),
    ).toBe(true)
  })
})
