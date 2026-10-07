# LoRA Dataset Helper

A local web app that picks the best images for a **character LoRA** from a folder, then captions them.

1. **Analyze locally** (Python worker on your GPU): resolution, sharpness, exposure, face detection, face identity (InsightFace), CLIP embeddings and LAION aesthetic score.
2. **AI review** (Venice AI vision model): framing, view, pose, expression, outfit, problems (cropped head, occlusion, watermark, other people, filters…) and a 1–10 quality rating. Only images that pass the local filters are sent.
3. **Select**: rejects failures and near-duplicates, then picks a varied set (quality vs. variety slider, framing mix of close-up / half / full body). Pin or exclude any image by hand.
4. **Caption** the selection with the trigger word: natural language (Krea 2, Flux, Qwen-Image) or booru tags.
5. **Export** to `data/output/<dataset>/selected/` (image + `.txt` caption), plus `reserve/`, `rejected/` and a `report.json`.

Input files are never modified.

## Documentation

- [User Guide](docs/user-guide.md): installation, workflow, review screen, settings, rejection reasons, captions, privacy, troubleshooting
- [Developer Guide](docs/developer-guide.md): architecture, data model, pipeline and selection algorithm, worker protocol, HTTP API, how to extend

## Setup

Requires [Bun](https://bun.com), Python 3.12, and ideally an NVIDIA GPU (CPU works, but slower).

```sh
bun install
bun run setup:worker          # creates worker/.venv (torch, open_clip, insightface, ...)
cp .env.example .env          # then add your VENICE_API_KEY
bun run dev                   # http://localhost:3000
```

The first analysis downloads the models (~1 GB) into `data/.cache/models/`.

## Usage

Put each character's images in its own folder under `data/input/`, e.g. `data/input/jane/`, then open it in the app and work through steps 1–4. Settings (trigger word, target count, thresholds, models, caption style) are saved per dataset, and changing a selection setting re-runs the selection immediately.

## Layout

```
src/            Bun server (API, SQLite, pipeline)
  pipeline/     scan, analyze, tag (Venice), select, caption (Venice), export
  worker.ts     client for the Python worker (JSON lines over stdin/stdout)
  venice.ts     Venice API client
worker/main.py  Python analysis worker
web/            React UI (bundled by Bun's HTML imports)
data/input/     your datasets (git-ignored)
data/output/    exports (git-ignored)
data/.cache/    SQLite DB, thumbnails, model weights (git-ignored)
```

## Licensing note

InsightFace's `buffalo_l` face models are licensed for non-commercial research use only.
