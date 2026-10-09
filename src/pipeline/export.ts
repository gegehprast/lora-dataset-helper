import { mkdirSync, rmSync } from "node:fs"
import { basename, extname, join } from "node:path"
import { paths } from "../config"
import { getSettings, listRows, toRecord } from "../db"
import type { JobContext } from "../jobs"
import { type ImageStatus, REASON_LABELS } from "../types"
import { datasetDir } from "./scan"
import { type WriteResult, writeCleanImage } from "./write-image"

type ExportedStatus = Exclude<ImageStatus, "pending">

const FOLDERS: Record<ExportedStatus, string> = {
  selected: "selected",
  reserve: "reserve",
  rejected: "rejected",
}

/**
 * Write images into data/output/<dataset>/{selected,reserve,rejected}, without metadata and
 * with EXIF rotation, flip and crop applied losslessly (see write-image.ts). Selected images
 * get a same-named .txt caption (kohya / ai-toolkit / OneTrainer convention).
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

  const settings = getSettings(dataset)
  const methods: Record<string, number> = {}
  ctx.stage("Writing files", records.length)
  const used = new Set<string>()
  const report = []
  let missingCaptions = 0
  let staleCaptions = 0
  for (const r of records) {
    ctx.check()
    const folder = FOLDERS[r.status as ExportedStatus]
    // Flatten sub-folders into the file name; stems must be unique per folder because
    // the caption is <stem>.txt whatever the image's extension.
    const flat = r.relPath.replaceAll("/", "__")
    const base = basename(flat, extname(flat))
    let stem = base
    for (let n = 2; used.has(`${folder}/${stem.toLowerCase()}`); n++)
      stem = `${base}_${n}`
    used.add(`${folder}/${stem.toLowerCase()}`)

    const written: WriteResult = await writeCleanImage(
      join(src, r.relPath),
      join(out, folder),
      stem,
      { crop: r.crop, flip: r.flip },
      settings.exportJpegImperfect,
    )
    methods[written.method] = (methods[written.method] ?? 0) + 1
    const name = written.name
    if (r.status === "selected") {
      if (r.captionStale && r.caption?.trim()) staleCaptions++
      if (r.caption?.trim())
        await Bun.write(
          join(out, folder, `${stem}.txt`),
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
      flip: r.flip ?? undefined,
      method: written.method,
      note: written.note,
      caption: r.status === "selected" ? r.caption : undefined,
    })
    ctx.tick()
  }

  const s = settings
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
    methods["jpeg-lossless-trimmed"] &&
      `${methods["jpeg-lossless-trimmed"]} JPEGs trimmed by < 16 px to rotate losslessly`,
    methods.png && `${methods.png} saved as PNG`,
    missingCaptions && `${missingCaptions} selected images have no caption`,
    staleCaptions &&
      `${staleCaptions} captions were written before the image was cropped or flipped`,
  ].filter(Boolean)
  return `Exported ${n("selected")} selected, ${n("reserve")} reserve, ${n("rejected")} rejected to data/output/${dataset}/${
    notes.length ? ` (${notes.join("; ")})` : ""
  }`
}
