import { readdirSync, statSync } from "node:fs"
import { extname, join } from "node:path"
import sharp from "sharp"
import { IMAGE_EXTENSIONS, paths } from "../config"
import { db } from "../db"
import type { JobContext } from "../jobs"
import type { DatasetSummary } from "../types"

export function datasetDir(name: string): string {
  if (
    !name ||
    name.includes("/") ||
    name.includes("\\") ||
    name.startsWith(".")
  ) {
    throw new Error(`Invalid dataset name: ${name}`)
  }
  return join(paths.input, name)
}

export function thumbPath(hash: string) {
  return join(paths.thumbs, `${hash}.webp`)
}

function listImageFiles(dir: string): string[] {
  const out: string[] = []
  for (const rel of new Bun.Glob("**/*").scanSync({
    cwd: dir,
    onlyFiles: true,
    dot: false,
  })) {
    if (IMAGE_EXTENSIONS.has(extname(rel).toLowerCase())) out.push(rel)
  }
  return out.sort()
}

export function listDatasets(): DatasetSummary[] {
  const names = readdirSync(paths.input, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => d.name)
    .sort()
  const stats = db
    .query<
      {
        dataset: string
        total: number
        analyzed: number
        tagged: number
        selected: number
        captioned: number
      },
      []
    >(`SELECT dataset, COUNT(*) total,
       SUM(analysis IS NOT NULL) analyzed,
       SUM(tags IS NOT NULL) tagged,
       SUM(status = 'selected') selected,
       SUM(status = 'selected' AND caption IS NOT NULL AND caption != '') captioned
     FROM images GROUP BY dataset`)
    .all()
  const byName = new Map(stats.map((s) => [s.dataset, s]))
  return names.map((name) => {
    const s = byName.get(name)
    return {
      name,
      imageCount: s?.total ?? listImageFiles(join(paths.input, name)).length,
      analyzed: s?.analyzed ?? 0,
      tagged: s?.tagged ?? 0,
      selected: s?.selected ?? 0,
      captioned: s?.captioned ?? 0,
    }
  })
}

async function hashFile(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha1")
  hasher.update(await Bun.file(path).arrayBuffer())
  return hasher.digest("hex")
}

export async function makeThumbnail(src: string, hash: string) {
  const dest = thumbPath(hash)
  if (await Bun.file(dest).exists()) return
  await sharp(src)
    .rotate()
    .resize(512, 512, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 80 })
    .toFile(dest)
}

/** Sync the DB with the files in data/input/<dataset>. Changed files lose their cached analysis. */
export async function scanDataset(dataset: string, ctx: JobContext) {
  const dir = datasetDir(dataset)
  const files = listImageFiles(dir)
  ctx.stage("Scanning files", files.length)

  const existing = new Map(
    db
      .query<
        {
          id: number
          rel_path: string
          size: number
          mtime: number
          file_hash: string
        },
        [string]
      >(
        "SELECT id, rel_path, size, mtime, file_hash FROM images WHERE dataset = ?",
      )
      .all(dataset)
      .map((r) => [r.rel_path, r]),
  )

  const insert = db.query(
    "INSERT INTO images (dataset, rel_path, file_hash, size, mtime) VALUES (?, ?, ?, ?, ?)",
  )
  const reset =
    db.query(`UPDATE images SET file_hash = ?, size = ?, mtime = ?, width = NULL, height = NULL,
    analysis = NULL, clip_emb = NULL, face_embs = NULL, tags = NULL, tags_model = NULL, status = 'pending',
    score = NULL, reasons = '[]', framing = NULL, dup_of = NULL, identity = NULL, main_face = NULL,
    caption = NULL, caption_model = NULL WHERE id = ?`)

  let added = 0
  let changed = 0
  const failed: string[] = []
  for (const rel of files) {
    ctx.check()
    const abs = join(dir, rel)
    const st = statSync(abs)
    const prev = existing.get(rel)
    existing.delete(rel)
    try {
      if (prev && prev.size === st.size && prev.mtime === st.mtimeMs) {
        await makeThumbnail(abs, prev.file_hash)
      } else {
        const hash = await hashFile(abs)
        await makeThumbnail(abs, hash)
        if (!prev) {
          insert.run(dataset, rel, hash, st.size, st.mtimeMs)
          added++
        } else if (prev.file_hash !== hash) {
          reset.run(hash, st.size, st.mtimeMs, prev.id)
          changed++
        } else {
          db.query("UPDATE images SET mtime = ? WHERE id = ?").run(
            st.mtimeMs,
            prev.id,
          )
        }
      }
    } catch (e) {
      failed.push(`${rel}: ${(e as Error).message}`)
    }
    ctx.tick()
  }

  // Whatever is left in `existing` was deleted from disk.
  const del = db.query("DELETE FROM images WHERE id = ?")
  for (const gone of existing.values()) del.run(gone.id)

  if (failed.length)
    console.warn(
      `[scan ${dataset}] unreadable files:\n  ${failed.join("\n  ")}`,
    )
  return `${files.length} images (${added} new, ${changed} changed, ${existing.size} removed${failed.length ? `, ${failed.length} unreadable` : ""})`
}
