import { join } from "node:path"
import { cropJson, parseCrop } from "../crop"
import { db, getRow } from "../db"
import type { PythonWorker } from "../worker"
import { analyzeRows } from "./analyze"
import { datasetDir, makeThumbnail } from "./scan"
import { runSelection } from "./select"

/**
 * Set or remove (null) an image's crop. Everything derived from the old pixels is discarded:
 * the local analysis is redone for the cropped region, the AI review is dropped (the next
 * review run or the image's Review button redoes it), and an existing caption is flagged as
 * outdated rather than overwritten.
 *
 * Returns a warning if the crop was saved but couldn't be analyzed right away.
 */
export async function setImageCrop(
  id: number,
  value: unknown,
  opts: { analyze?: boolean; client?: Pick<PythonWorker, "call"> } = {},
): Promise<{ changed: boolean; warning: string | null }> {
  const row = getRow(id)
  if (!row) throw new Error(`Image ${id} not found`)
  const crop = cropJson(parseCrop(value))
  if (crop === row.crop) return { changed: false, warning: null }

  db.query(
    `UPDATE images SET crop = ?,
       analysis = NULL, clip_emb = NULL, face_embs = NULL, width = NULL, height = NULL,
       tags = NULL, tags_model = NULL, outfit_group = NULL,
       status = 'pending', score = NULL, reasons = '[]', framing = NULL, dup_of = NULL,
       identity = NULL, main_face = NULL,
       caption_stale = CASE WHEN caption IS NOT NULL AND caption != '' THEN 1 ELSE 0 END
     WHERE id = ?`,
  ).run(crop, id)

  const dir = datasetDir(row.dataset)
  await makeThumbnail(join(dir, row.rel_path), {
    file_hash: row.file_hash,
    crop,
  })

  let warning: string | null = null
  if (opts.analyze ?? true) {
    try {
      const failed = await analyzeRows(
        dir,
        [{ id, rel_path: row.rel_path, crop }],
        { client: opts.client },
      )
      if (failed)
        warning = "Crop saved, but the cropped image couldn't be analyzed."
    } catch (e) {
      warning = `Crop saved, but local analysis failed (${(e as Error).message}). Run Scan & analyze.`
    }
  }
  runSelection(row.dataset)
  return { changed: true, warning }
}
