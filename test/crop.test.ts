import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import sharp, { type Sharp } from "sharp"
import { paths } from "../src/config"
import { cropKey, cropPixels, loadImage, parseCrop } from "../src/crop"
import {
  db,
  getRow,
  listRows,
  saveSettings,
  setCaption,
  thumbId,
  toRecord,
} from "../src/db"
import { setImageCrop } from "../src/pipeline/cropping"
import { exportDataset } from "../src/pipeline/export"
import { scanDataset, thumbPath } from "../src/pipeline/scan"
import { reviewSingleImage } from "../src/pipeline/tag"
import { clearModelCache, imageDataUrl } from "../src/venice"
import {
  chatReply,
  fakeCtx,
  json,
  mockFetch,
  modelsPayload,
  newDataset,
  tags,
} from "./helpers"

/**
 * A 400×200 JPEG stored sideways (EXIF orientation 6 = rotate 90° clockwise to display).
 * Stored left half red, right half blue → displayed 200×400, top half red, bottom blue.
 */
async function sidewaysImage(path: string) {
  const red = { r: 255, g: 0, b: 0 }
  const blue = { r: 0, g: 0, b: 255 }
  const half = (c: typeof red) =>
    sharp({ create: { width: 200, height: 200, channels: 3, background: c } })
      .png()
      .toBuffer()
  await sharp({
    create: { width: 400, height: 200, channels: 3, background: red },
  })
    .composite([{ input: await half(blue), left: 200, top: 0 }])
    .withMetadata({ orientation: 6 })
    .jpeg({ quality: 95 })
    .toFile(path)
}

async function centerColor(img: Sharp) {
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true })
  const i =
    (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) *
    info.channels
  return {
    r: data[i],
    g: data[i + 1],
    b: data[i + 2],
    w: info.width,
    h: info.height,
  }
}

describe("parseCrop", () => {
  test("clamps to the image and rounds", () => {
    expect(parseCrop({ x: -0.1, y: 0.5, w: 0.5, h: 0.9 })).toEqual({
      x: 0,
      y: 0.5,
      w: 0.5,
      h: 0.5,
    })
  })
  test("whole image = no crop; null = no crop", () => {
    expect(parseCrop({ x: 0, y: 0, w: 1, h: 1 })).toBeNull()
    expect(parseCrop(null)).toBeNull()
  })
  test("rejects tiny and malformed crops", () => {
    expect(() => parseCrop({ x: 0, y: 0, w: 0.001, h: 0.5 })).toThrow(
      "too small",
    )
    expect(() => parseCrop({ x: "1", y: 0, w: 1, h: 1 })).toThrow("numeric")
  })
})

test("cropPixels stays inside the image", () => {
  expect(cropPixels({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, 101, 101)).toEqual({
    left: 51,
    top: 51,
    width: 50,
    height: 50,
  })
})

test("cropKey is stable and differs per crop", () => {
  const a = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }
  expect(cropKey(a)).toBe(cropKey({ ...a }))
  expect(cropKey(a)).not.toBe(cropKey({ ...a, x: 0.11 }))
})

describe("loadImage", () => {
  const dir = join(paths.cache, "crop-test")
  mkdirSync(dir, { recursive: true })
  const file = join(dir, "sideways.jpg")

  test("crop coordinates refer to the EXIF-rotated image", async () => {
    await sidewaysImage(file)
    const top = await centerColor(
      await loadImage(file, { x: 0, y: 0, w: 1, h: 0.5 }),
    )
    expect([top.w, top.h]).toEqual([200, 200])
    expect(top.r).toBeGreaterThan(200)
    expect(top.b).toBeLessThan(60)
    const bottom = await centerColor(
      await loadImage(file, { x: 0, y: 0.5, w: 1, h: 0.5 }),
    )
    expect(bottom.b).toBeGreaterThan(200)
  })

  test("the image sent to Venice is the cropped region", async () => {
    await sidewaysImage(file)
    const url = await imageDataUrl(file, { x: 0, y: 0.5, w: 1, h: 0.5 })
    const c = await centerColor(sharp(Buffer.from(url.split(",")[1], "base64")))
    expect([c.w, c.h]).toEqual([200, 200])
    expect(c.b).toBeGreaterThan(200)
  })
})

/** A scanned dataset with one sideways image, and a fake worker recording the crops it gets. */
async function cropDataset() {
  const ds = newDataset("crop")
  const dir = join(paths.input, ds)
  mkdirSync(dir, { recursive: true })
  await sidewaysImage(join(dir, "a.jpg"))
  await scanDataset(ds, fakeCtx().ctx)
  const id = listRows(ds)[0].id
  const seen: unknown[] = []
  const client = {
    call: async <T>(_op: string, args: Record<string, unknown> = {}) => {
      seen.push(args.crops)
      return [
        {
          width: 200,
          height: 200,
          sharpness: 100,
          brightness: 120,
          darkClip: 0,
          brightClip: 0,
          phash: "0000000000000000",
          aesthetic: 5,
          clip: Buffer.from(new Float32Array(768).buffer).toString("base64"),
          faces: [],
        },
      ] as T
    },
  }
  return { ds, id, client, seen }
}

describe("setImageCrop", () => {
  test("re-analyzes the cropped region and drops review data; caption becomes outdated", async () => {
    const { id, client, seen } = await cropDataset()
    db.query(
      "UPDATE images SET tags = ?, tags_model = 'm', outfit_group = 'x' WHERE id = ?",
    ).run(JSON.stringify(tags()), id)
    setCaption(id, "jdoe smiling", "m")

    const r = await setImageCrop(id, { x: 0, y: 0, w: 1, h: 0.5 }, { client })
    expect(r).toEqual({ changed: true, warning: null })
    expect(seen).toEqual([[[0, 0, 1, 0.5]]])

    const row = getRow(id)!
    expect(row.tags).toBeNull()
    expect(row.outfit_group).toBeNull()
    expect(row.analysis).not.toBeNull()
    const rec = toRecord(row)
    expect(rec.crop).toEqual({ x: 0, y: 0, w: 1, h: 0.5 })
    expect(rec.captionStale).toBe(true)
    expect(rec.caption).toBe("jdoe smiling")
    expect(existsSync(thumbPath(thumbId(row)))).toBe(true)
    expect(rec.thumb).toContain("-")

    // Saving or regenerating the caption clears the flag.
    setCaption(id, "jdoe, close-up", "m")
    expect(toRecord(getRow(id)!).captionStale).toBe(false)
  })

  test("an unchanged crop does nothing; null removes the crop", async () => {
    const { id, client } = await cropDataset()
    await setImageCrop(id, { x: 0, y: 0, w: 1, h: 0.5 }, { client })
    expect(
      (await setImageCrop(id, { x: 0, y: 0, w: 1, h: 0.5 }, { client }))
        .changed,
    ).toBe(false)
    await setImageCrop(id, null, { client })
    expect(getRow(id)?.crop).toBeNull()
    expect(toRecord(getRow(id)!).thumb).not.toContain("-")
  })

  test("a worker failure still saves the crop, with a warning", async () => {
    const { id } = await cropDataset()
    const failing = {
      call: async () => {
        throw new Error("Python worker is not set up")
      },
    }
    const r = await setImageCrop(
      id,
      { x: 0.1, y: 0.1, w: 0.5, h: 0.5 },
      { client: failing },
    )
    expect(r.warning).toContain("Run Scan & analyze")
    expect(getRow(id)?.crop).not.toBeNull()
    expect(getRow(id)?.analysis).toBeNull()
  })

  test("changing the file clears its crop", async () => {
    const { ds, id, client } = await cropDataset()
    await setImageCrop(id, { x: 0, y: 0, w: 1, h: 0.5 }, { client })
    const file = join(paths.input, ds, "a.jpg")
    await sharp({
      create: { width: 64, height: 64, channels: 3, background: "#0f0" },
    })
      .jpeg()
      .toFile(file)
    await scanDataset(ds, fakeCtx().ctx)
    expect(getRow(id)?.crop).toBeNull()
  })
})

describe("export with crops", () => {
  test("cropped images are cut from the original pixels; others are copied unchanged", async () => {
    const { ds, id, client } = await cropDataset()
    const dir = join(paths.input, ds)
    await sharp({
      create: { width: 64, height: 48, channels: 3, background: "#777" },
    })
      .png()
      .toFile(join(dir, "b.png"))
    await scanDataset(ds, fakeCtx().ctx)
    await setImageCrop(id, { x: 0, y: 0.5, w: 1, h: 0.5 }, { client })
    db.query("UPDATE images SET status = 'selected' WHERE dataset = ?").run(ds)

    await exportDataset(ds, fakeCtx().ctx)
    const out = join(paths.output, ds, "selected")
    const cropped = await centerColor(sharp(join(out, "a.jpg")))
    expect([cropped.w, cropped.h]).toEqual([200, 200])
    expect(cropped.b).toBeGreaterThan(200)
    expect(
      readFileSync(join(out, "b.png")).equals(readFileSync(join(dir, "b.png"))),
    ).toBe(true)
  })
})

describe("single-image review", () => {
  let mock: ReturnType<typeof mockFetch> | null = null
  afterEach(() => {
    mock?.restore()
    clearModelCache()
  })

  test("sends only the cropped region and stores the review", async () => {
    const { ds, id, client } = await cropDataset()
    await setImageCrop(id, { x: 0, y: 0, w: 1, h: 0.5 }, { client })
    saveSettings(ds, { tagModel: "priv" })
    mock = mockFetch((url) =>
      url.endsWith("/models?type=text")
        ? json(modelsPayload([{ id: "priv" }]))
        : chatReply(JSON.stringify(tags({ framing: "closeup" }))),
    )
    await reviewSingleImage(id)
    const chat = mock.calls.find((c) => c.url.endsWith("/chat/completions"))!
    const url: string = chat.body.messages[1].content[1].image_url.url
    const sent = await centerColor(
      sharp(Buffer.from(url.split(",")[1], "base64")),
    )
    expect([sent.w, sent.h]).toEqual([200, 200])
    expect(sent.r).toBeGreaterThan(200)
    expect(toRecord(getRow(id)!).tags?.framing).toBe("closeup")
  })

  test("refused for Local only datasets", async () => {
    const { ds, id, client } = await cropDataset()
    await setImageCrop(id, { x: 0, y: 0, w: 1, h: 0.5 }, { client })
    saveSettings(ds, { localOnly: true })
    mock = mockFetch(() => json({}))
    await expect(reviewSingleImage(id)).rejects.toThrow("Local only")
    expect(mock.calls).toHaveLength(0)
  })
})
