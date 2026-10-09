import { join } from "node:path"
import { cropFromJson, flipFromDb } from "../crop"
import { db, getRow, getSettings } from "../db"
import { type JobContext, pool } from "../jobs"
import {
  EXPRESSIONS,
  ISSUES,
  LIGHTING_KINDS,
  SETTINGS_KINDS,
  type Settings,
  TAGS_VERSION,
  type VisionTags,
} from "../types"
import { assertOnlineAllowed, chatJson, checkModel } from "../venice"
import { datasetDir } from "./scan"
import { runSelection } from "./select"

export const TAG_SCHEMA = {
  name: "image_assessment",
  schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "framing",
      "view",
      "camera",
      "pose",
      "expression",
      "outfit",
      "setting",
      "background",
      "lighting",
      "issues",
      "quality",
      "note",
    ],
    properties: {
      framing: { type: "string", enum: ["closeup", "half", "full"] },
      view: {
        type: "string",
        enum: ["front", "three_quarter", "profile", "back"],
      },
      camera: { type: "string", enum: ["eye_level", "high", "low"] },
      pose: { type: "string" },
      expression: { type: "string", enum: [...EXPRESSIONS] },
      outfit: { type: "string" },
      setting: { type: "string", enum: [...SETTINGS_KINDS] },
      background: { type: "string" },
      lighting: { type: "string", enum: [...LIGHTING_KINDS] },
      issues: { type: "array", items: { type: "string", enum: [...ISSUES] } },
      quality: { type: "integer", minimum: 1, maximum: 10 },
      note: { type: "string" },
    },
  },
}

export const SYSTEM = `You are a meticulous photo editor curating a training dataset for a character LoRA, a model that learns one specific person's likeness. Assess each image objectively and strictly. Reply with a single JSON object and nothing else.`

export const PROMPT = `Assess this photo of the main subject. Fields:
- framing: "closeup" (head and shoulders), "half" (waist or mid-thigh up), "full" (most of the body, knees or lower visible).
- view: which way the subject's face/body is turned relative to the camera.
- camera: camera height relative to the subject.
- pose: a few words.
- expression: one of ${EXPRESSIONS.join(", ")}.
- outfit: the subject's visible clothing as color + garment, at most 6 words, e.g. "black hoodie, blue jeans". Use the same wording for the same clothes.
- setting: one of ${SETTINGS_KINDS.join(", ")} (indoor_other = office, shop, gym, restaurant...; event = party, wedding, stage...).
- background: a few words describing what is behind the subject.
- lighting: one of ${LIGHTING_KINDS.join(", ")}.
- issues: every problem that applies, from:
  blurry (subject out of focus), motion_blur, noise_or_compression, bad_lighting (harsh shadows on the face, very dim, strong color cast),
  cropped_head (top of head or chin cut off by the frame), cropped_limbs (hands/feet awkwardly cut off), face_occluded (face partly hidden by hand, phone, hair, mask, object),
  sunglasses, multiple_people (another person clearly visible), watermark_or_text (logos, captions, watermarks, UI overlays),
  heavy_filter_or_edit (beauty filter, face-tune, heavy color grading, stickers), bad_anatomy (distorted body/face, e.g. AI artifacts or lens distortion), unusual_crop.
  Use an empty list if there are none.
- quality: 1-10, how useful this image is for learning the subject's likeness (sharp detailed face, natural look, good light = high).
- note: one short sentence with anything else notable.`

/**
 * Only the groups of equivalent outfits are requested; everything unlisted is its own outfit.
 * This keeps the reply short and needs no counting (asking for one value per description made
 * models miscount long lists or run out of output tokens).
 */
const GROUP_SCHEMA = {
  name: "outfit_groups",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["same"],
    properties: {
      same: {
        type: "array",
        items: { type: "array", items: { type: "integer" } },
      },
    },
  },
}

const MAX_GROUP_ITEMS = 400

const normalizeOutfit = (o: string) =>
  o
    .toLowerCase()
    .replace(/[^\p{L}\p{N}, ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()

/**
 * Turn the model's groups of indices into description → label. Groups that share a member are
 * merged; invalid indices are ignored. Each group is labelled with its shortest description.
 */
export function mergeGroups(
  unique: string[],
  groups: unknown[],
): Map<string, string> {
  const parent = unique.map((_, i) => i)
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]]
      i = parent[i]
    }
    return i
  }
  for (const g of groups) {
    if (!Array.isArray(g)) continue
    const valid = g.filter(
      (i): i is number => Number.isInteger(i) && i >= 0 && i < unique.length,
    )
    for (const i of valid.slice(1)) parent[find(i)] = find(valid[0])
  }
  const label = new Map<number, string>()
  unique.forEach((u, i) => {
    const root = find(i)
    const current = label.get(root)
    if (current === undefined || u.length < current.length) label.set(root, u)
  })
  return new Map(unique.map((u, i) => [u, label.get(find(i)) ?? u]))
}

/**
 * Give every reviewed image an outfit group, so "black hoodie" and "dark hooded sweatshirt"
 * count as the same outfit. Sends only the outfit descriptions (text, no images) in one request.
 * Returns whether a request was sent, and a note if grouping failed.
 */
export async function groupOutfits(
  dataset: string,
  s: Settings,
): Promise<{ requested: boolean; note: string | null }> {
  const rows = db
    .query<{ id: number; outfit: string | null }, [string]>(
      `SELECT id, json_extract(tags, '$.outfit') AS outfit FROM images
       WHERE dataset = ? AND tags IS NOT NULL`,
    )
    .all(dataset)
  const unique = [
    ...new Set(
      rows.map((r) => normalizeOutfit(r.outfit ?? "")).filter(Boolean),
    ),
  ]
  const groupOf = new Map(unique.map((u) => [u, u]))
  let note: string | null = null
  let requested = false

  if (unique.length > 1 && unique.length <= MAX_GROUP_ITEMS) {
    requested = true
    try {
      const list = unique.map((u, i) => `${i}: ${u}`).join("\n")
      const reply = await chatJson<{ same: unknown }>({
        model: s.tagModel,
        system:
          "You organise photo metadata. Reply with a single JSON object and nothing else.",
        prompt: `These are outfit descriptions from photos of one person, numbered 0 to ${unique.length - 1}. Decide which describe the same outfit: the same main garments and colors, ignoring wording differences and small accessories.\nReply with "same": a list of groups, each a list of the numbers of descriptions that are the same outfit. Only include groups of 2 or more; leave out descriptions that match nothing else. Use an empty list if all outfits are different.\n\n${list}`,
        schema: GROUP_SCHEMA,
        requirePrivate: s.privateModelsOnly,
        maxTokens: Math.min(16_000, 500 + unique.length * 8),
      })
      if (!Array.isArray(reply.same)) throw new Error("reply has no groups")
      for (const [u, label] of mergeGroups(unique, reply.same)) {
        groupOf.set(u, label)
      }
    } catch (e) {
      note = `outfit grouping failed (${(e as Error).message}); exact descriptions used instead`
    }
  } else if (unique.length > MAX_GROUP_ITEMS) {
    note = `too many distinct outfits to group (${unique.length}); exact descriptions used instead`
  }

  // After a failure, leave groups empty: the selection then compares the outfit text directly,
  // and the next review run retries the grouping.
  const update = db.query("UPDATE images SET outfit_group = ? WHERE id = ?")
  db.transaction(() => {
    for (const r of rows) {
      const n = normalizeOutfit(r.outfit ?? "")
      update.run(n && !note ? (groupOf.get(n) ?? n) : null, r.id)
    }
  })()
  return { requested, note }
}

type Candidate = {
  id: number
  rel_path: string
  crop: string | null
  flip: string | null
}

/** Review one image (the cropped region, if cropped) and store the result. */
async function reviewImage(row: Candidate, dir: string, s: Settings) {
  const tags = await chatJson<VisionTags>({
    model: s.tagModel,
    system: SYSTEM,
    prompt: PROMPT,
    imagePath: join(dir, row.rel_path),
    crop: cropFromJson(row.crop),
    flip: flipFromDb(row.flip),
    schema: TAG_SCHEMA,
    requirePrivate: s.privateModelsOnly,
  })
  tags.v = TAGS_VERSION
  tags.issues = (tags.issues ?? []).filter((i) =>
    (ISSUES as readonly string[]).includes(i),
  )
  tags.quality = Math.min(
    10,
    Math.max(1, Math.round(Number(tags.quality) || 5)),
  )
  // The outfit group is set by the next grouping run; until then the outfit text is used.
  db.query(
    "UPDATE images SET tags = ?, tags_model = ?, outfit_group = NULL WHERE id = ?",
  ).run(JSON.stringify(tags), s.tagModel, row.id)
}

/** Review a single image now (detail view button), then re-select. */
export async function reviewSingleImage(id: number): Promise<void> {
  const row = getRow(id)
  if (!row) throw new Error(`Image ${id} not found`)
  const s = getSettings(row.dataset)
  assertOnlineAllowed(row.dataset, s.localOnly)
  if (!row.analysis) throw new Error("Analyze the image locally first")
  await checkModel(s.tagModel, s.privateModelsOnly)
  await reviewImage(row, datasetDir(row.dataset), s)
  runSelection(row.dataset)
}

/** Rows of the dataset matching `where` that lack an up-to-date review from `model`. */
function needingReview(dataset: string, model: string, where: string) {
  return db
    .query<Candidate, [string, string, number]>(
      `SELECT id, rel_path, crop, flip FROM images WHERE dataset = ? AND (${where})
         AND (tags IS NULL OR tags_model IS NOT ?
              OR COALESCE(json_extract(tags, '$.v'), 0) != ?)
       ORDER BY override = 'include' DESC, score DESC`,
    )
    .all(dataset, model, TAGS_VERSION)
}

const CANDIDATE = "status IN ('selected', 'reserve') OR override = 'include'"

/**
 * Review images with the vision model and re-select.
 *
 * 1. Review the best `reviewMultiplier × target` candidates (and every pinned image) by
 *    local score. 0 reviews every candidate.
 * 2. Re-select. If a reviewed image got rejected and an unreviewed one took its place,
 *    review the newcomers and repeat until every selected image has been reviewed.
 * 3. Group outfits so the variety check can compare them.
 */
export async function tagDataset(dataset: string, ctx: JobContext) {
  const s = getSettings(dataset)
  assertOnlineAllowed(dataset, s.localOnly)
  const dir = datasetDir(dataset)

  ctx.stage("Pre-selecting with local metrics", 0)
  runSelection(dataset)

  const candidates = db
    .query<{ id: number; pinned: number }, [string]>(
      `SELECT id, override = 'include' AS pinned FROM images
       WHERE dataset = ? AND (${CANDIDATE})
       ORDER BY override = 'include' DESC, score DESC`,
    )
    .all(dataset)
  const limit =
    s.reviewMultiplier > 0
      ? Math.ceil(s.targetCount * s.reviewMultiplier)
      : Number.POSITIVE_INFINITY
  const inPool = new Set(
    candidates.filter((c, i) => c.pinned || i < limit).map((c) => c.id),
  )
  const firstRound = needingReview(dataset, s.tagModel, CANDIDATE).filter((r) =>
    inPool.has(r.id),
  )

  const attempted = new Set<number>()
  const errors: string[] = []
  let ok = 0
  let modelChecked = false

  const review = async (rows: Candidate[], label: string) => {
    if (!modelChecked) {
      await checkModel(s.tagModel, s.privateModelsOnly)
      modelChecked = true
    }
    ctx.stage(label, rows.length)
    for (const r of rows) attempted.add(r.id)
    await pool(rows, s.concurrency, ctx, async (row) => {
      try {
        await reviewImage(row, dir, s)
        ok++
      } catch (e) {
        errors.push(`${row.rel_path}: ${(e as Error).message}`)
        // Every request failing (bad key, unknown model, ...) means the rest will fail too.
        if (ok === 0 && errors.length >= 3)
          throw new Error(
            `Venice requests are failing: ${(e as Error).message}`,
          )
      }
    })
  }

  if (firstRound.length) {
    await review(firstRound, `Reviewing with ${s.tagModel}`)
  }
  // Replacements: selected images that haven't been reviewed yet.
  for (let round = 1; round <= 20; round++) {
    runSelection(dataset)
    const missing = needingReview(
      dataset,
      s.tagModel,
      "status = 'selected'",
    ).filter((r) => !attempted.has(r.id))
    if (!missing.length) break
    await review(missing, `Reviewing replacements (round ${round})`)
  }

  if (!attempted.size) {
    // Nothing to review, but outfits may still need grouping (new reviews' groups failed last time).
    const ungrouped = db
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM images WHERE dataset = ?
         AND tags IS NOT NULL AND outfit_group IS NULL`,
      )
      .get(dataset)?.n
    if (!ungrouped) return "Nothing new to review"
    ctx.stage("Grouping outfits", 0)
    const { requested, note } = await groupOutfits(dataset, s)
    runSelection(dataset)
    if (note) return `Nothing new to review. ${note}.`
    return requested
      ? "Nothing new to review. Outfits grouped."
      : "Nothing new to review"
  }

  ctx.stage("Grouping outfits", 0)
  const { note: groupNote } = await groupOutfits(dataset, s)
  ctx.stage("Selecting", 0)
  const sum = runSelection(dataset)
  const unreviewed = needingReview(dataset, s.tagModel, CANDIDATE).filter(
    (r) => !attempted.has(r.id),
  ).length

  if (errors.length)
    console.warn(
      `[tag ${dataset}] ${errors.length} failures:\n  ${errors.join("\n  ")}`,
    )
  const parts = [
    `Reviewed ${ok}/${attempted.size}${errors.length ? ` (${errors.length} failed: ${errors[0]})` : ""}`,
    `Selected ${sum.selected}`,
  ]
  if (unreviewed)
    parts.push(`${unreviewed} lower-ranked candidates not reviewed`)
  if (groupNote) parts.push(groupNote)
  return `${parts.join(". ")}.`
}
