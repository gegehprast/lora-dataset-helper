import { copyFileSync, mkdirSync, rmSync } from "node:fs"
import { basename, extname, join } from "node:path"
import { paths } from "../config"
import { getSettings, listRows, toRecord } from "../db"
import type { JobContext } from "../jobs"
import { type ImageStatus, REASON_LABELS } from "../types"
import { datasetDir } from "./scan"

type ExportedStatus = Exclude<ImageStatus, "pending">

const FOLDERS: Record<ExportedStatus, string> = {
  selected: "selected",
  reserve: "reserve",
  rejected: "rejected",
}

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
  for (const r of records) {
    ctx.check()
    const folder = FOLDERS[r.status as ExportedStatus]
    // Flatten sub-folders into the file name and avoid collisions.
    let name = r.relPath.replaceAll("/", "__")
    const stem = basename(name, extname(name))
    for (let n = 2; used.has(`${folder}/${name.toLowerCase()}`); n++)
      name = `${stem}_${n}${extname(r.relPath)}`
    used.add(`${folder}/${name.toLowerCase()}`)

    copyFileSync(join(src, r.relPath), join(out, folder, name))
    if (r.status === "selected") {
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
  return `Exported ${n("selected")} selected, ${n("reserve")} reserve, ${n("rejected")} rejected to data/output/${dataset}/${
    missingCaptions
      ? ` (${missingCaptions} selected images have no caption)`
      : ""
  }`
}
