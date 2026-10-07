// Review (tag) and caption stages against a mocked Venice API.
import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import sharp from "sharp"
import { paths } from "../src/config"
import { db, getRow, listRows, saveSettings, toRecord } from "../src/db"
import { captionDataset, captionImage } from "../src/pipeline/caption"
import { runSelection } from "../src/pipeline/select"
import { tagDataset } from "../src/pipeline/tag"
import { clearModelCache } from "../src/venice"
import {
  chatReply,
  fakeCtx,
  json,
  mockFetch,
  modelsPayload,
  near,
  newDataset,
  randomVec,
  seedImage,
  tags,
} from "./helpers"

const person = randomVec(512, 9)
let f = 0
const me = () => ({ emb: near(person, ++f) })

/** Seed analyzed rows plus real (tiny, generated) image files for them. */
async function dataset(
  count: number,
  extra: Parameters<typeof seedImage>[1] = {},
) {
  const ds = newDataset("ai")
  mkdirSync(join(paths.input, ds), { recursive: true })
  const ids: number[] = []
  for (let i = 0; i < count; i++) {
    const id = seedImage(ds, { faces: [me()], ...extra })
    await sharp({
      create: { width: 64, height: 64, channels: 3, background: "#777" },
    })
      .jpeg()
      .toFile(join(paths.input, ds, getRow(id)!.rel_path))
    ids.push(id)
  }
  runSelection(ds) // as after the analyze stage
  return { ds, ids }
}

let mock: ReturnType<typeof mockFetch> | null = null
afterEach(() => {
  mock?.restore()
  mock = null
  clearModelCache()
})

function venice(reply: (n: number) => Response) {
  let n = 0
  mock = mockFetch((url) => {
    if (url.endsWith("/models?type=text")) {
      return json(
        modelsPayload([
          { id: "priv-a" },
          { id: "priv-b" },
          { id: "anon", privacy: "anonymized" },
        ]),
      )
    }
    return reply(n++)
  })
  return () => mock!.calls.filter((c) => c.url.endsWith("/chat/completions"))
}

describe("review (tag) stage", () => {
  test("reviews eligible images, stores tags and re-selects", async () => {
    const { ds, ids } = await dataset(3)
    saveSettings(ds, { tagModel: "priv-a" })
    const chats = venice(() =>
      chatReply(
        JSON.stringify(
          tags({
            framing: "closeup",
            quality: 9,
            issues: ["sunglasses", "made_up" as any],
          }),
        ),
      ),
    )
    await tagDataset(ds, fakeCtx().ctx)
    expect(chats()).toHaveLength(3)
    const r = toRecord(getRow(ids[0]!)!)
    expect(r.tags?.framing).toBe("closeup")
    expect(r.tags?.issues).toEqual(["sunglasses"]) // unknown issue dropped
    expect(r.framing).toBe("closeup") // selection used the review
  })

  test("skips images already reviewed by the same model; re-reviews after a model change", async () => {
    const { ds } = await dataset(2, { tags: tags(), tagsModel: "priv-a" })
    saveSettings(ds, { tagModel: "priv-a" })
    let chats = venice(() => chatReply(JSON.stringify(tags())))
    expect(await tagDataset(ds, fakeCtx().ctx)).toBe("Nothing new to review")
    expect(chats()).toHaveLength(0)
    mock!.restore()
    saveSettings(ds, { tagModel: "priv-b" })
    chats = venice(() => chatReply(JSON.stringify(tags())))
    await tagDataset(ds, fakeCtx().ctx)
    expect(chats()).toHaveLength(2)
  })

  test("does not review images rejected by the local checks", async () => {
    const { ds } = await dataset(2)
    seedImage(ds, { faces: [] }) // no_face, no file needed: must never be sent
    saveSettings(ds, { tagModel: "priv-a" })
    const chats = venice(() => chatReply(JSON.stringify(tags())))
    await tagDataset(ds, fakeCtx().ctx)
    expect(chats()).toHaveLength(2)
  })

  test("clamps out-of-range quality", async () => {
    const { ds, ids } = await dataset(1)
    saveSettings(ds, { tagModel: "priv-a" })
    venice(() => chatReply(JSON.stringify({ ...tags(), quality: 42 })))
    await tagDataset(ds, fakeCtx().ctx)
    expect(toRecord(getRow(ids[0]!)!).tags?.quality).toBe(10)
  })

  test("Local only: nothing is sent", async () => {
    const { ds } = await dataset(2)
    saveSettings(ds, { tagModel: "priv-a", localOnly: true })
    const chats = venice(() => chatReply("{}"))
    await expect(tagDataset(ds, fakeCtx().ctx)).rejects.toThrow("Local only")
    expect(mock!.calls).toHaveLength(0)
    expect(chats()).toHaveLength(0)
  })

  test("anonymized model: refused before any image is sent", async () => {
    const { ds } = await dataset(2)
    saveSettings(ds, { tagModel: "anon" })
    const chats = venice(() => chatReply("{}"))
    await expect(tagDataset(ds, fakeCtx().ctx)).rejects.toThrow("anonymized")
    expect(chats()).toHaveLength(0)
  })

  test("stops early when every request fails", async () => {
    const { ds } = await dataset(6)
    saveSettings(ds, { tagModel: "priv-a", concurrency: 1 })
    const chats = venice(() => new Response("no credit", { status: 402 }))
    await expect(tagDataset(ds, fakeCtx().ctx)).rejects.toThrow(
      "Venice requests are failing",
    )
    expect(chats()).toHaveLength(3)
  })

  test("keeps going when only some requests fail", async () => {
    const { ds } = await dataset(4)
    saveSettings(ds, { tagModel: "priv-a", concurrency: 1 })
    venice((n) =>
      n === 1 ? chatReply("not json") : chatReply(JSON.stringify(tags())),
    )
    const msg = await tagDataset(ds, fakeCtx().ctx)
    expect(msg).toStartWith("Reviewed 3/4")
    expect(listRows(ds).filter((r) => r.tags)).toHaveLength(3)
  })
})

describe("caption stage", () => {
  test("captions selected images, starting with the trigger word", async () => {
    const { ds, ids } = await dataset(2, { override: "include" })
    saveSettings(ds, { triggerWord: "jdoe", captionModel: "priv-a" })
    const chats = venice(() =>
      chatReply('Caption: "a woman reading in a café."'),
    )
    expect(await captionDataset(ds, fakeCtx().ctx)).toBe("Captioned 2/2")
    expect(getRow(ids[0]!)!.caption).toBe("jdoe, a woman reading in a café.")
    expect(chats()[0]!.body.model).toBe("priv-a")
  })

  test("does not overwrite existing captions unless asked", async () => {
    const { ds, ids } = await dataset(1, {
      override: "include",
      caption: "hand written",
    })
    saveSettings(ds, { triggerWord: "jdoe", captionModel: "priv-a" })
    venice(() => chatReply("jdoe new"))
    await captionDataset(ds, fakeCtx().ctx)
    expect(getRow(ids[0]!)!.caption).toBe("hand written")
    await captionDataset(ds, fakeCtx().ctx, true)
    expect(getRow(ids[0]!)!.caption).toBe("jdoe new")
  })

  test("requires a trigger word", async () => {
    const { ds } = await dataset(1, { override: "include" })
    venice(() => chatReply("x"))
    await expect(captionDataset(ds, fakeCtx().ctx)).rejects.toThrow(
      "trigger word",
    )
  })

  test("Local only blocks batch and single-image captioning", async () => {
    const { ds, ids } = await dataset(1, { override: "include" })
    saveSettings(ds, {
      triggerWord: "jdoe",
      captionModel: "priv-a",
      localOnly: true,
    })
    venice(() => chatReply("x"))
    await expect(captionDataset(ds, fakeCtx().ctx)).rejects.toThrow(
      "Local only",
    )
    await expect(captionImage(ids[0]!)).rejects.toThrow("Local only")
    expect(mock!.calls).toHaveLength(0)
  })
})

describe("review limit", () => {
  test("reviews only the best multiplier × target candidates", async () => {
    const { ds } = await dataset(10)
    saveSettings(ds, {
      tagModel: "priv-a",
      targetCount: 2,
      reviewMultiplier: 2,
    })
    const chats = venice(() => chatReply(JSON.stringify(tags())))
    const msg = await tagDataset(ds, fakeCtx().ctx)
    expect(chats()).toHaveLength(4)
    expect(msg).toContain("6 lower-ranked candidates not reviewed")
  })

  test("0 reviews every candidate", async () => {
    const { ds } = await dataset(5)
    saveSettings(ds, {
      tagModel: "priv-a",
      targetCount: 1,
      reviewMultiplier: 0,
    })
    const chats = venice(() => chatReply(JSON.stringify(tags())))
    await tagDataset(ds, fakeCtx().ctx)
    expect(chats()).toHaveLength(5)
  })

  test("reviews replacements until every selected image is reviewed", async () => {
    const { ds } = await dataset(8)
    saveSettings(ds, {
      tagModel: "priv-a",
      targetCount: 2,
      reviewMultiplier: 1,
    })
    // The first 3 reviews reject their image, so unreviewed reserves get promoted.
    const chats = venice((n) =>
      chatReply(
        JSON.stringify(tags({ issues: n < 3 ? ["watermark_or_text"] : [] })),
      ),
    )
    await tagDataset(ds, fakeCtx().ctx)
    const selected = listRows(ds).filter((r) => r.status === "selected")
    expect(selected).toHaveLength(2)
    for (const r of selected) expect(r.tags).not.toBeNull()
    expect(chats().length).toBeGreaterThan(2)
    expect(chats().length).toBeLessThan(8)
  })

  test("pinned images are always reviewed, even beyond the limit", async () => {
    const { ds, ids } = await dataset(4)
    db.query("UPDATE images SET override = 'include' WHERE id = ?").run(ids[3])
    saveSettings(ds, {
      tagModel: "priv-a",
      targetCount: 1,
      reviewMultiplier: 1,
    })
    venice(() => chatReply(JSON.stringify(tags())))
    await tagDataset(ds, fakeCtx().ctx)
    expect(getRow(ids[3])?.tags).not.toBeNull()
  })

  test("reviews from an older review version are redone", async () => {
    const { ds } = await dataset(2, {
      tags: { ...tags(), v: 1 },
      tagsModel: "priv-a",
    })
    saveSettings(ds, { tagModel: "priv-a" })
    const chats = venice(() => chatReply(JSON.stringify(tags())))
    await tagDataset(ds, fakeCtx().ctx)
    expect(chats()).toHaveLength(2)
  })
})

describe("outfit grouping", () => {
  const outfits = [
    "Black hoodie, jeans",
    "dark hooded sweatshirt and jeans",
    "red dress",
  ]

  /** Reviews return the outfits above in turn; the text-only grouping request gets `grouping()`. */
  function veniceWithGrouping(grouping: () => Response) {
    let n = 0
    mock = mockFetch((url, init) => {
      if (url.endsWith("/models?type=text"))
        return json(modelsPayload([{ id: "priv-a" }]))
      const body = JSON.parse(String(init?.body))
      if (body.messages[1].content.length === 1) return grouping()
      return chatReply(JSON.stringify(tags({ outfit: outfits[n++ % 3] })))
    })
    return () => mock!.calls.filter((c) => c.url.endsWith("/chat/completions"))
  }

  test("groups equivalent outfit descriptions with one text-only request", async () => {
    const { ds, ids } = await dataset(3)
    saveSettings(ds, { tagModel: "priv-a", concurrency: 1 })
    const chats = veniceWithGrouping(() =>
      chatReply(
        JSON.stringify({
          groups: [
            { label: "Black hoodie + jeans", items: [0, 1] },
            { label: "red dress", items: [2] },
          ],
        }),
      ),
    )
    await tagDataset(ds, fakeCtx().ctx)
    const groupReq = chats().filter(
      (c) => c.body.messages[1].content.length === 1,
    )
    expect(groupReq).toHaveLength(1)
    expect(JSON.stringify(groupReq[0].body)).not.toContain("image_url")
    const groups = ids.map((id) => getRow(id)?.outfit_group)
    expect(groups.filter((g) => g === "black hoodie + jeans")).toHaveLength(2)
    expect(groups).toContain("red dress")
  })

  test("falls back to exact descriptions when grouping fails", async () => {
    const { ds, ids } = await dataset(3)
    saveSettings(ds, { tagModel: "priv-a", concurrency: 1 })
    veniceWithGrouping(() => new Response("bad", { status: 400 }))
    const msg = await tagDataset(ds, fakeCtx().ctx)
    expect(msg).toContain("outfit grouping failed")
    expect(new Set(ids.map((id) => getRow(id)?.outfit_group)).size).toBe(3)
    expect(getRow(ids[0])?.outfit_group).toBe("black hoodie, jeans")
  })

  test("no grouping request when every outfit is the same", async () => {
    const { ds } = await dataset(2)
    saveSettings(ds, { tagModel: "priv-a" })
    const chats = venice(() => chatReply(JSON.stringify(tags())))
    await tagDataset(ds, fakeCtx().ctx)
    expect(chats()).toHaveLength(2)
  })
})
