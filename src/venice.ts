import sharp from "sharp"
import { VENICE_BASE_URL, veniceKey } from "./config"
import type { VeniceModel } from "./types"

let modelCache: { at: number; models: VeniceModel[] } | null = null

/** For tests. */
export function clearModelCache() {
  modelCache = null
}

/** Vision-capable text models, cached for 10 minutes. */
export async function listVisionModels(): Promise<VeniceModel[]> {
  if (modelCache && Date.now() - modelCache.at < 10 * 60_000)
    return modelCache.models
  const res = await fetch(`${VENICE_BASE_URL}/models?type=text`, {
    headers: { Authorization: `Bearer ${veniceKey()}` },
  })
  if (!res.ok)
    throw new Error(`Venice /models failed: ${res.status} ${await res.text()}`)
  const body = (await res.json()) as {
    data: {
      id: string
      model_spec?: {
        name?: string
        privacy?: string
        capabilities?: Record<string, boolean>
        pricing?: { input?: { usd?: number }; output?: { usd?: number } }
      }
    }[]
  }
  const models = body.data
    .map((m) => ({
      id: m.id,
      name: m.model_spec?.name ?? m.id,
      privacy: m.model_spec?.privacy ?? null,
      vision: !!m.model_spec?.capabilities?.supportsVision,
      schema: !!m.model_spec?.capabilities?.supportsResponseSchema,
      e2ee: !!m.model_spec?.capabilities?.supportsE2EE,
      priceIn: m.model_spec?.pricing?.input?.usd ?? null,
      priceOut: m.model_spec?.pricing?.output?.usd ?? null,
    }))
    .filter((m) => m.vision)
    .sort((a, b) => (a.priceIn ?? 99) - (b.priceIn ?? 99))
  modelCache = { at: Date.now(), models }
  return models
}

/** Throws for datasets marked "Local only". Call before anything that would send that dataset's images. */
export function assertOnlineAllowed(dataset: string, localOnly: boolean) {
  if (localOnly)
    throw new Error(
      `"${dataset}" is set to Local only, so its images are never sent to Venice.`,
    )
}

/**
 * Look up the model before sending it an image. With `requirePrivate`, fails closed: if the model
 * list can't be fetched or the model isn't marked private, nothing is sent.
 */
export async function checkModel(
  model: string,
  requirePrivate: boolean,
): Promise<VeniceModel | null> {
  let info: VeniceModel | null = null
  try {
    info = (await listVisionModels()).find((m) => m.id === model) ?? null
  } catch (e) {
    if (requirePrivate)
      throw new Error(
        `Can't verify that "${model}" is private: ${(e as Error).message}`,
      )
    return null
  }
  if (requirePrivate && info?.privacy !== "private") {
    throw new Error(
      info
        ? `"${model}" is ${info.privacy ?? "not marked private"} on Venice. Pick a private model or turn off "Private models only".`
        : `"${model}" isn't a Venice vision model. Pick another model in Settings.`,
    )
  }
  if (info?.e2ee)
    throw new Error(
      `"${model}" requires end-to-end encryption, which this app doesn't support yet.`,
    )
  return info
}

/** Downscaled JPEG data URL: enough detail for the model, far fewer tokens than the original. */
export async function imageDataUrl(
  path: string,
  maxSide = 1024,
): Promise<string> {
  const buf = await sharp(path)
    .rotate()
    .resize(maxSide, maxSide, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 88 })
    .toBuffer()
  return `data:image/jpeg;base64,${buf.toString("base64")}`
}

interface ChatOptions {
  model: string
  system: string
  prompt: string
  /** Image to attach. Omit for a text-only request. */
  imagePath?: string
  schema?: { name: string; schema: object }
  maxTokens?: number
  /** Refuse to send the image unless Venice marks the model as private. */
  requirePrivate: boolean
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function chat(opts: ChatOptions): Promise<string> {
  const info = await checkModel(opts.model, opts.requirePrivate)
  const body: Record<string, unknown> = {
    model: opts.model,
    temperature: 0.2,
    max_tokens: opts.maxTokens ?? 800,
    messages: [
      { role: "system", content: opts.system },
      {
        role: "user",
        content: [
          { type: "text", text: opts.prompt },
          ...(opts.imagePath
            ? [
                {
                  type: "image_url",
                  image_url: { url: await imageDataUrl(opts.imagePath) },
                },
              ]
            : []),
        ],
      },
    ],
    venice_parameters: {
      include_venice_system_prompt: false,
      disable_thinking: true,
      strip_thinking_response: true,
    },
  }
  if (opts.schema && info?.schema) {
    body.response_format = {
      type: "json_schema",
      json_schema: { ...opts.schema, strict: true },
    }
  }

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${VENICE_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${veniceKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    })
    if (res.ok) {
      const json = (await res.json()) as {
        choices: {
          message: { content: string | null }
          finish_reason?: string
        }[]
      }
      const choice = json.choices?.[0]
      if (choice?.finish_reason === "length") {
        throw new Error(
          `the reply was cut off at the ${body.max_tokens}-token limit`,
        )
      }
      const content = choice?.message?.content ?? ""
      return content.replace(/<think>[\s\S]*?<\/think>/g, "").trim()
    }
    const text = await res.text()
    const retryable = res.status === 429 || res.status >= 500
    if (!retryable || attempt >= 4)
      throw new Error(`Venice ${res.status}: ${text.slice(0, 300)}`)
    const retryAfter = Number(res.headers.get("retry-after"))
    await sleep(
      Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : 1000 * 2 ** attempt,
    )
  }
}

export async function chatJson<T>(
  opts: ChatOptions & { schema: { name: string; schema: object } },
): Promise<T> {
  const text = await chat(opts)
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) throw new Error(`Model returned no JSON: ${text.slice(0, 200)}`)
  return JSON.parse(match[0]) as T
}

export async function chatText(opts: ChatOptions): Promise<string> {
  return chat(opts)
}
