# Developer Guide

How the app is built and how to change it. For using the app, see the [User Guide](user-guide.md).

- [Architecture](#architecture)
- [Repository layout](#repository-layout)
- [Development setup](#development-setup)
- [Data model](#data-model)
- [Pipeline](#pipeline)
- [Selection algorithm](#selection-algorithm)
- [Python worker](#python-worker)
- [Venice client](#venice-client)
- [Jobs](#jobs)
- [HTTP API](#http-api)
- [Frontend](#frontend)
- [Common changes](#common-changes)
- [Rules and gotchas](#rules-and-gotchas)
- [Known gaps](#known-gaps)

## Architecture

```
 Browser (React)                         Bun server (src/server.ts)
 ───────────────                         ─────────────────────────────────────────
 web/ ── fetch /api/* ─────────────────► routes ──► jobs.ts (one job per dataset)
      ◄─ poll /api/datasets/:n/job ─────            │
                                                    ▼
                                         pipeline/ scan → analyze → tag → select → caption → export
                                              │          │         │                  │
                                              │          │         └── venice.ts ─────┴──► Venice API (HTTPS)
                                              │          └── worker.ts ── JSON lines over stdin/stdout ──► worker/main.py
                                              │                                                           (torch, open_clip,
                                              ▼                                                            InsightFace, OpenCV)
                                         bun:sqlite  data/.cache/app.sqlite
                                         sharp       data/.cache/thumbs/<sha1>.webp
```

- **Bun / TypeScript** owns the app: HTTP, database, file handling, Venice calls, the selection logic and the UI bundle.
- **Python** does only local model inference. It runs as one long-lived child process, so models load once.
- **Selection is deterministic code**, not an LLM decision. The vision model only supplies per-image facts (framing, issues, quality). Re-selecting is cheap and repeatable, which is why settings changes apply instantly.

## Repository layout

```
src/
  server.ts          Bun.serve routes, job wiring, static thumbnails
  config.ts          paths (data/*), env, supported extensions
  types.ts           types shared with the UI: Settings + defaults, VisionTags, ImageRecord, reason labels
  db.ts              schema, row ↔ record conversion, embedding helpers
  jobs.ts            background job runner, progress, cancellation, concurrency pool
  worker.ts          PythonWorker client
  venice.ts          Venice HTTP client (models, chat with image, JSON mode, retries)
  pipeline/
    scan.ts          file discovery, hashing, thumbnails, dataset listing
    analyze.ts       batches images through the worker, stores metrics and embeddings
    tag.ts           vision-model review (structured JSON)
    select.ts        identity, hard checks, scoring, dedup, diverse pick
    caption.ts       caption prompts and post-processing
    export.ts        copies into data/output/<dataset>/
worker/
  main.py            Python analysis worker
  requirements.txt
scripts/setup-worker.sh
web/
  index.html, main.tsx, App.tsx, api.ts, styles.css
  components/        DatasetView, ImageGrid, ImageDetail, SettingsPanel
data/                input/ output/ .cache/   (all git-ignored except .gitkeep)
images-for-testing/  local-only sample images (git-ignored, see Rules)
```

## Development setup

```sh
bun install
bun run setup:worker     # Python 3.12 venv in worker/.venv
cp .env.example .env     # VENICE_API_KEY=...
bun run dev              # bun --hot src/server.ts, with HMR for the UI
bun run typecheck        # tsc --noEmit
```

| Env var | Default | Purpose |
|---|---|---|
| `VENICE_API_KEY` | none | Needed for tag and caption |
| `PORT` | `3000` | HTTP port |
| `VENICE_BASE_URL` | `https://api.venice.ai/api/v1` | Override for a proxy or mock |
| `PYTHON` | `python3.12` | Interpreter used by `setup-worker.sh` |
| `NODE_ENV=production` | | `bun run start`: disables HMR |

Bun loads `.env` automatically. The worker receives `MODELS_DIR=data/.cache/models` from the server.

Useful while developing:

```sh
sqlite3 data/.cache/app.sqlite "select rel_path, status, score, reasons from images where dataset='x' order by score desc"
curl -s localhost:3000/api/datasets/x | jq '.images[] | {relPath, status, reasons}'
```

To start from scratch, delete `data/.cache/app.sqlite*`. Thumbnails and models in `data/.cache/` can stay.

### Setup-script notes

- `insightface` ships only as a source package that needs Cython and numpy at build time, so it's installed with `--no-build-isolation` after them.
- `insightface` depends on the CPU-only `onnxruntime`, which shadows `onnxruntime-gpu`. The script uninstalls both and reinstalls only `onnxruntime-gpu`. The worker calls `onnxruntime.preload_dlls()` so it finds the CUDA/cuDNN libraries from the pip-installed `nvidia-*` wheels.
- If faces run on CPU, `load` reports `faceProviders: ["CPUExecutionProvider"]` and the analyze stage label shows the device.

## Data model

SQLite at `data/.cache/app.sqlite` (WAL mode). Created on startup in `src/db.ts`. There are no migrations yet: add columns with `ALTER TABLE` guarded by a `PRAGMA table_info` check, or delete the DB during early development.

### `datasets`

| Column | Notes |
|---|---|
| `name` | Folder name under `data/input/` |
| `settings` | JSON `Partial<Settings>` holding **only values that differ from `DEFAULT_SETTINGS`** (and only known keys). `getSettings()` merges them over the defaults, so changing a default reaches every dataset that didn't override it. |

### `images`

| Column | Written by | Notes |
|---|---|---|
| `id`, `dataset`, `rel_path` | scan | `UNIQUE(dataset, rel_path)`; `rel_path` is relative to the dataset folder |
| `file_hash`, `size`, `mtime` | scan | SHA-1 of the file. Re-hashed only when size or mtime change; a new hash resets every derived column. |
| `width`, `height` | analyze | After EXIF rotation |
| `analysis` | analyze | JSON `Analysis` (metrics and faces without embeddings), or `{ "error": … }` |
| `clip_emb` | analyze | 768 × float32 little-endian, L2-normalized (CLIP ViT-L/14, OpenAI) |
| `face_embs` | analyze | n × 512 float32, concatenated in the order of `analysis.faces` (largest first), L2-normalized ArcFace |
| `tags`, `tags_model` | tag | JSON `VisionTags`; re-tagged when the review model changes |
| `status` | select | `pending` · `selected` · `reserve` · `rejected` |
| `score`, `reasons`, `framing`, `dup_of`, `identity`, `main_face` | select | `reasons` is a JSON array of codes; `main_face` indexes `analysis.faces` |
| `override` | UI | `include` · `exclude` · NULL |
| `caption`, `caption_model` | caption / UI | |

`toRecord()` turns a row into the `ImageRecord` the UI uses. Embeddings never leave the server.

## Pipeline

Every stage is a function `(dataset, ctx: JobContext) => Promise<string>`. The returned string becomes the job's summary message. Every stage can be rerun safely and skips work that's already done.

### scan (`pipeline/scan.ts`)

Globs `data/input/<dataset>/**/*` for supported extensions. For each file: skip if size and mtime are unchanged; otherwise hash it, insert or reset the row, and create a 512 px WebP thumbnail named after the hash. Rows for deleted files are removed. Dataset names are validated by `datasetDir()`: no slashes, no leading dot.

### analyze (`pipeline/analyze.ts`)

Sends rows with `analysis IS NULL` to the worker in batches of 8, after a `load` call that reports the device. Per-image failures are stored as `{error}` and become the `unreadable` reason. The `analyze` job in `server.ts` runs scan, then analyze, then select.

### tag (`pipeline/tag.ts`)

1. Runs `runSelection()` using local data only.
2. Reviews images whose status is `selected` or `reserve` (passed local checks and aren't duplicates), plus pinned images, that lack tags from the current `tagModel`. Reviewing the reserve too means images promoted later already have tags.
3. Sends a structured-output request (`TAG_SCHEMA`) through `chatJson()`, then cleans the result: unknown issues are dropped and quality is clamped to 1–10.
4. If the first 3 requests all fail, aborts the job. Later failures are counted and logged.
5. Runs `runSelection()` again.

### select (`pipeline/select.ts`)

See [Selection algorithm](#selection-algorithm). Synchronous; runs in well under a second for a few hundred images. Called after analyze and tag, on every settings change, override change and reference toggle, unless a job is running for that dataset.

### caption (`pipeline/caption.ts`)

`buildPrompt(settings)` builds an instruction listing what to describe and what to leave out. It changes with `captionStyle` and `captionDescribeHair`, and appends `captionInstructions`. `clean()` strips "Caption:" prefixes, quotes and extra whitespace, and adds the trigger word at the front if the model left it out. `captionImage(id)` is also used by the single-image Regenerate endpoint.

### export (`pipeline/export.ts`)

Deletes and recreates `data/output/<dataset>/{selected,reserve,rejected}`, copies files (sub-folders flattened to `a__b.jpg`, with collisions numbered), writes `<stem>.txt` for selected images, and writes `report.json`. Nothing outside those three folders and the report is touched.

## Selection algorithm

All in `runSelection(dataset)`:

**1. Identity centroid.**
- If `referenceImageIds` is set: the normalized mean of those images' main faces.
- Otherwise: take the largest face of every image. Pick as seed the face with the most neighbours at cosine ≥ `identityThreshold`, average the seed's neighbours, then refine twice. Each refinement uses each image's best-matching face above the threshold.
- Each image's `identity` is the best cosine of any of its faces to the centroid; that face is its `main_face`.

**2. Hard checks** (`hardReasons`), each adding a reason code:

| Code | Condition |
|---|---|
| `unreadable` | worker error |
| `low_resolution` | `min(w,h) < minShortSide` |
| `no_face` | no faces |
| `different_person` | `identity < identityThreshold` |
| `blurry_face` | main-face Laplacian variance `< minFaceSharpness` (crop downscaled to ≤256 px tall, never upscaled) |
| `multiple_people` | another face with height ≥ `otherPersonMinFace` (fraction of image height) |
| `bad_exposure` | mean luma < 35 or > 225, or > 35 % pixels < 8, or > 25 % pixels > 247 |
| `HARD_ISSUES` from tags | `cropped_head`, `face_occluded`, `multiple_people`, `watermark_or_text`, `heavy_filter_or_edit`, `bad_anatomy` |
| `low_quality` | tags quality ≤ 3 |
| `manual` | override `exclude` (replaces every other reason) |

**3. Framing and view.** Taken from tags when present. Otherwise framing comes from the main face's height (≥ 0.28 close-up, ≥ 0.10 half, else full) and view from head yaw (< 20° front, < 55° three-quarter, else profile).

**4. Score** (0–1), built from:

```
aesthetic = clamp((laion - 4) / 3)
sharp     = clamp(log(faceSharpness / minFaceSharpness) / log 8)     // image sharpness / 50 if no face
res       = clamp(shortSide / preferredShortSide)
ident     = clamp((identity - threshold) / (0.75 - threshold))
quality   = (tags.quality - 1) / 9

with tags:    0.25·aesthetic + 0.20·sharp + 0.10·res + 0.15·ident + 0.30·quality
without tags: 0.40·aesthetic + 0.30·sharp + 0.15·res + 0.15·ident
then − 0.05 per non-hard issue
```

**5. Dedup.** Go through the images that passed (and pinned ones) from pinned first, then by score. An image is a `duplicate` of the first kept image within `dedupPhashDistance` (64-bit pHash Hamming distance) or `dedupClipSimilarity` (CLIP cosine). Pinned images are never marked duplicate.

**6. Diverse pick.** Start with the pinned images. Each framing gets a quota of `round(target · mix / Σmix)`. Repeat until the target is reached:
- consider candidates whose framing quota isn't full (or all candidates if none qualify);
- take the one with the highest `score − diversity · (redundancy + 0.3 · viewShare)`, where
  - `redundancy = clamp((maxCLIPSim to selected − 0.6) / 0.35)`
  - `viewShare` = fraction of the selected images with the same view.

Unpicked candidates become `reserve` with reason `not_selected`.

The weights and constants are first guesses, checked only on a 30-image set. They're the first place to tune once real datasets show where the selection goes wrong.

## Python worker

`worker/main.py`, spawned by `src/worker.ts`.

**Protocol**: newline-delimited JSON.

```
← {"ready": true}                                   on start, before models load
→ {"id": 1, "op": "load"}                           loads models (first call: ~10 s, plus downloads on first run)
← {"id": 1, "ok": true, "result": {"device": "cuda", "faceProviders": [...]}}
→ {"id": 2, "op": "analyze", "args": {"paths": ["/abs/a.jpg", ...]}}
← {"id": 2, "ok": true, "result": [WorkerAnalysis | {"error": "..."}, ...]}
→ {"id": 3, "op": "shutdown"}
```

- At startup, file descriptor 1 is duplicated for the protocol and then pointed at stderr. That way prints from Python *and* native libraries can't corrupt the stream. Log with `log()`, which goes to stderr; the server passes stderr through to its console.
- Paths are absolute; the worker reads files itself. Embeddings return as base64 little-endian float32.
- `analyze` handles one image at a time for faces and metrics, and batches CLIP in groups of 16 under fp16 autocast.
- `PythonWorker` sends one request at a time (`chain`), starts the process lazily, rejects pending calls if the process exits, and restarts it on the next call. Both the worker and the job map live on `globalThis` so `bun --hot` reloads don't start a second Python process.

**Models** (in `data/.cache/models/`): open_clip `ViT-L-14-quickgelu` / `openai`; the LAION improved-aesthetic-predictor MLP (`sac+logos+ava1-l14-linearMSE.pth`); InsightFace `buffalo_l`. The `-quickgelu` variant is required: plain `ViT-L-14` with OpenAI weights gives slightly wrong embeddings, which skews the aesthetic score.

**Adding a worker op**: add a branch in `main()` (and a method on `Analyzer` if it needs models), then call it with `worker.call<ResultType>("op", args)`. Keep inputs and outputs JSON; pass file paths, not image bytes.

## Venice client

`src/venice.ts` uses plain `fetch` against the OpenAI-compatible API.

- `listVisionModels()`: `GET /models?type=text`, keeps `supportsVision`, records `model_spec.privacy` (`"private"` / `"anonymized"`), `supportsResponseSchema` and `supportsE2EE`. Cached for 10 minutes.
- `checkModel(model, requirePrivate)`: runs before every request, and once at the start of the tag and caption stages. With `requirePrivate` (the `privateModelsOnly` setting) it **fails closed**: it throws if the model list can't be fetched or the model isn't marked private. It always rejects E2EE models, because the `enable_e2ee` client-side encryption isn't implemented.
- `chat()`: sends a system prompt plus a user message with text and a `data:` JPEG. The image is resized by `sharp` to fit in 1024 px, EXIF-rotated, quality 88.
  - Always sends `venice_parameters: { include_venice_system_prompt: false, disable_thinking: true, strip_thinking_response: true }`, and also removes `<think>` blocks itself.
  - Adds `response_format: { type: "json_schema", json_schema: { name, schema, strict: true } }` only when the model supports it. Without JSON mode, integer ranges aren't enforced, which is why `tag.ts` clamps `quality`.
  - Retries 429 and 5xx up to 4 times with exponential backoff, honouring `Retry-After`.
- `chatJson()` parses the first `{…}` block in the reply, so models without JSON mode still work most of the time.

## Jobs

`src/jobs.ts`. `startJob(dataset, kind, fn)` returns at once, and only one job runs per dataset. The `JobContext` gives `stage(label, total)`, `tick()`, `message()` and `check()`. `check()` throws `Cancelled` once `cancelJob()` has been called; call it between units of work. `pool(items, concurrency, ctx, fn)` runs async work with bounded parallelism and calls `check()` and `tick()` for you. Job state lives in memory and is lost on restart. The UI polls it every 700 ms while it runs.

## HTTP API

All JSON. `DatasetData = { name, settings, images: ImageRecord[], job }`.

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/status` | | `{ veniceKey, workerInstalled, inputDir, outputDir }` |
| GET | `/api/models` | | `VeniceModel[]` (502 if Venice is unreachable or there's no key) |
| GET | `/api/datasets` | | `DatasetSummary[]` |
| GET | `/api/datasets/:name` | | `DatasetData` |
| GET | `/api/datasets/:name/job` | | `JobState \| null` |
| PATCH | `/api/datasets/:name/settings` | `Partial<Settings>` | `DatasetData` (re-selected) |
| POST | `/api/datasets/:name/jobs/:kind` | `{ overwrite? }` for caption | `JobState`. Kinds: `scan`, `analyze` (scan + analyze + select), `tag`, `select`, `caption`, `export`, `auto` (analyze + tag). 409 if a job is already running. |
| POST | `/api/datasets/:name/cancel` | | `JobState` |
| PATCH | `/api/images/:id` | `{ override? }` and/or `{ caption? }` | `DatasetData` |
| POST | `/api/images/:id/caption` | | `{ caption }`, generated synchronously |
| POST | `/api/images/:id/reference` | | `DatasetData`; toggles the image in `referenceImageIds` |
| GET | `/api/images/:id/file` | | the original image |
| GET | `/thumbs/:sha1.webp` | | thumbnail (immutable cache) |
| GET | `/`, `/dataset/*` | | the SPA (`web/index.html`) |

## Frontend

React 19, bundled by Bun's HTML imports, so there's no Vite or separate build step. In dev, HMR is on and browser console output is forwarded to the terminal.

- `App.tsx`: minimal router (`/` and `/dataset/:name` via `history.pushState`), status banners, dataset list.
- `DatasetView.tsx`: owns `DatasetData`, the pipeline buttons, job polling, filters, sorting and the stats bar. Every change request returns the full `DatasetData`, which replaces local state.
- `SettingsPanel.tsx`: keeps a local draft and sends a debounced PATCH (600 ms for typing, immediate for selects).
- `ImageGrid.tsx` (memoized cards) and `ImageDetail.tsx` (modal, keyboard navigation, caption editor).
- `styles.css`: plain CSS with light and dark tokens on `:root`.
- Types come straight from `src/types.ts`; keep that file free of server-only imports.

## Common changes

**New setting**: add it to `Settings` and `DEFAULT_SETTINGS` in `src/types.ts`, use it in the pipeline, and add a control in `SettingsPanel.tsx`. Stored settings are merged over the defaults, so existing datasets pick up the default automatically.

**New rejection reason**: push a code in `hardReasons()`, and add a label in `REASON_LABELS` and a row in the user guide's reason table.

**New vision-model field or issue**: extend `VisionTags` / `ISSUES` (and `HARD_ISSUES` if it should reject), plus `TAG_SCHEMA` and `PROMPT` in `tag.ts`. Changing the review model in Settings re-reviews everything; otherwise clear `tags_model` in SQL to force it.

**New local metric**: compute it in `Analyzer._analyze_one`, add it to `Analysis`/`WorkerAnalysis`, and use it in `select.ts`. Set `analysis = NULL` for the dataset to recompute.

**New caption style**: extend `CaptionStyle`, add a branch in `buildPrompt()`, and an option in `SettingsPanel`.

## Rules and gotchas

- **`images-for-testing/` is local-only.** Never commit it. Never send it, or anything derived from it (thumbnails, crops, base64), to Venice or any other online service. That includes opening it with AI tools that upload images. Use it only to test the local pipeline. Test Venice code with a synthetic image or images cleared for upload. See `CLAUDE.md`.
- Input files are read-only to the app; only `data/output/` and `data/.cache/` are written.
- `runSelection()` is skipped while a job runs on that dataset, so it doesn't race the job's own selection; the job reselects at the end.
- `bun:sqlite` is opened with `strict: true`: named parameters don't take a `$` prefix in the object.
- `Float32Array` views on SQLite blobs are created from a copy (`toFloat32`) to avoid alignment errors.
- `pkill -f "bun src/server.ts"` also matches the shell running it; use `pgrep`/`kill` with a PID instead.

## Known gaps

- The Venice review and caption prompts have been checked against the live API only with a synthetic illustration (private models: gemma-4-31b-it, gemma-4-uncensored, mistral-small-3.2, qwen3-vl-235b, qwen-3-8-27b), not with real photo datasets. Expect to tune the prompts after real runs.
- No automated tests. `select.ts` is the best first candidate: it can be tested by seeding an in-memory DB with synthetic analyses and embeddings.
- No schema migrations.
- Job state isn't saved across restarts.
- InsightFace `buffalo_l` weights are licensed for non-commercial research use only.
