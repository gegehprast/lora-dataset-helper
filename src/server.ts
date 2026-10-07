import { existsSync } from "node:fs"
import { join } from "node:path"
import index from "../web/index.html"
import { PORT, paths } from "./config"
import {
  getRow,
  getSettings,
  listRows,
  saveSettings,
  setCaption,
  setOverride,
  toRecord,
} from "./db"
import { cancelJob, getJob, type JobContext, startJob } from "./jobs"
import { analyzeDataset } from "./pipeline/analyze"
import { captionDataset, captionImage } from "./pipeline/caption"
import { setImageCrop } from "./pipeline/cropping"
import { exportDataset } from "./pipeline/export"
import {
  datasetDir,
  listDatasets,
  scanDataset,
  thumbPath,
} from "./pipeline/scan"
import { runSelection } from "./pipeline/select"
import { reviewSingleImage, tagDataset } from "./pipeline/tag"
import type { JobKind, Override, Settings } from "./types"
import { listVisionModels } from "./venice"
import { worker } from "./worker"

const json = (data: unknown, status = 200) => Response.json(data, { status })
const fail = (e: unknown, status = 400) =>
  json({ error: e instanceof Error ? e.message : String(e) }, status)

function datasetPayload(name: string) {
  datasetDir(name) // validates the name
  return {
    name,
    settings: getSettings(name),
    images: listRows(name).map(toRecord),
    job: getJob(name),
  }
}

function selectionSummary(dataset: string) {
  const s = runSelection(dataset)
  return `Selected ${s.selected}, reserve ${s.reserve}, rejected ${s.rejected}${s.pending ? `, ${s.pending} not analyzed` : ""}`
}

async function localPass(dataset: string, ctx: JobContext) {
  const scanned = await scanDataset(dataset, ctx)
  const analyzed = await analyzeDataset(dataset, ctx)
  ctx.stage("Selecting", 0)
  return `${scanned}. ${analyzed}. ${selectionSummary(dataset)}`
}

const JOBS: Record<
  JobKind,
  (
    dataset: string,
    ctx: JobContext,
    body: { overwrite?: boolean },
  ) => Promise<string>
> = {
  scan: (d, ctx) => scanDataset(d, ctx),
  analyze: localPass,
  tag: (d, ctx) => tagDataset(d, ctx),
  select: async (d) => selectionSummary(d),
  caption: (d, ctx, body) => captionDataset(d, ctx, !!body.overwrite),
  export: (d, ctx) => exportDataset(d, ctx),
  auto: async (d, ctx) => {
    const local = await localPass(d, ctx)
    if (getSettings(d).localOnly)
      return `${local}. AI review skipped: dataset is Local only.`
    const tagged = await tagDataset(d, ctx)
    return `${local}. ${tagged}`
  },
}

async function readBody<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T
  } catch {
    return {} as T
  }
}

const server = Bun.serve({
  port: PORT,
  idleTimeout: 120,
  development: process.env.NODE_ENV !== "production" && {
    hmr: true,
    console: true,
  },
  routes: {
    "/": index,
    "/dataset/*": index,

    "/api/status": () =>
      json({
        veniceKey: !!process.env.VENICE_API_KEY,
        workerInstalled: existsSync(paths.workerPython),
        inputDir: paths.input,
        outputDir: paths.output,
      }),

    "/api/models": async () => {
      try {
        return json(await listVisionModels())
      } catch (e) {
        return fail(e, 502)
      }
    },

    "/api/datasets": () => json(listDatasets()),

    "/api/datasets/:name": (req) => {
      try {
        return json(datasetPayload(req.params.name))
      } catch (e) {
        return fail(e, 404)
      }
    },

    "/api/datasets/:name/job": (req) => json(getJob(req.params.name)),

    "/api/datasets/:name/settings": {
      PATCH: async (req) => {
        try {
          const name = req.params.name
          datasetDir(name)
          saveSettings(name, await readBody<Partial<Settings>>(req))
          if (!getJob(name)?.running) runSelection(name)
          return json(datasetPayload(name))
        } catch (e) {
          return fail(e)
        }
      },
    },

    "/api/datasets/:name/jobs/:kind": {
      POST: async (req) => {
        const { name, kind } = req.params
        const run = JOBS[kind as JobKind]
        if (!run) return fail(`Unknown job: ${kind}`, 404)
        try {
          datasetDir(name)
          const body = await readBody<{ overwrite?: boolean }>(req)
          return json(
            startJob(name, kind as JobKind, (ctx) => run(name, ctx, body)),
          )
        } catch (e) {
          return fail(e, 409)
        }
      },
    },

    "/api/datasets/:name/cancel": {
      POST: (req) => {
        cancelJob(req.params.name)
        return json(getJob(req.params.name))
      },
    },

    "/api/images/:id": {
      PATCH: async (req) => {
        const row = getRow(Number(req.params.id))
        if (!row) return fail("Not found", 404)
        const body = await readBody<{ override?: Override; caption?: string }>(
          req,
        )
        if ("override" in body) {
          setOverride(row.id, body.override ?? null)
          if (!getJob(row.dataset)?.running) runSelection(row.dataset)
        }
        if ("caption" in body)
          setCaption(row.id, body.caption?.trim() || null, row.caption_model)
        return json(datasetPayload(row.dataset))
      },
    },

    "/api/images/:id/crop": {
      PUT: async (req) => {
        const row = getRow(Number(req.params.id))
        if (!row) return fail("Not found", 404)
        if (getJob(row.dataset)?.running)
          return fail("Wait for the running job to finish before cropping", 409)
        try {
          const body = await readBody<{ crop?: unknown }>(req)
          const { warning } = await setImageCrop(row.id, body.crop ?? null)
          return json({ ...datasetPayload(row.dataset), warning })
        } catch (e) {
          return fail(e)
        }
      },
    },

    "/api/images/:id/review": {
      POST: async (req) => {
        const row = getRow(Number(req.params.id))
        if (!row) return fail("Not found", 404)
        if (getJob(row.dataset)?.running)
          return fail("Wait for the running job to finish", 409)
        try {
          await reviewSingleImage(row.id)
          return json(datasetPayload(row.dataset))
        } catch (e) {
          return fail(e, 502)
        }
      },
    },

    "/api/images/:id/caption": {
      POST: async (req) => {
        try {
          const caption = await captionImage(Number(req.params.id))
          return json({ caption })
        } catch (e) {
          return fail(e, 502)
        }
      },
    },

    "/api/images/:id/reference": {
      POST: (req) => {
        const row = getRow(Number(req.params.id))
        if (!row) return fail("Not found", 404)
        const refs = getSettings(row.dataset).referenceImageIds
        saveSettings(row.dataset, {
          referenceImageIds: refs.includes(row.id)
            ? refs.filter((x) => x !== row.id)
            : [...refs, row.id],
        })
        if (!getJob(row.dataset)?.running) runSelection(row.dataset)
        return json(datasetPayload(row.dataset))
      },
    },

    "/api/images/:id/file": (req) => {
      const row = getRow(Number(req.params.id))
      if (!row) return fail("Not found", 404)
      return new Response(Bun.file(join(datasetDir(row.dataset), row.rel_path)))
    },

    "/thumbs/:file": (req) => {
      const id = req.params.file.replace(/\.webp$/, "")
      if (!/^[0-9a-f]{40}(-[0-9a-f]{8})?$/.test(id))
        return fail("Bad thumbnail", 400)
      return new Response(Bun.file(thumbPath(id)), {
        headers: { "Cache-Control": "public, max-age=31536000, immutable" },
      })
    },
  },
  fetch() {
    return new Response("Not found", { status: 404 })
  },
})

console.log(`LoRA Dataset Helper running at ${server.url}`)
console.log(`Put each character's images in a sub-folder of ${paths.input}`)

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    worker.stop()
    process.exit(0)
  })
}
