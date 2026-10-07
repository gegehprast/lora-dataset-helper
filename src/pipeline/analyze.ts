import { join } from "node:path"
import { cropFromJson } from "../crop"
import { db } from "../db"
import type { JobContext } from "../jobs"
import { type PythonWorker, type WorkerAnalysis, worker } from "../worker"
import { datasetDir } from "./scan"

const BATCH = 8

type Row = { id: number; rel_path: string; crop: string | null }
type WorkerClient = Pick<PythonWorker, "call">

/**
 * Analyze rows through the worker (cropped region if cropped) and store the results.
 * Returns the number of images that failed.
 */
export async function analyzeRows(
  dir: string,
  rows: Row[],
  opts: {
    client?: WorkerClient
    onBatch?: (n: number) => void
    check?: () => void
  } = {},
): Promise<number> {
  const client = opts.client ?? worker
  const save = db.query(
    "UPDATE images SET analysis = ?, clip_emb = ?, face_embs = ?, width = ?, height = ? WHERE id = ?",
  )
  let errors = 0
  for (let i = 0; i < rows.length; i += BATCH) {
    opts.check?.()
    const batch = rows.slice(i, i + BATCH)
    const results = await client.call<WorkerAnalysis[]>("analyze", {
      paths: batch.map((r) => join(dir, r.rel_path)),
      crops: batch.map((r) => {
        const c = cropFromJson(r.crop)
        return c ? [c.x, c.y, c.w, c.h] : null
      }),
    })
    db.transaction(() => {
      results.forEach((r, j) => {
        const row = batch[j]
        if (r.error) {
          errors++
          save.run(
            JSON.stringify({ error: r.error }),
            null,
            null,
            null,
            null,
            row.id,
          )
          return
        }
        const { clip, faces, ...rest } = r
        const analysis = {
          ...rest,
          faces: faces.map(({ embedding: _e, ...f }) => f),
        }
        const faceEmbs = faces.length
          ? Buffer.concat(faces.map((f) => Buffer.from(f.embedding, "base64")))
          : null
        save.run(
          JSON.stringify(analysis),
          Buffer.from(clip, "base64"),
          faceEmbs,
          r.width,
          r.height,
          row.id,
        )
      })
    })()
    opts.onBatch?.(batch.length)
  }
  return errors
}

/** Run local metrics (sharpness, exposure, faces, CLIP, aesthetic) for every image not analyzed yet. */
export async function analyzeDataset(dataset: string, ctx: JobContext) {
  const dir = datasetDir(dataset)
  const todo = db
    .query<Row, [string]>(
      "SELECT id, rel_path, crop FROM images WHERE dataset = ? AND analysis IS NULL ORDER BY rel_path",
    )
    .all(dataset)
  if (!todo.length) return "Everything already analyzed"

  ctx.stage("Loading local models", 0)
  type Info = {
    device: string
    faceProviders: string[]
    fallback: string | null
  }
  const info = await worker.call<Info>("load")
  ctx.stage(`Analyzing locally (${info.device})`, todo.length)
  const errors = await analyzeRows(dir, todo, {
    onBatch: (n) => ctx.tick(n),
    check: () => ctx.check(),
  })
  // The worker switches to the CPU by itself if the GPU runs out of memory; say so.
  const after = await worker.call<Info>("load")
  const notes = [
    errors ? `${errors} failed` : "",
    after.fallback ? `ran on the CPU: ${after.fallback}` : "",
  ].filter(Boolean)
  return `Analyzed ${todo.length} images${notes.length ? ` (${notes.join("; ")})` : ""}`
}
