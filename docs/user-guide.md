# User Guide

LoRA Dataset Helper picks the best images of one person from a folder, captions them, and copies the result into a training-ready folder. It runs on your computer; only the steps marked **Venice** send anything to the internet (see [Privacy](#privacy)).

- [Installation](#installation)
- [Quick start](#quick-start)
- [The four steps](#the-four-steps)
- [Reviewing the selection](#reviewing-the-selection)
- [Settings](#settings)
- [Why an image was rejected](#why-an-image-was-rejected)
- [Captions](#captions)
- [The exported folder](#the-exported-folder)
- [Privacy](#privacy)
- [Costs](#costs)
- [Troubleshooting](#troubleshooting)

## Installation

You need:

- [Bun](https://bun.com) 1.3 or newer
- Python 3.12 (`python3.12` on your `PATH`; set `PYTHON=/path/to/python` to use another 3.10–3.12)
- An NVIDIA GPU is recommended. Without one, analysis runs on the CPU and is several times slower.
- A [Venice AI](https://venice.ai) API key for the AI review and captions

```sh
bun install
bun run setup:worker      # one-time, downloads ~3 GB of Python packages
cp .env.example .env      # then put your key after VENICE_API_KEY=
bun run dev
```

Open <http://localhost:3000>. Change the port with `PORT=4000` in `.env`.

The first analysis also downloads about 1 GB of model weights into `data/.cache/models/`.

## Quick start

1. Make a folder per character: `data/input/jane/`. Sub-folders inside it are fine.
2. Copy that person's images into it (`.jpg`, `.jpeg`, `.png`, `.webp`, `.bmp`).
3. Open the app and click the dataset.
4. In **Settings**, enter a **trigger word** (for example `jane_doe`) and check the **target images** count.
5. Click **Run 1 + 2**. This analyzes everything locally, then has the AI review the images that passed.
6. Look through the **Selected** tab. Pin or exclude images until you're happy.
7. Click **Caption missing**, then read and edit a few captions.
8. Click **Export**. Point your trainer at `data/output/jane/selected/`.

You can rerun any step. Results are cached, so only new or changed images are processed again.

## The four steps

| Step | What it does | Runs on |
|---|---|---|
| **1. Scan & analyze** | Finds images, makes thumbnails, then measures resolution, sharpness, exposure, faces (who, where, how sharp, head angle), visual similarity and an aesthetic score. Finishes with a first selection. | Your computer |
| **2. Review with Venice** | Sends every image that passed step 1's checks to a vision model. It reports framing, view, pose, expression, outfit, background, lighting, problems, and a 1–10 quality rating. The selection is then redone using this information. | **Venice** |
| **3. Caption** | Writes a caption for each **selected** image. *Caption missing* skips images that already have one; *Redo all* replaces every caption, including your edits. | **Venice** |
| **4. Export** | Copies images into `data/output/<dataset>/`. | Your computer |

**Run 1 + 2** runs steps 1 and 2 back to back.

A progress bar shows the running step. **Cancel** stops it after the current image or batch; finished work is kept. Only one step runs per dataset at a time.

Adding, removing or editing files in the input folder is picked up the next time you run step 1. An edited file is analyzed again and loses its review and caption.

## Reviewing the selection

### Tabs

| Tab | Contains |
|---|---|
| **Selected** | Images that will be exported for training |
| **Reserve** | Good images that weren't needed to reach the target. They move into *Selected* if you raise the target or exclude something. |
| **Rejected** | Images that failed a check, with the reason shown under the thumbnail |
| **Not analyzed** | Images found by the scan but not analyzed yet |
| **All** | Everything |

Sort by **Score** (best first) or **Name**.

### Thumbnails

- **Green border**: selected. **Dashed border**: reserve. **Faded**: rejected.
- Badges: the **score** (0–100), the **framing** (close / half / full), **pinned** or **excluded** if you overrode it, **ref** if it's an identity reference, **txt** if it has a caption.
- Hover a thumbnail to use the buttons:
  - **✓** always include, even if a check failed
  - **✕** always exclude
  - **↺** remove your override and let the app decide

### The summary bar

Shows how many images are selected out of the target, the count per framing against its quota (for example `9/12` close-ups), and the spread of views (front, three-quarter, profile, back).

### Detail view

Click a thumbnail to open it full size. Use **←** / **→** to move through the current tab and **Esc** to close. The panel shows:

- Include / exclude buttons
- **Use as reference**: marks this image's face as the definition of the character (see [Identity](#identity))
- Rejection reasons. For a near-duplicate, it also shows which image it duplicates.
- The caption editor: **Save** keeps your edit, **Generate / Regenerate** asks the AI for a new one
- The AI review and the local measurements

### Identity

The app works out who the character is by finding the face that appears most often. If the folder is mostly someone else, or the wrong person is being picked, open two or three clear photos of the right person and click **Use as reference**. Identity is then measured against those faces only. **Clear (use automatic)** in Settings undoes this.

## Settings

Settings are saved per dataset. Changing a selection or filter setting redoes the selection immediately. No AI calls are made, because the earlier results are reused.

### Character

| Setting | Default | Notes |
|---|---|---|
| Trigger word | *(empty)* | The name captions use for the person. Required for captioning. Choose something the base model doesn't already know, e.g. `jnd0e` or `jane_doe`. |
| Class | `woman` | Added after the name in natural-language captions ("jane_doe, a woman, …"). |

### Selection

| Setting | Default | Notes |
|---|---|---|
| Target images | 30 | 20–40 is typical for a character LoRA. |
| Variety vs quality | 50% | 0% takes the highest scores. Higher values prefer images that look different from those already picked (other outfits, places, angles). |
| Framing mix | 0.40 / 0.35 / 0.25 | Share of close-up / half body / full body. Values are relative and don't need to add up to 1. If there aren't enough of one kind, the rest of the target is filled with others. |

### Filters

| Setting | Default | Notes |
|---|---|---|
| Min short side | 768 px | Smaller images are rejected. |
| Preferred short side | 1024 px | Images at or above this size get the full resolution score. |
| Min face sharpness | 40 | Lower is rejected as blurry. To tune it, compare the *Face sharpness* value of sharp and blurry images in the detail view. |
| Identity threshold | 0.40 | How closely a face must match the character. Same-person photos usually score 0.6–0.9. Raise it if look-alikes get through; lower it if real photos of the person are rejected. |
| Other-person face size | 0.08 | A second face taller than this share of the image height counts as *multiple people*. Smaller background faces are ignored. |
| Duplicate: hash distance | 8 | Images whose layout is this similar or more are duplicates. 0 means pixel-identical; higher catches more. |
| Duplicate: similarity | 0.95 | Images whose content is this similar or more are duplicates. Lower catches more (e.g. a burst of shots). |

### Venice AI

| Setting | Default | Notes |
|---|---|---|
| Review model | `qwen-3-8-flash` | Used for step 2. The list shows only models that accept images, with the price per million input/output tokens. Models marked *no JSON mode* work but are less reliable for the review. |
| Caption model | `qwen-3-8-27b` | Used for step 3. |
| Parallel requests | 4 | Lower it if you get rate-limit errors. |

### Captions

| Setting | Default | Notes |
|---|---|---|
| Style | Natural language | Natural language for Krea 2, Flux and Qwen-Image; booru tags for Illustrious, Pony and NoobAI. |
| Describe hair | on | Turn off if the hairstyle is part of the character and should come with the trigger word. |
| Extra instructions | *(empty)* | Added to the caption prompt, e.g. "Always mention the tattoo on the left arm." |

## Why an image was rejected

| Reason | Meaning | What to do if it's wrong |
|---|---|---|
| Resolution too low | Short side below *Min short side* | Lower the setting, or pin the image |
| No face found | No face detected (back views, faces turned far away, tiny faces) | Pin it if you want it anyway |
| Different person | The main face doesn't match the character | Set identity references, or lower *Identity threshold* |
| Blurry face | Face sharpness below *Min face sharpness* | Lower the setting |
| Bad exposure | Very dark, very bright, or large clipped areas | Pin it |
| Multiple people | Another face larger than *Other-person face size*, or the AI saw another person | Raise the setting, or pin it |
| Near-duplicate | Too similar to a better-scoring image. Only the best of each group is kept. | Adjust the duplicate settings, or pin it |
| Head cropped, Face hidden, Watermark / text, Heavy filter / edit, Bad anatomy | Reported by the AI review | Pin it if the AI is wrong |
| Low quality (AI) | AI quality rating 3/10 or lower | Pin it |
| Excluded manually | You excluded it | Click ↺ |
| Not picked (reserve) | Passed every check but wasn't needed for the target | Raise the target, or pin it |

Less serious problems the AI reports (blur, noise, bad lighting, cropped limbs, sunglasses, odd crop) don't reject an image. They lower its score instead.

## Captions

A good character-LoRA caption **describes what changes from photo to photo** (pose, expression, clothes, place, light, camera angle, photo style) and **leaves out what never changes** (face, eye color, skin tone, body type). The model then learns the unchanging parts as "what the trigger word means". The caption prompt follows this rule.

Natural-language example (Krea 2):

> jane_doe, a woman, in a medium close-up shot from eye level, smiling softly and looking at the camera, wearing a cream knit sweater and small gold earrings, wavy shoulder-length brown hair, sitting by a window in a cozy café with warm afternoon light, smartphone photo.

Tips:

- Read 5–10 captions before exporting. Fix anything describing the face or body, or anything that's wrong.
- If an image has something you don't want learned (a watermark, a strange filter), make sure the caption mentions it.
- Click **Save** after editing a caption. *Caption missing* never overwrites captions; *Redo all* does.

## The exported folder

```
data/output/<dataset>/
  selected/       image + same-named .txt caption   ← train on this
  reserve/        images that passed but weren't picked
  rejected/       rejected images
  report.json     settings used, and per image: status, score, reasons, framing, caption
```

- Images are **copied**; your input folder is never changed.
- Each export replaces the previous `selected/`, `reserve/` and `rejected/` folders for that dataset.
- Images from sub-folders are renamed `sub__name.jpg` so names don't collide.
- The `image.txt` next to `image.jpg` convention works with kohya-ss, ai-toolkit, OneTrainer and similar trainers.
- Images are exported at their original size; your trainer handles resizing and bucketing.

## Privacy

| Data | Where it goes |
|---|---|
| Your original images | Stay on your computer |
| Thumbnails, measurements, database | `data/.cache/` on your computer |
| **Step 2 (review)** | A copy downscaled to at most 1024 px, for **only** the images that passed the local checks, is sent to Venice AI |
| **Step 3 (caption)** | The same kind of downscaled copy, for **selected** images only |
| Model weights | Downloaded once from Hugging Face and GitHub; nothing is uploaded |

Venice's own system prompt is turned off for these requests. To keep a dataset fully offline, use only steps 1 and 4 and write captions by hand in the detail view.

## Costs

Only steps 2 and 3 cost money, billed by Venice per token. A downscaled image is roughly 1,000 input tokens. With the default models, reviewing a few hundred images and captioning 30 usually costs a few cents. Check current prices in the model list in Settings.

## Troubleshooting

| Problem | Fix |
|---|---|
| "Python worker is not set up" | Run `bun run setup:worker`, then restart the app. |
| Analysis is slow / the server log says the face models use CPU | Rerun `bun run setup:worker`. Check that its last lines show `cuda: True` and `CUDAExecutionProvider`. |
| "VENICE_API_KEY is not set" | Create `.env` from `.env.example`, add the key, restart the app. |
| "Venice requests are failing: …" | The first requests all failed, so the step stopped. Usually the key is wrong, the model id no longer exists, or you're out of credit. The message includes Venice's reply. |
| Some images failed to review or caption | The step summary and the server log list them. Run the step again; only missing ones are retried. |
| "Set a trigger word…" | Enter a trigger word in Settings before captioning. |
| Almost everything is "Different person" | The automatic identity picked someone else. Set identity references. |
| Nearly everything is selected | The folder has fewer good images than the target. Lower *Target images*, or add images. |
| A new dataset folder doesn't appear | Click **Refresh** on the dataset list. Folder names starting with `.` are ignored. |
