import { describe, expect, test } from "bun:test";
import { getRow, listRows, saveSettings, toRecord } from "../src/db";
import { runSelection } from "../src/pipeline/select";
import { near, newDataset, randomVec, seedImage, tags } from "./helpers";

const person = randomVec(512, 1);
const stranger = randomVec(512, 2);
let faceSeed = 1000;
const me = (info = {}) => ({ info, emb: near(person, ++faceSeed) });
const other = (info = {}) => ({ info, emb: near(stranger, ++faceSeed) });

function records(dataset: string) {
  return listRows(dataset).map(toRecord);
}
const rec = (id: number) => toRecord(getRow(id)!);

describe("identity", () => {
  test("keeps the person who appears most often and rejects others", () => {
    const ds = newDataset();
    const mine = [1, 2, 3, 4, 5].map(() => seedImage(ds, { faces: [me()] }));
    const theirs = [1, 2].map(() => seedImage(ds, { faces: [other()] }));
    runSelection(ds);
    for (const id of mine) expect(rec(id).status).toBe("selected");
    for (const id of theirs) expect(rec(id).reasons).toContain("different_person");
  });

  test("reference images override the automatic choice", () => {
    const ds = newDataset();
    [1, 2, 3, 4].forEach(() => seedImage(ds, { faces: [me()] }));
    const a = seedImage(ds, { faces: [other()] });
    const b = seedImage(ds, { faces: [other()] });
    saveSettings(ds, { referenceImageIds: [a] });
    runSelection(ds);
    expect(rec(b).status).toBe("selected");
    expect(records(ds).filter((r) => r.reasons.includes("different_person"))).toHaveLength(4);
  });

  test("picks the matching face in a group photo as the main face", () => {
    const ds = newDataset();
    [1, 2, 3].forEach(() => seedImage(ds, { faces: [me()] }));
    // The stranger's face is the largest (index 0); the character's is small but above the noise level.
    const group = seedImage(ds, { faces: [other({ height: 0.3 }), me({ height: 0.15 })] });
    runSelection(ds);
    const r = getRow(group)!;
    expect(r.main_face).toBe(1);
    expect(toRecord(r).reasons).toContain("multiple_people");
  });

  test("ignores small background faces", () => {
    const ds = newDataset();
    [1, 2].forEach(() => seedImage(ds, { faces: [me()] }));
    const crowd = seedImage(ds, { faces: [me({ height: 0.2 }), other({ height: 0.03 }), other({ height: 0.02 })] });
    runSelection(ds);
    expect(rec(crowd).status).toBe("selected");
  });
});

describe("hard checks", () => {
  test.each([
    ["low_resolution", { analysis: { width: 500, height: 700 } }],
    ["no_face", { faces: [] }],
    ["blurry_face", { faces: [me({ sharpness: 10 })] }],
    ["bad_exposure", { analysis: { brightness: 20 } }],
    ["bad_exposure", { analysis: { brightClip: 0.4 } }],
    ["unreadable", { analysis: { error: "broken" } as any }],
  ] as const)("%s", (reason, opts: any) => {
    const ds = newDataset();
    [1, 2].forEach(() => seedImage(ds, { faces: [me()] }));
    const id = seedImage(ds, { faces: [me()], ...opts });
    runSelection(ds);
    expect(rec(id).status).toBe("rejected");
    expect(rec(id).reasons).toContain(reason);
  });

  test("hard issues from the AI review reject; soft issues only lower the score", () => {
    const ds = newDataset();
    [1, 2].forEach(() => seedImage(ds, { faces: [me()] }));
    const watermark = seedImage(ds, { faces: [me()], tags: tags({ issues: ["watermark_or_text"] }) });
    const lowQ = seedImage(ds, { faces: [me()], tags: tags({ quality: 2 }) });
    const clean = seedImage(ds, { faces: [me()], tags: tags() });
    const noisy = seedImage(ds, { faces: [me()], tags: tags({ issues: ["noise_or_compression", "sunglasses"] }) });
    runSelection(ds);
    expect(rec(watermark).reasons).toContain("watermark_or_text");
    expect(rec(lowQ).reasons).toContain("low_quality");
    expect(rec(noisy).status).toBe("selected");
    expect(rec(noisy).score!).toBeCloseTo(rec(clean).score! - 0.1, 5);
  });

  test("thresholds come from the settings", () => {
    const ds = newDataset();
    [1, 2].forEach(() => seedImage(ds, { faces: [me()] }));
    const small = seedImage(ds, { faces: [me()], analysis: { width: 700, height: 900 } });
    runSelection(ds);
    expect(rec(small).reasons).toContain("low_resolution");
    saveSettings(ds, { minShortSide: 512 });
    runSelection(ds);
    expect(rec(small).status).toBe("selected");
  });
});

describe("duplicates", () => {
  test("same perceptual hash: keeps the better image", () => {
    const ds = newDataset();
    const better = seedImage(ds, { faces: [me()], analysis: { phash: "0123456789abcdef", aesthetic: 7 } });
    const worse = seedImage(ds, { faces: [me()], analysis: { phash: "0123456789abcdee", aesthetic: 5 } });
    runSelection(ds);
    expect(rec(better).status).toBe("selected");
    expect(rec(worse).reasons).toEqual(["duplicate"]);
    expect(rec(worse).dupOf).toBe(better);
  });

  test("near-identical CLIP embedding counts as a duplicate", () => {
    const ds = newDataset();
    const clip = randomVec(768, 77);
    const a = seedImage(ds, { faces: [me()], clip, analysis: { aesthetic: 6 } });
    const b = seedImage(ds, { faces: [me()], clip: near(clip, 78, 0.05), analysis: { aesthetic: 5 } });
    runSelection(ds);
    expect(rec(a).status).toBe("selected");
    expect(rec(b).dupOf).toBe(a);
  });

  test("a pinned image is never marked as a duplicate", () => {
    const ds = newDataset();
    seedImage(ds, { faces: [me()], analysis: { phash: "ffffffffffffffff", aesthetic: 7 } });
    const pinned = seedImage(ds, { faces: [me()], analysis: { phash: "fffffffffffffffe" }, override: "include" });
    runSelection(ds);
    expect(rec(pinned).status).toBe("selected");
  });
});

describe("overrides", () => {
  test("include beats a failed check; exclude beats everything", () => {
    const ds = newDataset();
    [1, 2].forEach(() => seedImage(ds, { faces: [me()] }));
    const forced = seedImage(ds, { faces: [], override: "include" });
    const excluded = seedImage(ds, { faces: [me()], override: "exclude" });
    runSelection(ds);
    expect(rec(forced).status).toBe("selected");
    expect(rec(forced).reasons).toEqual([]);
    expect(rec(excluded).status).toBe("rejected");
    expect(rec(excluded).reasons).toEqual(["manual"]);
  });

  test("pinned images count towards the target first", () => {
    const ds = newDataset();
    saveSettings(ds, { targetCount: 2 });
    const pinned = seedImage(ds, { faces: [me()], analysis: { aesthetic: 3 }, override: "include" });
    [1, 2, 3].forEach(() => seedImage(ds, { faces: [me()], analysis: { aesthetic: 8 } }));
    runSelection(ds);
    expect(rec(pinned).status).toBe("selected");
    expect(records(ds).filter((r) => r.status === "selected")).toHaveLength(2);
  });
});

describe("picking", () => {
  test("respects the target; the rest goes to reserve", () => {
    const ds = newDataset();
    saveSettings(ds, { targetCount: 3 });
    [1, 2, 3, 4, 5].forEach(() => seedImage(ds, { faces: [me()] }));
    const s = runSelection(ds);
    expect(s).toEqual({ selected: 3, reserve: 2, rejected: 0, pending: 0 });
    for (const r of records(ds).filter((r) => r.status === "reserve")) expect(r.reasons).toEqual(["not_selected"]);
  });

  test("framing quotas spread the selection", () => {
    const ds = newDataset();
    saveSettings(ds, { targetCount: 4, framingMix: { closeup: 0.5, half: 0, full: 0.5 }, diversity: 0 });
    // Half-body images score best, but their quota is 0.
    [1, 2, 3].forEach(() => seedImage(ds, { faces: [me()], tags: tags({ framing: "half", quality: 10 }) }));
    [1, 2, 3].forEach(() => seedImage(ds, { faces: [me()], tags: tags({ framing: "closeup", quality: 5 }) }));
    [1, 2, 3].forEach(() => seedImage(ds, { faces: [me()], tags: tags({ framing: "full", quality: 5 }) }));
    runSelection(ds);
    const picked = records(ds).filter((r) => r.status === "selected");
    expect(picked.filter((r) => r.framing === "closeup")).toHaveLength(2);
    expect(picked.filter((r) => r.framing === "full")).toHaveLength(2);
  });

  test("fills from other framings when one runs out", () => {
    const ds = newDataset();
    saveSettings(ds, { targetCount: 4, framingMix: { closeup: 1, half: 0, full: 0 } });
    seedImage(ds, { faces: [me()], tags: tags({ framing: "closeup" }) });
    [1, 2, 3, 4].forEach(() => seedImage(ds, { faces: [me()], tags: tags({ framing: "half" }) }));
    expect(runSelection(ds).selected).toBe(4);
  });

  test("framing falls back to face size without an AI review", () => {
    const ds = newDataset();
    const close = seedImage(ds, { faces: [me({ height: 0.4 })] });
    const half = seedImage(ds, { faces: [me({ height: 0.15 })] });
    const full = seedImage(ds, { faces: [me({ height: 0.06 })] });
    runSelection(ds);
    expect([rec(close).framing, rec(half).framing, rec(full).framing]).toEqual(["closeup", "half", "full"]);
  });

  test("variety: with high diversity, a look-alike loses to a different image", () => {
    const ds = newDataset();
    saveSettings(ds, { targetCount: 2, framingMix: { closeup: 0, half: 1, full: 0 }, dedupClipSimilarity: 0.99 });
    const base = randomVec(768, 500);
    const best = seedImage(ds, { faces: [me()], clip: base, analysis: { aesthetic: 7 } });
    const lookalike = seedImage(ds, { faces: [me()], clip: near(base, 501, 0.3), analysis: { aesthetic: 6.8 } });
    const different = seedImage(ds, { faces: [me()], clip: randomVec(768, 502), analysis: { aesthetic: 6 } });

    saveSettings(ds, { diversity: 0 });
    runSelection(ds);
    expect([rec(best).status, rec(lookalike).status, rec(different).status]).toEqual(["selected", "selected", "reserve"]);

    saveSettings(ds, { diversity: 1 });
    runSelection(ds);
    expect([rec(best).status, rec(lookalike).status, rec(different).status]).toEqual(["selected", "reserve", "selected"]);
  });

  test("unanalyzed images stay pending", () => {
    const ds = newDataset();
    seedImage(ds, { faces: [me()] });
    const pending = seedImage(ds, { analyzed: false });
    expect(runSelection(ds).pending).toBe(1);
    expect(rec(pending).status).toBe("pending");
  });
});
