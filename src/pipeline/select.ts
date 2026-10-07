import { db, faceEmbeddings, getSettings, listRows, parseAnalysis, parseTags, toFloat32, type ImageRow } from "../db";
import { HARD_ISSUES, type Analysis, type Framing, type ImageStatus, type Settings, type VisionTags } from "../types";

interface Item {
  row: ImageRow;
  a: Analysis | null;
  tags: VisionTags | null;
  clip: Float32Array | null;
  faces: Float32Array[];
  mainFace: number | null;
  identity: number | null;
  framing: Framing | null;
  view: string | null;
  score: number;
  reasons: string[];
  dupOf: number | null;
}

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

function dot(a: Float32Array, b: Float32Array) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

function meanNormalized(vs: Float32Array[]): Float32Array | null {
  if (!vs.length) return null;
  const out = new Float32Array(vs[0]!.length);
  for (const v of vs) for (let i = 0; i < out.length; i++) out[i]! += v[i]!;
  const n = Math.hypot(...out);
  if (!n) return null;
  for (let i = 0; i < out.length; i++) out[i]! /= n;
  return out;
}

const POPCOUNT = Array.from({ length: 16 }, (_, i) => (i & 1) + ((i >> 1) & 1) + ((i >> 2) & 1) + ((i >> 3) & 1));
function hamming(a: string, b: string) {
  if (a.length !== b.length) return Infinity;
  let d = 0;
  for (let i = 0; i < a.length; i++) d += POPCOUNT[parseInt(a[i]!, 16) ^ parseInt(b[i]!, 16)]!;
  return d;
}

/**
 * Estimate the character's face embedding. Uses the reference images if set; otherwise
 * finds the largest group of mutually similar faces (the person who appears most often).
 */
function identityCentroid(items: Item[], s: Settings): Float32Array | null {
  const refs = items.filter((it) => s.referenceImageIds.includes(it.row.id) && it.faces.length);
  if (refs.length) return meanNormalized(refs.map((it) => it.faces[it.row.main_face ?? 0] ?? it.faces[0]!));

  const largest = items.filter((it) => it.faces.length).map((it) => it.faces[0]!);
  if (!largest.length) return null;
  let seed = largest[0]!;
  let bestCount = -1;
  for (const f of largest) {
    let count = 0;
    for (const g of largest) if (dot(f, g) >= s.identityThreshold) count++;
    if (count > bestCount) [seed, bestCount] = [f, count];
  }
  let centroid = meanNormalized(largest.filter((f) => dot(f, seed) >= s.identityThreshold)) ?? seed;
  // Refine using every face, not just the largest one per image.
  for (let iter = 0; iter < 2; iter++) {
    const members: Float32Array[] = [];
    for (const it of items) {
      let best: Float32Array | null = null;
      let bestSim = s.identityThreshold;
      for (const f of it.faces) {
        const sim = dot(f, centroid);
        if (sim >= bestSim) [best, bestSim] = [f, sim];
      }
      if (best) members.push(best);
    }
    centroid = meanNormalized(members) ?? centroid;
  }
  return centroid;
}

function framingFromFace(faceHeight: number | null): Framing {
  if (faceHeight == null) return "full";
  if (faceHeight >= 0.28) return "closeup";
  if (faceHeight >= 0.1) return "half";
  return "full";
}

function viewFromYaw(yaw: number | null | undefined): string | null {
  if (yaw == null) return null;
  const y = Math.abs(yaw);
  return y < 20 ? "front" : y < 55 ? "three_quarter" : "profile";
}

function scoreItem(it: Item, s: Settings): number {
  const a = it.a!;
  const face = it.mainFace != null ? a.faces[it.mainFace] : undefined;
  const aesthetic = clamp01((a.aesthetic - 4) / 3);
  const sharp = face
    ? clamp01(Math.log(face.sharpness / s.minFaceSharpness) / Math.log(8))
    : clamp01(Math.log(a.sharpness / 50) / Math.log(8));
  const res = clamp01(Math.min(a.width, a.height) / s.preferredShortSide);
  const ident = it.identity != null ? clamp01((it.identity - s.identityThreshold) / (0.75 - s.identityThreshold)) : 0;
  const softIssues = it.tags ? it.tags.issues.filter((i) => !HARD_ISSUES.includes(i)).length : 0;
  const base = it.tags
    ? 0.25 * aesthetic + 0.2 * sharp + 0.1 * res + 0.15 * ident + 0.3 * clamp01((it.tags.quality - 1) / 9)
    : 0.4 * aesthetic + 0.3 * sharp + 0.15 * res + 0.15 * ident;
  return Math.max(0, base - 0.05 * softIssues);
}

/** Hard checks: anything returned here rejects the image (unless manually included). */
function hardReasons(it: Item, s: Settings): string[] {
  const a = it.a!;
  if (a.error) return ["unreadable"];
  const reasons: string[] = [];
  if (Math.min(a.width, a.height) < s.minShortSide) reasons.push("low_resolution");
  if (!a.faces.length) reasons.push("no_face");
  else if (it.identity == null || it.identity < s.identityThreshold) reasons.push("different_person");
  else {
    const face = a.faces[it.mainFace!]!;
    if (face.sharpness < s.minFaceSharpness) reasons.push("blurry_face");
    const others = a.faces.filter((f, i) => i !== it.mainFace && f.bbox[3] - f.bbox[1] >= s.otherPersonMinFace);
    if (others.length) reasons.push("multiple_people");
  }
  if (a.brightness < 35 || a.brightness > 225 || a.darkClip > 0.35 || a.brightClip > 0.25) reasons.push("bad_exposure");
  if (it.tags) {
    for (const issue of it.tags.issues) if (HARD_ISSUES.includes(issue) && !reasons.includes(issue)) reasons.push(issue);
    if (it.tags.quality <= 3) reasons.push("low_quality");
  }
  return reasons;
}

export interface SelectionSummary {
  selected: number;
  reserve: number;
  rejected: number;
  pending: number;
}

/**
 * Score every analyzed image, reject failures and near-duplicates, then pick a varied set:
 * greedy max-marginal-relevance over CLIP similarity with framing quotas.
 */
export function runSelection(dataset: string): SelectionSummary {
  const s = getSettings(dataset);
  const items: Item[] = listRows(dataset).map((row) => ({
    row,
    a: parseAnalysis(row),
    tags: parseTags(row),
    clip: toFloat32(row.clip_emb),
    faces: faceEmbeddings(row),
    mainFace: null,
    identity: null,
    framing: null,
    view: null,
    score: 0,
    reasons: [],
    dupOf: null,
  }));
  const analyzed = items.filter((it) => it.a && !it.a.error);

  // Identity: match each image's faces against the character centroid.
  const centroid = identityCentroid(analyzed, s);
  for (const it of analyzed) {
    if (!centroid || !it.faces.length) continue;
    let best = 0;
    let bestSim = -1;
    it.faces.forEach((f, i) => {
      const sim = dot(f, centroid);
      if (sim > bestSim) [best, bestSim] = [i, sim];
    });
    it.mainFace = best;
    it.identity = bestSim;
  }

  for (const it of items) {
    if (!it.a) continue;
    it.reasons = hardReasons(it, s);
    if (it.a.error) continue;
    const face = it.mainFace != null ? it.a.faces[it.mainFace] : undefined;
    it.framing = it.tags?.framing ?? framingFromFace(face ? face.bbox[3] - face.bbox[1] : null);
    it.view = it.tags?.view ?? viewFromYaw(face?.pose?.[1]);
    it.score = scoreItem(it, s);
    if (it.row.override === "exclude") it.reasons = ["manual"];
  }

  const included = (it: Item) => it.row.override === "include";

  // Near-duplicates: walk from best to worst, anything too close to a kept image is a duplicate.
  const passing = analyzed
    .filter((it) => included(it) || !it.reasons.length)
    .sort((x, y) => Number(included(y)) - Number(included(x)) || y.score - x.score);
  const kept: Item[] = [];
  for (const it of passing) {
    const dup = kept.find(
      (k) =>
        hamming(k.a!.phash, it.a!.phash) <= s.dedupPhashDistance ||
        (k.clip && it.clip && dot(k.clip, it.clip) >= s.dedupClipSimilarity),
    );
    if (dup && !included(it)) {
      it.dupOf = dup.row.id;
      it.reasons = ["duplicate"];
    } else kept.push(it);
  }

  // Diverse selection.
  const selected: Item[] = kept.filter(included);
  const remaining = kept.filter((it) => !included(it));
  const mixTotal = Object.values(s.framingMix).reduce((x, y) => x + y, 0) || 1;
  const quota = Object.fromEntries(
    (Object.keys(s.framingMix) as Framing[]).map((f) => [f, Math.round((s.targetCount * s.framingMix[f]) / mixTotal)]),
  ) as Record<Framing, number>;
  const count = (pred: (it: Item) => boolean) => selected.filter(pred).length;

  while (selected.length < s.targetCount && remaining.length) {
    const open = remaining.filter((it) => !it.framing || count((x) => x.framing === it.framing) < quota[it.framing]);
    const pool = open.length ? open : remaining;
    let best = pool[0]!;
    let bestValue = -Infinity;
    for (const it of pool) {
      let maxSim = 0;
      if (it.clip) for (const sel of selected) if (sel.clip) maxSim = Math.max(maxSim, dot(it.clip, sel.clip));
      const redundancy = clamp01((maxSim - 0.6) / 0.35);
      const viewShare = selected.length && it.view ? count((x) => x.view === it.view) / selected.length : 0;
      const value = it.score - s.diversity * (redundancy + 0.3 * viewShare);
      if (value > bestValue) [best, bestValue] = [it, value];
    }
    selected.push(best);
    remaining.splice(remaining.indexOf(best), 1);
  }
  for (const it of remaining) it.reasons = ["not_selected"];

  const selectedIds = new Set(selected.map((it) => it.row.id));
  const statusOf = (it: Item): ImageStatus =>
    !it.a ? "pending" : selectedIds.has(it.row.id) ? "selected" : it.reasons[0] === "not_selected" ? "reserve" : "rejected";

  const update = db.query(
    "UPDATE images SET status = ?, score = ?, reasons = ?, framing = ?, dup_of = ?, identity = ?, main_face = ? WHERE id = ?",
  );
  const summary: SelectionSummary = { selected: 0, reserve: 0, rejected: 0, pending: 0 };
  db.transaction(() => {
    for (const it of items) {
      const status = statusOf(it);
      summary[status]++;
      update.run(
        status,
        it.a ? it.score : null,
        JSON.stringify(status === "selected" ? [] : it.reasons),
        it.framing,
        it.dupOf,
        it.identity,
        it.mainFace,
        it.row.id,
      );
    }
  })();
  return summary;
}
