import { db } from "../src/db"
import type { JobContext } from "../src/jobs"
import type { Analysis, FaceInfo, Override, VisionTags } from "../src/types"

/** Deterministic PRNG so tests are repeatable. */
export function rng(seed: number) {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return ((s >>> 0) / 0xffffffff) * 2 - 1
  }
}

export function normalize(v: Float32Array): Float32Array {
  const n = Math.hypot(...v)
  for (let i = 0; i < v.length; i++) v[i]! /= n
  return v
}

/** Random unit vector. Two random high-dimensional vectors are nearly orthogonal (cosine ≈ 0). */
export function randomVec(dim: number, seed: number): Float32Array {
  const r = rng(seed)
  return normalize(Float32Array.from({ length: dim }, () => r()))
}

/** A unit vector close to `base` (cosine ≈ 1 / sqrt(1 + noise²)). */
export function near(
  base: Float32Array,
  seed: number,
  noise = 0.5,
): Float32Array {
  const r = rng(seed)
  const scale = noise / Math.sqrt(base.length / 3)
  return normalize(Float32Array.from(base, (x) => x + r() * scale))
}

export const cos = (a: Float32Array, b: Float32Array) =>
  a.reduce((s, x, i) => s + x * b[i]!, 0)

let hashCounter = 0
/** Unique 64-bit pHash in hex; differing hashes are far apart. */
export function uniquePhash(): string {
  const r = rng(++hashCounter * 7919)
  return Array.from({ length: 16 }, () =>
    Math.floor(((r() + 1) / 2) * 16).toString(16),
  ).join("")
}

export function face(
  over: Partial<FaceInfo> & { height?: number } = {},
): FaceInfo {
  const h = over.height ?? 0.2
  return {
    bbox: over.bbox ?? [0.4, 0.2, 0.6, 0.2 + h],
    det: 0.9,
    sharpness: over.sharpness ?? 200,
    pose: over.pose ?? [0, 0, 0],
    age: 30,
    sex: "F",
  }
}

export function tags(over: Partial<VisionTags> = {}): VisionTags {
  return {
    framing: "half",
    view: "front",
    camera: "eye_level",
    pose: "standing",
    expression: "smiling",
    outfit: "t-shirt",
    background: "park",
    lighting: "daylight",
    issues: [],
    quality: 7,
    note: "",
    ...over,
  }
}

export interface SeedOptions {
  name?: string
  analysis?: Partial<Analysis>
  faces?: {
    info?: Partial<FaceInfo> & { height?: number }
    emb: Float32Array
  }[]
  clip?: Float32Array
  tags?: VisionTags | null
  tagsModel?: string
  override?: Override
  analyzed?: boolean
  caption?: string | null
}

let seedCounter = 0
/** Insert an image row as if it had been scanned and analyzed. Returns its id. */
export function seedImage(dataset: string, o: SeedOptions = {}): number {
  const n = ++seedCounter
  const faces = o.faces ?? []
  const analysis: Analysis = {
    width: 1200,
    height: 1600,
    sharpness: 300,
    brightness: 120,
    darkClip: 0,
    brightClip: 0,
    phash: uniquePhash(),
    aesthetic: 5.5,
    faces: faces.map((f) => face(f.info)),
    ...o.analysis,
  }
  const analyzed = o.analyzed ?? true
  const faceBlob = faces.length
    ? Buffer.concat(faces.map((f) => Buffer.from(f.emb.buffer.slice(0))))
    : null
  const clip = o.clip ?? randomVec(768, 100_000 + n)
  const row = db
    .query<{ id: number }, any[]>(
      `INSERT INTO images (dataset, rel_path, file_hash, size, mtime, width, height, analysis, clip_emb, face_embs, tags, tags_model, override, caption)
       VALUES (?, ?, ?, 1, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(
      dataset,
      o.name ?? `img_${String(n).padStart(4, "0")}.jpg`,
      n.toString(16).padStart(40, "0"),
      analyzed ? analysis.width : null,
      analyzed ? analysis.height : null,
      analyzed ? JSON.stringify(analysis) : null,
      analyzed ? Buffer.from(clip.buffer.slice(0)) : null,
      analyzed ? faceBlob : null,
      o.tags ? JSON.stringify(o.tags) : null,
      o.tags ? (o.tagsModel ?? "test-model") : null,
      o.override ?? null,
      o.caption ?? null,
    )!
  return row.id
}

let datasetCounter = 0
/** A fresh dataset name so tests don't see each other's rows. */
export function newDataset(prefix = "ds") {
  return `${prefix}-${++datasetCounter}-${Date.now().toString(36)}`
}

/** JobContext that records progress and can be cancelled. */
export function fakeCtx() {
  const state = { stages: [] as string[], ticks: 0, cancelled: false }
  const ctx: JobContext = {
    stage: (label) => void state.stages.push(label),
    tick: (n = 1) => {
      state.ticks += n
    },
    message: () => {},
    check: () => {
      if (state.cancelled) throw new Error("Cancelled")
    },
  }
  return { ctx, state }
}

type Handler = (
  url: string,
  init: RequestInit | undefined,
) => Response | Promise<Response>

/** Replace fetch for one test. Returns the recorded calls and a restore function. */
export function mockFetch(handler: Handler) {
  const original = globalThis.fetch
  const calls: { url: string; body: any }[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    calls.push({
      url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    })
    return handler(url, init)
  }) as typeof fetch
  return {
    calls,
    restore: () => {
      globalThis.fetch = original
    },
  }
}

export const json = (
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })

/** A Venice /models payload. */
export function modelsPayload(
  models: {
    id: string
    privacy?: string
    vision?: boolean
    schema?: boolean
    e2ee?: boolean
  }[],
) {
  return {
    data: models.map((m) => ({
      id: m.id,
      model_spec: {
        name: m.id,
        privacy: m.privacy ?? "private",
        capabilities: {
          supportsVision: m.vision ?? true,
          supportsResponseSchema: m.schema ?? true,
          supportsE2EE: m.e2ee ?? false,
        },
        pricing: { input: { usd: 0.1 }, output: { usd: 0.2 } },
      },
    })),
  }
}

export const chatReply = (content: string) =>
  json({ choices: [{ message: { content } }] })

/** Call `fn` n times. */
export function times(n: number, fn: (i: number) => unknown) {
  for (let i = 0; i < n; i++) fn(i)
}
