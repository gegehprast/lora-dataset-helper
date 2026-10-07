import { copyFileSync, mkdirSync, rmSync } from "node:fs"
import { basename, extname, join } from "node:path"
import { paths } from "../config"
import { loadImage } from "../crop"
import { getSettings, listRows, toRecord } from "../db"
import type { JobContext } from "../jobs"
import { type Crop, type ImageStatus, REASON_LABELS } from "../types"
import { datasetDir } from "./scan"

type ExportedStatus = Exclude<ImageStatus, "pending">

const FOLDERS: Record<ExportedStatus, string> = {
  selected: "selected",
  reserve: "reserve",
  rejected: "rejected",
}

/**
 * Uncropped images are copied byte for byte. Cropped ones are cut from the original pixels
 * (no resizing) and re-encoded in the source format: JPEG/WebP at quality 95, PNG lossless.
 */
async function writeImage(source: string, dest: string, crop: Crop | null) {
  if (!crop) {
    copyFileSync(source, dest)
    return
  }
  const img = await loadImage(source, crop)
  const ext = extname(dest).toLowerCase()
  if (ext === ".png") await img.png().toFile(dest)
  else if (ext === ".webp") await img.webp({ quality: 95 }).toFile(dest)
  else if (ext === ".jpg" || ext === ".jpeg")
    await img.jpeg({ quality: 95, chromaSubsampling: "4:4:4" }).toFile(dest)
  else await img.png().toFile(dest)
}

const ENCODABLE = new Set([".jpg", ".jpeg", ".png", ".webp"])

/**
 * Copy images into data/output/<dataset>/{selected,reserve,rejected}. Selected images get a
 * same-named .txt caption next to them (kohya / ai-toolkit / OneTrainer convention).
 * Input files are never modified. Previous export folders for this dataset are replaced.
 */
export async function exportDataset(dataset: string, ctx: JobContext) {
  const src = datasetDir(dataset)
  const out = join(paths.output, dataset)
  const records = listRows(dataset)
    .map(toRecord)
    .filter((r) => r.status !== "pending")
  if (!records.some((r) => r.status === "selected"))
    throw new Error("Nothing selected yet. Run the selection first.")

  for (const folder of Object.values(FOLDERS)) {
    rmSync(join(out, folder), { recursive: true, force: true })
    mkdirSync(join(out, folder), { recursive: true })
  }

  ctx.stage("Copying files", records.length)
  const used = new Set<string>()
  const report = []
  let missingCaptions = 0
  let staleCaptions = 0
  for (const r of records) {
    ctx.check()
    const folder = FOLDERS[r.status as ExportedStatus]
    // Flatten sub-folders into the file name and avoid collisions.
    let name = r.relPath.replaceAll("/", "__")
    // Cropped images are re-encoded; formats sharp can't write keep their pixels as PNG.
    if (r.crop && !ENCODABLE.has(extname(name).toLowerCase()))
      name = `${name.slice(0, -extname(name).length)}.png`
    const stem = basename(name, extname(name))
    for (let n = 2; used.has(`${folder}/${name.toLowerCase()}`); n++)
      name = `${stem}_${n}${extname(name)}`
    used.add(`${folder}/${name.toLowerCase()}`)

    await writeImage(join(src, r.relPath), join(out, folder, name), r.crop)
    if (r.status === "selected") {
      if (r.captionStale && r.caption?.trim()) staleCaptions++
      if (r.caption?.trim())
        await Bun.write(
          join(out, folder, `${basename(name, extname(name))}.txt`),
          `${r.caption.trim()}\n`,
        )
      else missingCaptions++
    }
    report.push({
      file: `${folder}/${name}`,
      source: r.relPath,
      status: r.status,
      score: r.score != null ? Math.round(r.score * 1000) / 1000 : null,
      reasons: r.reasons.map((x) => REASON_LABELS[x] ?? x),
      framing: r.framing,
      crop: r.crop ?? undefined,
      caption: r.status === "selected" ? r.caption : undefined,
    })
    ctx.tick()
  }

  const s = getSettings(dataset)
  await Bun.write(
    join(out, "report.json"),
    JSON.stringify(
      {
        dataset,
        exportedAt: new Date().toISOString(),
        triggerWord: s.triggerWord,
        settings: s,
        images: report,
      },
      null,
      2,
    ),
  )

  const n = (st: ImageStatus) => records.filter((r) => r.status === st).length
  const notes = [
    missingCaptions && `${missingCaptions} selected images have no caption`,
    staleCaptions &&
      `${staleCaptions} captions were written before the image was cropped`,
  ].filter(Boolean)
  return `Exported ${n("selected")} selected, ${n("reserve")} reserve, ${n("rejected")} rejected to data/output/${dataset}/${
    notes.length ? ` (${notes.join("; ")})` : ""
  }`
}
