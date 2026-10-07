import { join } from "node:path";
import { db, getRow, getSettings, setCaption } from "../db";
import { pool, type JobContext } from "../jobs";
import type { Settings } from "../types";
import { chatText } from "../venice";
import { datasetDir } from "./scan";

const SYSTEM = `You write training captions for a character LoRA: a fine-tune that teaches a text-to-image model one specific person. Good captions describe everything that changes from photo to photo and leave out the person's permanent features, so those get learned under the person's name. Output only the caption.`;

function buildPrompt(s: Settings): string {
  const name = s.triggerWord.trim() || "the person";
  const fixed = ["face shape and facial features", "eye color", "skin tone", "ethnicity", "age", "body type"];
  if (!s.captionDescribeHair) fixed.push("hair color and hairstyle");
  const varying = [
    "shot type and camera angle",
    "pose and body position",
    "facial expression and gaze direction",
    "clothing and accessories",
    ...(s.captionDescribeHair ? ["hairstyle and hair color"] : []),
    "makeup if notable",
    "setting and background",
    "lighting",
    "photo style (e.g. smartphone snapshot, studio portrait, film photo)",
  ];
  const extra = s.captionInstructions.trim() ? `\nAdditional instructions: ${s.captionInstructions.trim()}` : "";

  if (s.captionStyle === "tags") {
    return `Write comma-separated booru-style tags for this photo. The person is named "${name}".
- The first tag must be exactly: ${name}
- Then tag: ${varying.join(", ")}.
- Do not tag permanent traits: ${fixed.join(", ")}.
- Tag visible defects (watermark, text, blur, filter) so the model doesn't learn them as part of the person.
- Output only the tags on one line.${extra}`;
  }
  return `Write one caption for this photo. The person in it is named "${name}"${s.subjectClass ? `, a ${s.subjectClass}` : ""}.
- Start the caption with "${name}".
- Describe: ${varying.join(", ")}.
- Do not describe permanent traits: ${fixed.join(", ")}.
- Mention visible defects (watermark, text overlay, blur, heavy filter) so the model doesn't learn them as part of the person.
- One paragraph of plain natural language, 40-90 words. No lists, quotes or preamble.${extra}`;
}

function clean(text: string, s: Settings): string {
  let c = text
    .replace(/^\s*(caption|tags)\s*:\s*/i, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const trigger = s.triggerWord.trim();
  if (trigger && !c.toLowerCase().includes(trigger.toLowerCase())) c = `${trigger}, ${c}`;
  return c;
}

export async function captionImage(id: number): Promise<string> {
  const row = getRow(id);
  if (!row) throw new Error(`Image ${id} not found`);
  const s = getSettings(row.dataset);
  const text = await chatText({
    model: s.captionModel,
    system: SYSTEM,
    prompt: buildPrompt(s),
    imagePath: join(datasetDir(row.dataset), row.rel_path),
    maxTokens: 400,
  });
  const caption = clean(text, s);
  if (!caption) throw new Error("Model returned an empty caption");
  setCaption(id, caption, s.captionModel);
  return caption;
}

/** Caption selected images. Without `overwrite`, images that already have a caption are skipped. */
export async function captionDataset(dataset: string, ctx: JobContext, overwrite = false) {
  const s = getSettings(dataset);
  if (!s.triggerWord.trim()) throw new Error("Set a trigger word in the settings before captioning");
  const todo = db
    .query<{ id: number; rel_path: string }, [string]>(
      `SELECT id, rel_path FROM images WHERE dataset = ? AND status = 'selected'
       ${overwrite ? "" : "AND (caption IS NULL OR caption = '')"} ORDER BY rel_path`,
    )
    .all(dataset);
  if (!todo.length) return "All selected images already have captions";

  ctx.stage(`Captioning with ${s.captionModel}`, todo.length);
  const errors: string[] = [];
  let ok = 0;
  await pool(todo, s.concurrency, ctx, async (row) => {
    try {
      await captionImage(row.id);
      ok++;
    } catch (e) {
      errors.push(`${row.rel_path}: ${(e as Error).message}`);
      if (ok === 0 && errors.length >= 3) throw new Error(`Venice requests are failing: ${(e as Error).message}`);
    }
  });
  if (errors.length) console.warn(`[caption ${dataset}] ${errors.length} failures:\n  ${errors.join("\n  ")}`);
  return `Captioned ${ok}/${todo.length}${errors.length ? ` (${errors.length} failed: ${errors[0]})` : ""}`;
}
