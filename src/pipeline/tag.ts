import { join } from "node:path";
import { db, getSettings } from "../db";
import { pool, type JobContext } from "../jobs";
import { ISSUES, type VisionTags } from "../types";
import { assertOnlineAllowed, chatJson, checkModel } from "../venice";
import { datasetDir } from "./scan";
import { runSelection } from "./select";

export const TAG_SCHEMA = {
  name: "image_assessment",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["framing", "view", "camera", "pose", "expression", "outfit", "background", "lighting", "issues", "quality", "note"],
    properties: {
      framing: { type: "string", enum: ["closeup", "half", "full"] },
      view: { type: "string", enum: ["front", "three_quarter", "profile", "back"] },
      camera: { type: "string", enum: ["eye_level", "high", "low"] },
      pose: { type: "string" },
      expression: { type: "string" },
      outfit: { type: "string" },
      background: { type: "string" },
      lighting: { type: "string" },
      issues: { type: "array", items: { type: "string", enum: [...ISSUES] } },
      quality: { type: "integer", minimum: 1, maximum: 10 },
      note: { type: "string" },
    },
  },
};

export const SYSTEM = `You are a meticulous photo editor curating a training dataset for a character LoRA, a model that learns one specific person's likeness. Assess each image objectively and strictly. Reply with a single JSON object and nothing else.`;

export const PROMPT = `Assess this photo of the main subject. Fields:
- framing: "closeup" (head and shoulders), "half" (waist or mid-thigh up), "full" (most of the body, knees or lower visible).
- view: which way the subject's face/body is turned relative to the camera.
- camera: camera height relative to the subject.
- pose, expression, outfit, background, lighting: a few words each.
- issues: every problem that applies, from:
  blurry (subject out of focus), motion_blur, noise_or_compression, bad_lighting (harsh shadows on the face, very dim, strong color cast),
  cropped_head (top of head or chin cut off by the frame), cropped_limbs (hands/feet awkwardly cut off), face_occluded (face partly hidden by hand, phone, hair, mask, object),
  sunglasses, multiple_people (another person clearly visible), watermark_or_text (logos, captions, watermarks, UI overlays),
  heavy_filter_or_edit (beauty filter, face-tune, heavy color grading, stickers), bad_anatomy (distorted body/face, e.g. AI artifacts or lens distortion), unusual_crop.
  Use an empty list if there are none.
- quality: 1-10, how useful this image is for learning the subject's likeness (sharp detailed face, natural look, good light = high).
- note: one short sentence with anything else notable.`;

/** Ask the vision model about every image that passed the local filters and has no tags from the current model. */
export async function tagDataset(dataset: string, ctx: JobContext) {
  const s = getSettings(dataset);
  assertOnlineAllowed(dataset, s.localOnly);
  const dir = datasetDir(dataset);

  ctx.stage("Pre-selecting with local metrics", 0);
  runSelection(dataset);

  const todo = db
    .query<{ id: number; rel_path: string }, [string, string]>(
      `SELECT id, rel_path FROM images WHERE dataset = ?
         AND (status IN ('selected', 'reserve') OR override = 'include')
         AND (tags IS NULL OR tags_model IS NOT ?)
       ORDER BY score DESC`,
    )
    .all(dataset, s.tagModel);
  if (!todo.length) return "Nothing new to tag";

  await checkModel(s.tagModel, s.privateModelsOnly);
  ctx.stage(`Tagging with ${s.tagModel}`, todo.length);
  const save = db.query("UPDATE images SET tags = ?, tags_model = ? WHERE id = ?");
  const errors: string[] = [];
  let ok = 0;
  await pool(todo, s.concurrency, ctx, async (row) => {
    try {
      const tags = await chatJson<VisionTags>({
        model: s.tagModel,
        system: SYSTEM,
        prompt: PROMPT,
        imagePath: join(dir, row.rel_path),
        schema: TAG_SCHEMA,
        requirePrivate: s.privateModelsOnly,
      });
      tags.issues = (tags.issues ?? []).filter((i) => (ISSUES as readonly string[]).includes(i));
      tags.quality = Math.min(10, Math.max(1, Math.round(Number(tags.quality) || 5)));
      save.run(JSON.stringify(tags), s.tagModel, row.id);
      ok++;
    } catch (e) {
      errors.push(`${row.rel_path}: ${(e as Error).message}`);
      // Every request failing (bad key, unknown model, ...) means the rest will fail too.
      if (ok === 0 && errors.length >= 3) throw new Error(`Venice requests are failing: ${(e as Error).message}`);
    }
  });

  ctx.stage("Selecting", 0);
  const sum = runSelection(dataset);
  if (errors.length) console.warn(`[tag ${dataset}] ${errors.length} failures:\n  ${errors.join("\n  ")}`);
  return `Tagged ${todo.length - errors.length}/${todo.length}${errors.length ? ` (${errors.length} failed: ${errors[0]})` : ""}. Selected ${sum.selected}.`;
}
