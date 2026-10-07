// scan and export against real (generated) files in the throwaway data folder.
import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readdirSync, rmSync, utimesSync } from "node:fs"
import { join } from "node:path"
import sharp from "sharp"
import { paths } from "../src/config"
import { db, listRows, setCaption } from "../src/db"
import { exportDataset } from "../src/pipeline/export"
import {
  datasetDir,
  listDatasets,
  scanDataset,
  thumbPath,
} from "../src/pipeline/scan"
import { fakeCtx, newDataset } from "./helpers"

async function writeImage(path: string, color = "#336699", size = 128) {
  mkdirSync(join(path, ".."), { recursive: true })
  await sharp({
    create: { width: size, height: size, channels: 3, background: color },
  })
    .jpeg()
    .toFile(path)
}

describe("datasetDir", () => {
  test.each(["../etc", "a/b", ".hidden", ""])("rejects %p", (name) => {
    expect(() => datasetDir(name)).toThrow("Invalid dataset name")
  })
})

describe("scan", () => {
  test("indexes images (including sub-folders), skips other files, makes thumbnails", async () => {
    const ds = newDataset("scan")
    const dir = join(paths.input, ds)
    await writeImage(join(dir, "a.jpg"))
    await writeImage(join(dir, "sub", "b.JPG"), "#993333")
    await Bun.write(join(dir, "notes.txt"), "hi")

    expect(await scanDataset(ds, fakeCtx().ctx)).toStartWith("2 images (2 new")
    const rows = listRows(ds)
    expect(rows.map((r) => r.rel_path)).toEqual(["a.jpg", "sub/b.JPG"])
    for (const r of rows) expect(existsSync(thumbPath(r.file_hash))).toBe(true)
    expect(listDatasets().find((d) => d.name === ds)?.imageCount).toBe(2)
  })

  test("unchanged files keep their analysis; changed files are reset; deleted files are removed", async () => {
    const ds = newDataset("scan")
    const dir = join(paths.input, ds)
    await writeImage(join(dir, "keep.jpg"))
    await writeImage(join(dir, "edit.jpg"))
    await writeImage(join(dir, "gone.jpg"))
    await scanDataset(ds, fakeCtx().ctx)
    db.query(
      "UPDATE images SET analysis = '{}', caption = 'c' WHERE dataset = ?",
    ).run(ds)

    await writeImage(join(dir, "edit.jpg"), "#ff0000", 140)
    utimesSync(join(dir, "edit.jpg"), new Date(), new Date(Date.now() + 5000))
    rmSync(join(dir, "gone.jpg"))
    expect(await scanDataset(ds, fakeCtx().ctx)).toBe(
      "2 images (0 new, 1 changed, 1 removed)",
    )

    const byName = Object.fromEntries(listRows(ds).map((r) => [r.rel_path, r]))
    expect(byName["keep.jpg"]!.analysis).toBe("{}")
    expect(byName["keep.jpg"]!.caption).toBe("c")
    expect(byName["edit.jpg"]!.analysis).toBeNull()
    expect(byName["edit.jpg"]!.caption).toBeNull()
    expect(byName["gone.jpg"]).toBeUndefined()
  })

  test("an unreadable file is reported, not fatal", async () => {
    const ds = newDataset("scan")
    const dir = join(paths.input, ds)
    await writeImage(join(dir, "ok.jpg"))
    await Bun.write(join(dir, "broken.jpg"), "not an image")
    expect(await scanDataset(ds, fakeCtx().ctx)).toContain("1 unreadable")
    expect(listRows(ds).map((r) => r.rel_path)).toEqual(["ok.jpg"])
  })
})

describe("export", () => {
  async function scanned() {
    const ds = newDataset("exp")
    const dir = join(paths.input, ds)
    await writeImage(join(dir, "a.jpg"))
    await writeImage(join(dir, "b.jpg"))
    await writeImage(join(dir, "sub", "a.jpg"))
    await writeImage(join(dir, "c.jpg"))
    await scanDataset(ds, fakeCtx().ctx)
    const id = (p: string) => listRows(ds).find((r) => r.rel_path === p)!.id
    const setStatus = (p: string, status: string, reasons: string[] = []) =>
      db
        .query("UPDATE images SET status = ?, reasons = ? WHERE id = ?")
        .run(status, JSON.stringify(reasons), id(p))
    return { ds, id, setStatus, out: join(paths.output, ds) }
  }

  test("copies into selected/reserve/rejected with captions and a report", async () => {
    const { ds, id, setStatus, out } = await scanned()
    setStatus("a.jpg", "selected")
    setStatus("sub/a.jpg", "selected")
    setStatus("b.jpg", "reserve", ["not_selected"])
    setStatus("c.jpg", "rejected", ["blurry_face"])
    setCaption(id("a.jpg"), "jdoe smiling", "m")

    const msg = await exportDataset(ds, fakeCtx().ctx)
    expect(msg).toContain("2 selected, 1 reserve, 1 rejected")
    expect(msg).toContain("1 selected images have no caption")
    expect(readdirSync(join(out, "selected")).sort()).toEqual([
      "a.jpg",
      "a.txt",
      "sub__a.jpg",
    ])
    expect(await Bun.file(join(out, "selected", "a.txt")).text()).toBe(
      "jdoe smiling\n",
    )
    expect(readdirSync(join(out, "reserve"))).toEqual(["b.jpg"])
    expect(readdirSync(join(out, "rejected"))).toEqual(["c.jpg"])

    const report = await Bun.file(join(out, "report.json")).json()
    expect(
      report.images.find((i: any) => i.source === "c.jpg").reasons,
    ).toEqual(["Blurry face"])
  })

  test("replaces the previous export and leaves the input untouched", async () => {
    const { ds, setStatus, out } = await scanned()
    setStatus("a.jpg", "selected")
    await exportDataset(ds, fakeCtx().ctx)
    setStatus("a.jpg", "rejected", ["manual"])
    setStatus("b.jpg", "selected")
    await exportDataset(ds, fakeCtx().ctx)
    expect(readdirSync(join(out, "selected"))).toEqual(["b.jpg"])
    expect(readdirSync(join(paths.input, ds)).sort()).toEqual([
      "a.jpg",
      "b.jpg",
      "c.jpg",
      "sub",
    ])
  })

  test("refuses when nothing is selected", async () => {
    const { ds } = await scanned()
    await expect(exportDataset(ds, fakeCtx().ctx)).rejects.toThrow(
      "Nothing selected",
    )
  })
})
