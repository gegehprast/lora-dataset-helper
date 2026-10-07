import { afterEach, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import sharp from "sharp"
import {
  assertOnlineAllowed,
  chatJson,
  chatText,
  checkModel,
  clearModelCache,
  listVisionModels,
} from "../src/venice"
import { chatReply, json, mockFetch, modelsPayload } from "./helpers"

const MODELS = modelsPayload([
  { id: "priv", privacy: "private" },
  { id: "priv-noschema", privacy: "private", schema: false },
  { id: "anon", privacy: "anonymized" },
  { id: "e2ee", privacy: "private", e2ee: true },
  { id: "text-only", vision: false },
])

let image: string
beforeAll(async () => {
  image = join(mkdtempSync(join(tmpdir(), "lora-venice-")), "img.jpg")
  await sharp({
    create: { width: 2000, height: 1000, channels: 3, background: "#888" },
  })
    .jpeg()
    .toFile(image)
})

let mock: ReturnType<typeof mockFetch> | null = null
afterEach(() => {
  mock?.restore()
  mock = null
  clearModelCache()
})

/** Serves /models from MODELS and chat completions from `chat`. */
function venice(
  chat: (body: any, n: number) => Response | Promise<Response> = () =>
    chatReply("ok"),
) {
  let n = 0
  mock = mockFetch((url, init) => {
    if (url.endsWith("/models?type=text")) return json(MODELS)
    if (url.endsWith("/chat/completions"))
      return chat(JSON.parse(String(init!.body)), n++)
    throw new Error(`unexpected ${url}`)
  })
  return mock
}
const chats = () =>
  mock!.calls.filter((c) => c.url.endsWith("/chat/completions"))

const opts = { system: "sys", prompt: "describe", maxTokens: 50 }

describe("model list", () => {
  test("keeps vision models with privacy and capability flags", async () => {
    venice()
    const models = await listVisionModels()
    expect(models.map((m) => m.id).sort()).toEqual([
      "anon",
      "e2ee",
      "priv",
      "priv-noschema",
    ])
    expect(models.find((m) => m.id === "anon")).toMatchObject({
      privacy: "anonymized",
      schema: true,
      e2ee: false,
    })
  })

  test("is cached", async () => {
    venice()
    await listVisionModels()
    await listVisionModels()
    expect(mock!.calls).toHaveLength(1)
  })
})

describe("checkModel", () => {
  test("allows private models", async () => {
    venice()
    expect((await checkModel("priv", true))?.id).toBe("priv")
  })

  test("refuses anonymized models when private-only is on", async () => {
    venice()
    await expect(checkModel("anon", true)).rejects.toThrow("anonymized")
    expect((await checkModel("anon", false))?.privacy).toBe("anonymized")
  })

  test("refuses unknown and E2EE models", async () => {
    venice()
    await expect(checkModel("missing", true)).rejects.toThrow(
      "isn't a Venice vision model",
    )
    await expect(checkModel("e2ee", true)).rejects.toThrow(
      "end-to-end encryption",
    )
  })

  test("fails closed when the model list can't be fetched", async () => {
    mock = mockFetch(() => new Response("down", { status: 503 }))
    await expect(checkModel("priv", true)).rejects.toThrow("Can't verify")
  })
})

test("Local only blocks", () => {
  expect(() => assertOnlineAllowed("x", true)).toThrow("Local only")
  expect(() => assertOnlineAllowed("x", false)).not.toThrow()
})

describe("chat", () => {
  test("sends a downscaled JPEG and disables Venice's system prompt and thinking", async () => {
    venice()
    await chatText({
      ...opts,
      model: "priv",
      imagePath: image,
      requirePrivate: true,
    })
    const body = chats()[0]!.body
    expect(body.venice_parameters).toEqual({
      include_venice_system_prompt: false,
      disable_thinking: true,
      strip_thinking_response: true,
    })
    const url: string = body.messages[1].content[1].image_url.url
    expect(url.startsWith("data:image/jpeg;base64,")).toBe(true)
    const meta = await sharp(
      Buffer.from(url.split(",")[1]!, "base64"),
    ).metadata()
    expect(Math.max(meta.width!, meta.height!)).toBe(1024)
  })

  test("never sends the image to a refused model", async () => {
    venice()
    await expect(
      chatText({
        ...opts,
        model: "anon",
        imagePath: image,
        requirePrivate: true,
      }),
    ).rejects.toThrow()
    expect(chats()).toHaveLength(0)
  })

  test("uses JSON mode only when the model supports it", async () => {
    const schema = { name: "x", schema: { type: "object" } }
    venice(() => chatReply('{"a":1}'))
    await chatJson({
      ...opts,
      model: "priv",
      imagePath: image,
      requirePrivate: true,
      schema,
    })
    await chatJson({
      ...opts,
      model: "priv-noschema",
      imagePath: image,
      requirePrivate: true,
      schema,
    })
    expect(chats()[0]!.body.response_format.json_schema).toMatchObject({
      name: "x",
      strict: true,
    })
    expect(chats()[1]!.body.response_format).toBeUndefined()
  })

  test("extracts JSON from fenced or chatty replies and strips <think>", async () => {
    venice(() =>
      chatReply('<think>hmm {"no":1}</think>Sure! ```json\n{"a": 2}\n```'),
    )
    const r = await chatJson<{ a: number }>({
      ...opts,
      model: "priv",
      imagePath: image,
      requirePrivate: true,
      schema: { name: "x", schema: {} },
    })
    expect(r).toEqual({ a: 2 })
  })

  test("retries rate limits and server errors, then succeeds", async () => {
    venice((_, n) =>
      n === 0
        ? new Response("slow down", {
            status: 429,
            headers: { "retry-after": "0.01" },
          })
        : n === 1
          ? new Response("oops", { status: 502 })
          : chatReply("done"),
    )
    const r = await chatText({
      ...opts,
      model: "priv",
      imagePath: image,
      requirePrivate: true,
    })
    expect(r).toBe("done")
    expect(chats()).toHaveLength(3)
  })

  test("does not retry client errors", async () => {
    venice(() => new Response("bad request", { status: 400 }))
    await expect(
      chatText({
        ...opts,
        model: "priv",
        imagePath: image,
        requirePrivate: true,
      }),
    ).rejects.toThrow("Venice 400")
    expect(chats()).toHaveLength(1)
  })
})
