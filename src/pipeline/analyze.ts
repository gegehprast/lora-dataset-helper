import { join } from "node:path";
import { db } from "../db";
import type { JobContext } from "../jobs";
import { worker, type WorkerAnalysis } from "../worker";
import { datasetDir } from "./scan";

const BATCH = 8;

/** Run local metrics (sharpness, exposure, faces, CLIP, aesthetic) for every image not analyzed yet. */
export async function analyzeDataset(dataset: string, ctx: JobContext) {
  const dir = datasetDir(dataset);
  const todo = db
    .query<{ id: number; rel_path: string }, [string]>(
      "SELECT id, rel_path FROM images WHERE dataset = ? AND analysis IS NULL ORDER BY rel_path",
    )
    .all(dataset);
  if (!todo.length) return "Everything already analyzed";

  ctx.stage("Loading local models", 0);
  const info = await worker.call<{ device: string; faceProviders: string[] }>("load");
  ctx.stage(`Analyzing locally (${info.device})`, todo.length);

  const save = db.query(
    "UPDATE images SET analysis = ?, clip_emb = ?, face_embs = ?, width = ?, height = ? WHERE id = ?",
  );
  let errors = 0;
  for (let i = 0; i < todo.length; i += BATCH) {
    ctx.check();
    const batch = todo.slice(i, i + BATCH);
    const results = await worker.call<WorkerAnalysis[]>("analyze", { paths: batch.map((r) => join(dir, r.rel_path)) });
    db.transaction(() => {
      results.forEach((r, j) => {
        const row = batch[j]!;
        if (r.error) {
          errors++;
          save.run(JSON.stringify({ error: r.error }), null, null, null, null, row.id);
          return;
        }
        const { clip, faces, ...rest } = r;
        const analysis = { ...rest, faces: faces.map(({ embedding: _e, ...f }) => f) };
        const faceEmbs = faces.length ? Buffer.concat(faces.map((f) => Buffer.from(f.embedding, "base64"))) : null;
        save.run(JSON.stringify(analysis), Buffer.from(clip, "base64"), faceEmbs, r.width, r.height, row.id);
      });
    })();
    ctx.tick(batch.length);
  }
  return `Analyzed ${todo.length} images${errors ? ` (${errors} failed)` : ""}`;
}
