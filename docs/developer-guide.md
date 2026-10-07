# Developer Guide

How the app is built and how to change it. For using the app, see the [User Guide](user-guide.md).

- [Architecture](#architecture)
- [Repository layout](#repository-layout)
- [Development setup](#development-setup)
- [Data model](#data-model)
- [Pipeline](#pipeline)
- [Cropping](#cropping)
- [Selection algorithm](#selection-algorithm)
- [Python worker](#python-worker)
- [Venice client](#venice-client)
- [Jobs](#jobs)
- [HTTP API](#http-api)
- [Frontend](#frontend)
- [Tests](#tests)
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
bun test                 # see Tests
bun run lint             # Biome: formatting + lint, read-only
bun run format           # Biome: apply formatting and safe fixes
bun run check            # typecheck + lint + tests; run before committing
```

### Code style

[Biome](https://biomejs.dev) formats and lints TypeScript, CSS and JSON, configured in `biome.json`:
- 2-space indent, 80 columns, double quotes, **no semicolons**;
- the recommended lint rules, plus explicit `public`/`private` on class members.

`test/**` turns off `noNonNullAssertion` and `noExplicitAny`, because assertions and loosely typed mocks are normal in tests. App code doesn't use `!`: use a type guard or a check instead.

In VS Code, install the recommended Biome extension (`.vscode/extensions.json`). It formats and organizes imports on save. Python in `worker/` isn't covered by Biome.

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
| `outfit_group` | tag (`groupOutfits`) | Label shared by images in the same outfit. Added by `addColumn()` on older databases. |
| `crop` | crop editor (`setImageCrop`) | JSON `{x, y, w, h}`, normalized 0–1 relative to the **EXIF-rotated** image; NULL = none. Cleared when the file changes. |
| `caption_stale` | `setImageCrop` / `setCaption` | 1 when the crop changed after the caption was written; `setCaption` clears it. |

`toRecord()` turns a row into the `ImageRecord` the UI uses. Embeddings never leave the server.

## Pipeline

Every stage is a function `(dataset, ctx: JobContext) => Promise<string>`. The returned string becomes the job's summary message. Every stage can be rerun safely and skips work that's already done.

### scan (`pipeline/scan.ts`)

Globs `data/input/<dataset>/**/*` for supported extensions. For each file: skip if size and mtime are unchanged; otherwise hash it, insert or reset the row, and create a 512 px WebP thumbnail named after the hash. Rows for deleted files are removed. Dataset names are validated by `datasetDir()`: no slashes, no leading dot.

### analyze (`pipeline/analyze.ts`)

Sends rows with `analysis IS NULL` to the worker in batches of 8, after a `load` call that reports the device. Per-image failures are stored as `{error}` and become the `unreadable` reason. The `analyze` job in `server.ts` runs scan, then analyze, then select.

### tag (`pipeline/tag.ts`)

1. Runs `runSelection()`. Candidates are images with status `selected` or `reserve` (passed the local checks and aren't duplicates) plus pinned images.
2. **First round:** reviews the best `ceil(reviewMultiplier × targetCount)` candidates by score, plus every pinned one, that lack an up-to-date review. A review is up to date when it's from the current `tagModel` and has `v == TAGS_VERSION`. `reviewMultiplier: 0` means every candidate.
3. **Replacement rounds:** re-selects. Any *selected* image still lacking a review, not yet attempted in this run, gets reviewed. Repeats (at most 20 rounds) until every selected image is reviewed. Failed images aren't retried in the same run, so the loop always ends.
4. Each review is a structured-output request (`TAG_SCHEMA`) through `chatJson()`. The result is cleaned (unknown issues dropped, quality clamped to 1–10) and stamped with `v: TAGS_VERSION`.
5. If the first 3 requests all fail, the job aborts. Later failures are counted and logged.
6. **Outfit grouping** (`groupOutfits`): collects the normalized outfit descriptions of every reviewed image in the dataset. If there are 2–400 distinct ones, it sends them as a numbered list in **one text-only request** (no images) to the review model.
   - The model replies with only the groups of equivalent outfits, e.g. `{"same": [[0, 4, 9], [2, 7]]}`. Unlisted descriptions are their own outfit.
   - `mergeGroups()` combines groups that share a member, ignores invalid numbers, and labels each group with its shortest description. That becomes the image's `outfit_group`.
   - If the request fails, `outfit_group` is left NULL. The selection then compares the outfit text directly, and the next review run retries the grouping, even when there's nothing new to review.
   - Earlier formats failed on real data. A label plus member list per group overran the output limit at ~150 outfits; one group number per outfit made models miscount long lists. Grouping quality depends on the review model: `qwen-3-8-27b` and `gemma-4-31b-it` grouped paraphrases correctly in tests, while `mistral-small-3.2` lumped outfits together by colour.
   - `chat()` turns `finish_reason: "length"` into a "reply was cut off" error, instead of failing later on half a JSON object.
7. Runs `runSelection()` again.

Bump `TAGS_VERSION` in `types.ts` whenever `TAG_SCHEMA` changes in a way the selection depends on. Older reviews are then redone on the next run.

### select (`pipeline/select.ts`)

See [Selection algorithm](#selection-algorithm). Synchronous; runs in well under a second for a few hundred images. Called after analyze and tag, on every settings change, override change and reference toggle, unless a job is running for that dataset.

### caption (`pipeline/caption.ts`)

`buildPrompt(settings)` builds an instruction listing what to describe and what to leave out. It changes with `captionStyle` and `captionDescribeHair`, and appends `captionInstructions`. `clean()` strips "Caption:" prefixes, quotes and extra whitespace, and adds the trigger word at the front if the model left it out. `captionImage(id)` is also used by the single-image Regenerate endpoint.

### export (`pipeline/export.ts`)

Deletes and recreates `data/output/<dataset>/{selected,reserve,rejected}`, copies files (sub-folders flattened to `a__b.jpg`, with collisions numbered), writes `<stem>.txt` for selected images, and writes `report.json`. Nothing outside those three folders and the report is touched.

## Cropping

Crops never modify input files. `src/crop.ts` has the shared pieces:
- `parseCrop()` validates untrusted input: it clamps to the image, rejects tiny crops, and treats the full image as no crop.
- `cropPixels()` converts a crop to pixels.
- `cropKey()` makes the short id used in thumbnail names (`<sha1>-<cropKey>.webp`, see `thumbId()`).
- `loadImage(path, crop)` returns a sharp pipeline of the EXIF-rotated, cropped image. Rotation goes through a raw (lossless) intermediate, because the crop must be applied *after* rotation: the user drew it on the rotated image. Thumbnails, the Venice upload (`imageDataUrl`) and export all use it, so they agree pixel for pixel.

The worker takes an optional `crops` list (`[x, y, w, h]` or null per path) next to `paths`, and crops after `exif_transpose`, using the same rounding as `cropPixels()`.

`setImageCrop(id, crop)` (`pipeline/cropping.ts`, `PUT /api/images/:id/crop`):
1. Stores the crop and resets everything derived from the pixels: analysis, embeddings, size, selection fields, review (`tags`) and `outfit_group`. It sets `caption_stale` if there's a caption.
2. Creates the cropped thumbnail.
3. Re-analyzes the image through `analyzeRows()` (the batch analysis uses the same function). If that fails, for example because the worker isn't installed or the GPU is out of memory, the crop is still saved, a warning is returned, and the next **Scan & analyze** retries.
4. Re-selects.

Refused while a job runs on the dataset (409).

`reviewSingleImage(id)` (`POST /api/images/:id/review`) reviews one image now, subject to the same Local only and private-only checks as the batch review. The image's `outfit_group` is reset, so the next grouping run includes it.

Export cuts crops from the original pixels and re-encodes in the source format (JPEG/WebP quality 95 with 4:4:4 chroma, PNG lossless; other formats as PNG). Uncropped images are still copied byte for byte.

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
quality   = (tags.quality - 1) / 9        // unreviewed: mean quality of the dataset's reviewed images (0.6 if none)

score = 0.25·aesthetic + 0.20·sharp + 0.10·res + 0.15·ident + 0.30·quality − 0.05 per non-hard issue
```

Every image uses the same formula. Unreviewed images get the dataset's average review quality. If they used a separate local-only formula, they would land on a different scale and keep displacing reviewed images, so every replacement round would trigger more reviews.

**5. Dedup.** Go through the images that passed (and pinned ones) from pinned first, then by score. An image is a `duplicate` of the first kept image within `dedupPhashDistance` (64-bit pHash Hamming distance) or `dedupClipSimilarity` (CLIP cosine). Pinned images are never marked duplicate.

**6. Diverse pick.** Start with the pinned images. Each framing gets a quota of `round(target · mix / Σmix)`. Repeat until the target is reached:
- consider candidates whose framing quota isn't full (or all candidates if none qualify);
- take the one with the highest `score − diversity · (redundancy + 0.3 · repetition)`, where
  - `redundancy = clamp((maxCLIPSim to selected − 0.6) / 0.35)`;
  - `repetition` = for each attribute enabled in `varietyAttributes`, the share of selected images with the same value, summed.
    - Values come from the review: `outfit_group` (falling back to the outfit text), `setting`, `expression`, `view` (falling back to head yaw), `lighting`, `camera`.
    - An unknown value (not reviewed yet) counts as the *expected* share, Σ(share of each known value)². Otherwise unreviewed images would look unique and win every tie, triggering more reviews.

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
- `assertOnlineAllowed(dataset, localOnly)`: throws for datasets with the `localOnly` setting. Called at the start of `tagDataset`, `captionDataset` and `captionImage`; the `auto` job skips the review instead.
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
| PUT | `/api/images/:id/crop` | `{ crop: {x,y,w,h} \| null }` | `DatasetData & { warning }`; 409 while a job runs |
| POST | `/api/images/:id/review` | | `DatasetData`; reviews this image now |
| GET | `/api/images/:id/file` | | the original image |
| GET | `/thumbs/:thumb.webp` | | thumbnail (immutable cache); `thumb` is `<sha1>` or `<sha1>-<cropKey>` |
| GET | `/`, `/dataset/*` | | the SPA (`web/index.html`) |

## Frontend

React 19, bundled by Bun's HTML imports, so there's no Vite or separate build step. In dev, HMR is on and browser console output is forwarded to the terminal.

- `App.tsx`: minimal router (`/` and `/dataset/:name` via `history.pushState`), status banners, dataset list.
- `DatasetView.tsx`: owns `DatasetData`, the pipeline buttons, job polling, filters, sorting and the stats bar. Every change request returns the full `DatasetData`, which replaces local state.
- `SettingsPanel.tsx`: keeps a local draft and sends a debounced PATCH (600 ms for typing, immediate for selects).
- `ImageGrid.tsx` (memoized cards) and `ImageDetail.tsx` (modal, keyboard navigation, caption editor).
- `styles.css`: plain CSS with light and dark tokens on `:root`.
- Types come straight from `src/types.ts`; keep that file free of server-only imports.

## Tests

`bun test` runs the suite in `test/` (about 2 seconds). It needs no GPU, no Python venv, no API key and no network.

`test/setup.ts` is preloaded through `bunfig.toml` and makes the suite safe to run anywhere:
- `LORA_DATA_DIR` points at a new temp folder, so the database, thumbnails, inputs and exports never touch `data/`. It's deleted on exit.
- `VENICE_API_KEY` is replaced with a dummy, and `VENICE_BASE_URL` with `http://venice.test`.
- `fetch` is replaced with a function that **throws on every call**. A test that talks to Venice must stub it with `mockFetch()` from `test/helpers.ts`, so a forgotten stub fails the test instead of reaching the real API.

| File | Covers |
|---|---|
| `select.test.ts` | identity (automatic, references, group photos, background faces), every hard check, AI hard and soft issues, duplicates (hash, CLIP, pinned), overrides, target and reserve, framing quotas and fallback, the variety slider |
| `crop.test.ts` | crop validation and maths, crops on EXIF-rotated images (pixel colours checked), the cropped Venice upload, `setImageCrop` (re-analysis with a fake worker, invalidation, outdated caption, failure warning, removal, reset on file change), export of crops, single-image review |
| `ai-stages.test.ts` | review and caption stages with a mocked Venice: what gets sent, caching per model, Local only and private-only blocking with zero requests sent, early abort, partial failures, overwrite rules |
| `venice.test.ts` | model list parsing and caching, `checkModel` (fail-closed), request shape (1024 px JPEG, `venice_parameters`, JSON mode only when supported), JSON extraction, retries |
| `files.test.ts` | scan (sub-folders, change detection, deletes, unreadable files) and export (folders, captions, name flattening, report, replacing old exports, input untouched) |
| `settings.test.ts` | defaults, storing only non-default values, unknown keys |
| `caption-prompt.test.ts` | caption prompt variants and `clean()` |
| `jobs.test.ts` | job lifecycle, one job per dataset, errors, cancellation, `pool` concurrency |
| `worker.test.ts` | the worker protocol, using a fake Python script: ordering, errors, crash and restart, missing interpreter |

Helpers in `test/helpers.ts`:
- `seedImage()` inserts an analyzed row directly, with synthetic metrics and embeddings.
- `randomVec()` and `near()` build embeddings: random vectors are nearly orthogonal, which makes "different person" and "same person" easy to set up.
- `newDataset()` gives each test its own dataset name.
- `mockFetch()`, `modelsPayload()` and `chatReply()` fake the Venice API.

Tests use generated images only. Never use `images-for-testing/` in tests.

The real worker (`worker/main.py` with its models) isn't covered by the suite. To check it, run **Scan & analyze** on a local dataset.

## Common changes

**New setting**: add it to `Settings` and `DEFAULT_SETTINGS` in `src/types.ts`, use it in the pipeline, and add a control in `SettingsPanel.tsx`. Stored settings are merged over the defaults, so existing datasets pick up the default automatically.

**New rejection reason**: push a code in `hardReasons()`, and add a label in `REASON_LABELS` and a row in the user guide's reason table.

**New vision-model field or issue**: extend `VisionTags` / `ISSUES` (and `HARD_ISSUES` if it should reject), plus `TAG_SCHEMA` and `PROMPT` in `tag.ts`. Changing the review model in Settings re-reviews everything; otherwise clear `tags_model` in SQL to force it.

**New local metric**: compute it in `Analyzer._analyze_one`, add it to `Analysis`/`WorkerAnalysis`, and use it in `select.ts`. Set `analysis = NULL` for the dataset to recompute.

**New caption style**: extend `CaptionStyle`, add a branch in `buildPrompt()`, and an option in `SettingsPanel`.

## Rules and gotchas

- The `test-character` dataset (a copy of `images-for-testing/`) has **Local only** turned on. Leave it on. Test Venice features on the `synthetic-demo` dataset of generated images instead.
- **`images-for-testing/` is local-only.** Never commit it. Never send it, or anything derived from it (thumbnails, crops, base64), to Venice or any other online service. That includes opening it with AI tools that upload images. Use it only to test the local pipeline. Test Venice code with a synthetic image or images cleared for upload. See `CLAUDE.md`.
- Input files are read-only to the app; only `data/output/` and `data/.cache/` are written.
- `runSelection()` is skipped while a job runs on that dataset, so it doesn't race the job's own selection; the job reselects at the end.
- `bun:sqlite` is opened with `strict: true`: named parameters don't take a `$` prefix in the object.
- `Float32Array` views on SQLite blobs are created from a copy (`toFloat32`) to avoid alignment errors.
- `pkill -f "bun src/server.ts"` also matches the shell running it; use `pgrep`/`kill` with a PID instead.

## Known gaps

- The Venice review and caption prompts have been checked against the live API only with a synthetic illustration (private models: gemma-4-31b-it, gemma-4-uncensored, mistral-small-3.2, qwen3-vl-235b, qwen-3-8-27b), not with real photo datasets. Expect to tune the prompts after real runs.
- The real Python worker and the HTTP routes in `server.ts` have no automated tests.
- No schema migrations.
- Job state isn't saved across restarts.
- InsightFace `buffalo_l` weights are licensed for non-commercial research use only.
