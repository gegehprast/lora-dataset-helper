import { Database } from "bun:sqlite";
import { paths } from "./config";
import {
  DEFAULT_SETTINGS,
  type Analysis,
  type Framing,
  type ImageRecord,
  type ImageStatus,
  type Override,
  type Settings,
  type VisionTags,
} from "./types";

export const db = new Database(paths.db, { create: true, strict: true });
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA foreign_keys = ON");

db.run(`CREATE TABLE IF NOT EXISTS datasets (
  name TEXT PRIMARY KEY,
  settings TEXT NOT NULL DEFAULT '{}'
)`);

db.run(`CREATE TABLE IF NOT EXISTS images (
  id INTEGER PRIMARY KEY,
  dataset TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  file_hash TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime REAL NOT NULL,
  width INTEGER,
  height INTEGER,
  analysis TEXT,
  clip_emb BLOB,
  face_embs BLOB,
  tags TEXT,
  tags_model TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  score REAL,
  reasons TEXT NOT NULL DEFAULT '[]',
  framing TEXT,
  dup_of INTEGER,
  identity REAL,
  main_face INTEGER,
  override TEXT,
  caption TEXT,
  caption_model TEXT,
  UNIQUE(dataset, rel_path)
)`);
db.run("CREATE INDEX IF NOT EXISTS images_dataset ON images(dataset)");

/** Raw row shape. */
export interface ImageRow {
  id: number;
  dataset: string;
  rel_path: string;
  file_hash: string;
  size: number;
  mtime: number;
  width: number | null;
  height: number | null;
  analysis: string | null;
  clip_emb: Uint8Array | null;
  face_embs: Uint8Array | null;
  tags: string | null;
  tags_model: string | null;
  status: ImageStatus;
  score: number | null;
  reasons: string;
  framing: Framing | null;
  dup_of: number | null;
  identity: number | null;
  main_face: number | null;
  override: Override;
  caption: string | null;
  caption_model: string | null;
}

// ---------- datasets ----------

function storedSettings(dataset: string): Partial<Settings> {
  const row = db.query<{ settings: string }, [string]>("SELECT settings FROM datasets WHERE name = ?").get(dataset);
  return row ? (JSON.parse(row.settings) as Partial<Settings>) : {};
}

/** Stored values over the current defaults. */
export function getSettings(dataset: string): Settings {
  const stored = storedSettings(dataset);
  return { ...DEFAULT_SETTINGS, ...stored, framingMix: { ...DEFAULT_SETTINGS.framingMix, ...stored.framingMix } };
}

/**
 * Persists only values that differ from the defaults, so a dataset keeps following the defaults
 * (e.g. a new default model) for everything the user never changed.
 */
export function saveSettings(dataset: string, patch: Partial<Settings>): Settings {
  const merged: Record<string, unknown> = { ...storedSettings(dataset), ...patch };
  for (const key of Object.keys(merged)) {
    const isDefault = JSON.stringify(merged[key]) === JSON.stringify(DEFAULT_SETTINGS[key as keyof Settings]);
    if (!(key in DEFAULT_SETTINGS) || isDefault) delete merged[key];
  }
  db.query("INSERT INTO datasets (name, settings) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET settings = excluded.settings").run(
    dataset,
    JSON.stringify(merged),
  );
  return getSettings(dataset);
}

// ---------- images ----------

export function listRows(dataset: string): ImageRow[] {
  return db.query<ImageRow, [string]>("SELECT * FROM images WHERE dataset = ? ORDER BY rel_path").all(dataset);
}

export function getRow(id: number): ImageRow | null {
  return db.query<ImageRow, [number]>("SELECT * FROM images WHERE id = ?").get(id);
}

export function parseAnalysis(row: ImageRow): Analysis | null {
  return row.analysis ? (JSON.parse(row.analysis) as Analysis) : null;
}

export function parseTags(row: ImageRow): VisionTags | null {
  return row.tags ? (JSON.parse(row.tags) as VisionTags) : null;
}

export function toFloat32(blob: Uint8Array | null): Float32Array | null {
  if (!blob) return null;
  // Copy so the view is aligned regardless of the source buffer's offset.
  return new Float32Array(new Uint8Array(blob).buffer);
}

export const FACE_DIM = 512;

/** Face embeddings are stored concatenated, in the same order as analysis.faces. */
export function faceEmbeddings(row: ImageRow): Float32Array[] {
  const all = toFloat32(row.face_embs);
  if (!all) return [];
  const out: Float32Array[] = [];
  for (let i = 0; i + FACE_DIM <= all.length; i += FACE_DIM) out.push(all.subarray(i, i + FACE_DIM));
  return out;
}

export function toRecord(row: ImageRow): ImageRecord {
  const a = parseAnalysis(row);
  const face = a?.faces?.[row.main_face ?? 0];
  return {
    id: row.id,
    relPath: row.rel_path,
    hash: row.file_hash,
    width: row.width,
    height: row.height,
    status: row.status,
    score: row.score,
    reasons: JSON.parse(row.reasons),
    framing: row.framing,
    dupOf: row.dup_of,
    override: row.override,
    caption: row.caption,
    tags: parseTags(row),
    metrics: {
      aesthetic: a?.aesthetic ?? null,
      sharpness: a?.sharpness ?? null,
      faceSharpness: face?.sharpness ?? null,
      faceHeight: face ? face.bbox[3] - face.bbox[1] : null,
      yaw: face?.pose?.[1] ?? null,
      identity: row.identity,
      faceCount: a?.faces?.length ?? 0,
      brightness: a?.brightness ?? null,
    },
  };
}

export function setOverride(id: number, override: Override) {
  db.query("UPDATE images SET override = ? WHERE id = ?").run(override, id);
}

export function setCaption(id: number, caption: string | null, model: string | null) {
  db.query("UPDATE images SET caption = ?, caption_model = ? WHERE id = ?").run(caption, model, id);
}
