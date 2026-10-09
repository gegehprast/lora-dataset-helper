import { join } from "node:path"
import {
  cropFromJson,
  cropJson,
  flipFromDb,
  mirrorCrop,
  parseCrop,
  parseFlip,
} from "../crop"
import { db, getRow, type ImageRow } from "../db"
import type { Flip } from "../types"
import type { PythonWorker } from "../worker"
import { analyzeRows } from "./analyze"
import { datasetDir, makeThumbnail } from "./scan"
import { runSelection } from "./select"

type Client = Pick<PythonWorker, "call">
type Result = { changed: boolean; warning: string | null }

/**
 * Store a new crop/flip and discard what was derived from the old pixels: the local analysis
 * is redone right away, and an existing caption is flagged as outdated (never overwritten).
 * The AI review is dropped unless `keepReview` (a horizontal flip doesn't change framing,
 * quality, outfit or issues).
 */
async function applyEdit(
  row: ImageRow,
  crop: string | null,
  flip: Flip | null,
  keepReview: boolean,
  opts: { analyze?: boolean; client?: Client },
): Promise<Result> {
  db.query(
    `UPDATE images SET crop = ?, flip = ?,
       analysis = NULL, clip_emb = NULL, face_embs = NULL, width = NULL, height = NULL,
       ${keepReview ? "" : "tags = NULL, tags_model = NULL, outfit_group = NULL,"}
       status = 'pending', score = NULL, reasons = '[]', framing = NULL, dup_of = NULL,
       identity = NULL, main_face = NULL,
       caption_stale = CASE WHEN caption IS NOT NULL AND caption != '' THEN 1 ELSE 0 END
     WHERE id = ?`,
  ).run(crop, flip, row.id)

  const dir = datasetDir(row.dataset)
  await makeThumbnail(join(dir, row.rel_path), {
    file_hash: row.file_hash,
    crop,
    flip,
  })

  let warning: string | null = null
  if (opts.analyze ?? true) {
    try {
      const failed = await analyzeRows(
        dir,
        [{ id: row.id, rel_path: row.rel_path, crop, flip }],
        { client: opts.client },
      )
      if (failed) warning = "Saved, but the edited image couldn't be analyzed."
    } catch (e) {
      warning = `Saved, but local analysis failed (${(e as Error).message}). Run Scan & analyze.`
    }
  }
  runSelection(row.dataset)
  return { changed: true, warning }
}

/**
 * Set or remove (null) an image's crop. Coordinates refer to the image as displayed (after
 * EXIF rotation and any flip). Returns a warning if it couldn't be analyzed right away.
 */
export async function setImageCrop(
  id: number,
  value: unknown,
  opts: { analyze?: boolean; client?: Client } = {},
): Promise<Result> {
  const row = getRow(id)
  if (!row) throw new Error(`Image ${id} not found`)
  const crop = cropJson(parseCrop(value))
  if (crop === row.crop) return { changed: false, warning: null }
  return applyEdit(row, crop, flipFromDb(row.flip), false, opts)
}

/**
 * Set or remove (null) an image's flip. An existing crop is mirrored so it keeps covering the
 * same part of the picture.
 */
export async function setImageFlip(
  id: number,
  value: unknown,
  opts: { analyze?: boolean; client?: Client } = {},
): Promise<Result> {
  const row = getRow(id)
  if (!row) throw new Error(`Image ${id} not found`)
  const next = parseFlip(value)
  const prev = flipFromDb(row.flip)
  if (next === prev) return { changed: false, warning: null }

  const toggledH = (prev ?? "").includes("h") !== (next ?? "").includes("h")
  const toggledV = (prev ?? "").includes("v") !== (next ?? "").includes("v")
  let crop = cropFromJson(row.crop)
  if (crop && toggledH) crop = mirrorCrop(crop, "h")
  if (crop && toggledV) crop = mirrorCrop(crop, "v")
  // Mirroring left/right keeps the review valid; turning the picture upside down doesn't.
  return applyEdit(row, cropJson(crop), next, !toggledV, opts)
}
