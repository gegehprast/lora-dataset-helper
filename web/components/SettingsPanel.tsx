import { useEffect, useRef, useState } from "react"
import {
  type Framing,
  type Settings,
  VARIETY_ATTRIBUTES,
  VARIETY_LABELS,
  type VeniceModel,
} from "../../src/types"
import { api } from "../api"

interface Props {
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
}

/** Edits are kept locally and sent after a short pause, so typing doesn't re-run selection on every key. */
export function SettingsPanel({ settings, onChange }: Props) {
  const [draft, setDraft] = useState(settings)
  const pending = useRef<Partial<Settings>>({})
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [models, setModels] = useState<VeniceModel[] | null>(null)
  const [modelError, setModelError] = useState<string | null>(null)

  useEffect(() => {
    if (!timer.current) setDraft(settings)
  }, [settings])

  useEffect(() => {
    api.models().then(setModels, (e) => setModelError(e.message))
  }, [])

  const set = <K extends keyof Settings>(
    key: K,
    value: Settings[K],
    delay = 600,
  ) => {
    setDraft((d) => ({ ...d, [key]: value }))
    pending.current[key] = value
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      const patch = pending.current
      pending.current = {}
      onChange(patch)
    }, delay)
  }

  const num = (
    key: keyof Settings,
    label: string,
    opts: { min?: number; max?: number; step?: number; hint?: string },
  ) => (
    <label className="field">
      <span>{label}</span>
      <input
        type="number"
        min={opts.min}
        max={opts.max}
        step={opts.step ?? 1}
        value={draft[key] as number}
        onChange={(e) =>
          e.target.value !== "" && set(key, Number(e.target.value) as never)
        }
      />
      {opts.hint && <small>{opts.hint}</small>}
    </label>
  )

  const modelLabel = (m: VeniceModel) =>
    `${m.privacy === "private" ? "🔒 " : ""}${m.id}` +
    (m.priceIn != null ? ` · $${m.priceIn}/$${m.priceOut}` : "") +
    (m.schema ? "" : " · no JSON mode") +
    (m.e2ee ? " · E2EE, not supported" : "")

  const modelSelect = (
    key: "tagModel" | "captionModel",
    label: string,
    hint: string,
  ) => {
    const current = draft[key]
    const list = models ?? []
    const info = list.find((m) => m.id === current)
    const priv = list.filter((m) => m.privacy === "private")
    const anon = list.filter((m) => m.privacy !== "private")
    const option = (m: VeniceModel) => (
      <option key={m.id} value={m.id} disabled={m.e2ee}>
        {modelLabel(m)}
      </option>
    )
    const blocked =
      models &&
      (!info ||
        (draft.privateModelsOnly && info.privacy !== "private") ||
        info.e2ee)
    return (
      <label className="field">
        <span>
          {label}{" "}
          {info && (
            <span
              className={`privacy ${info.privacy === "private" ? "private" : "anon"}`}
            >
              {info.privacy ?? "unknown"}
            </span>
          )}
        </span>
        <select value={current} onChange={(e) => set(key, e.target.value, 0)}>
          {!info && <option value={current}>{current} (not available)</option>}
          {info && draft.privateModelsOnly && info.privacy !== "private" && (
            <option value={current}>{modelLabel(info)}</option>
          )}
          <optgroup label="Private: Venice keeps no data">
            {priv.map(option)}
          </optgroup>
          {!draft.privateModelsOnly && (
            <optgroup label="Anonymized: sent to a third-party provider">
              {anon.map(option)}
            </optgroup>
          )}
        </select>
        {blocked ? (
          <small className="warn-text">
            {!info
              ? "This model isn't in Venice's vision model list. Pick another."
              : info.e2ee
                ? "This model needs end-to-end encryption, which isn't supported yet."
                : "Not a private model, so requests will be refused. Pick a 🔒 model."}
          </small>
        ) : (
          <small>
            {hint}
            {info?.priceIn != null &&
              ` $${info.priceIn} in / $${info.priceOut} out per million tokens.`}
          </small>
        )}
      </label>
    )
  }

  const setMix = (f: Framing, v: number) =>
    set("framingMix", { ...draft.framingMix, [f]: v })

  return (
    <aside className="settings">
      <h2>Settings</h2>

      <fieldset>
        <legend>Character</legend>
        <label className="field">
          <span>Trigger word</span>
          <input
            value={draft.triggerWord}
            placeholder="e.g. ohwx or jane_doe"
            onChange={(e) => set("triggerWord", e.target.value)}
          />
          <small>Captions start with this name.</small>
        </label>
        <label className="field">
          <span>Class</span>
          <input
            value={draft.subjectClass}
            placeholder="woman, man, person"
            onChange={(e) => set("subjectClass", e.target.value)}
          />
        </label>
      </fieldset>

      <fieldset>
        <legend>Selection</legend>
        {num("targetCount", "Target images", { min: 1, max: 500 })}
        <label className="field">
          <span>
            Variety vs quality <b>{Math.round(draft.diversity * 100)}%</b>
          </span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={draft.diversity}
            onChange={(e) => set("diversity", Number(e.target.value), 300)}
          />
          <small>
            0% picks the highest scores; 100% favours images unlike those
            already picked.
          </small>
        </label>
        <div className="field">
          <span>Framing mix (share of the target)</span>
          <div className="mix">
            {(["closeup", "half", "full"] as Framing[]).map((f) => (
              <label key={f}>
                <small>
                  {f === "closeup"
                    ? "Close-up"
                    : f === "half"
                      ? "Half"
                      : "Full"}
                </small>
                <input
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={draft.framingMix[f]}
                  onChange={(e) => setMix(f, Number(e.target.value))}
                />
              </label>
            ))}
          </div>
        </div>
        <div className="field">
          <span>Spread variety across</span>
          <div className="checks">
            {VARIETY_ATTRIBUTES.map((a) => (
              <label key={a} className="check">
                <input
                  type="checkbox"
                  checked={draft.varietyAttributes[a]}
                  onChange={(e) =>
                    set(
                      "varietyAttributes",
                      { ...draft.varietyAttributes, [a]: e.target.checked },
                      0,
                    )
                  }
                />
                {VARIETY_LABELS[a]}
              </label>
            ))}
          </div>
          <small>
            Avoids picking many images with the same value. Uses the AI review;
            the variety slider sets how strongly it counts.
          </small>
        </div>
      </fieldset>

      <fieldset>
        <legend>Filters</legend>
        {num("minShortSide", "Min short side (px)", { min: 256, step: 64 })}
        {num("preferredShortSide", "Preferred short side (px)", {
          min: 256,
          step: 64,
        })}
        {num("minFaceSharpness", "Min face sharpness", {
          min: 0,
          step: 5,
          hint: 'See "Face sharpness" in an image\'s details.',
        })}
        {num("identityThreshold", "Identity threshold", {
          min: 0,
          max: 1,
          step: 0.02,
          hint: "Face similarity needed to count as the character (0.35–0.5).",
        })}
        {num("otherPersonMinFace", "Other-person face size", {
          min: 0,
          max: 1,
          step: 0.01,
          hint: "Smaller background faces are ignored.",
        })}
        {num("dedupPhashDistance", "Duplicate: hash distance", {
          min: 0,
          max: 32,
        })}
        {num("dedupClipSimilarity", "Duplicate: similarity", {
          min: 0.5,
          max: 1,
          step: 0.01,
        })}
        {draft.referenceImageIds.length > 0 && (
          <div className="field">
            <span>Identity references: {draft.referenceImageIds.length}</span>
            <button
              type="button"
              className="ghost small"
              onClick={() => set("referenceImageIds", [], 0)}
            >
              Clear (use automatic)
            </button>
          </div>
        )}
      </fieldset>

      <fieldset>
        <legend>Venice AI</legend>
        <label className="check">
          <input
            type="checkbox"
            checked={draft.localOnly}
            onChange={(e) => set("localOnly", e.target.checked, 0)}
          />
          <span>
            <b>Local only.</b> Never send this dataset's images to Venice.
            Review and captioning are blocked by the server.
          </span>
        </label>
        {modelError && <div className="banner error small">{modelError}</div>}
        {modelSelect(
          "tagModel",
          "Review model",
          "Rates every image that passes the local filters. A cheap model is fine.",
        )}
        {modelSelect(
          "captionModel",
          "Caption model",
          "Only selected images are captioned.",
        )}
        <label className="check">
          <input
            type="checkbox"
            checked={draft.privateModelsOnly}
            onChange={(e) => set("privateModelsOnly", e.target.checked, 0)}
          />
          Private models only. Images are only sent to models Venice marks 🔒
          private (no prompts or images kept).
        </label>
        {num("reviewMultiplier", "Review limit (× target)", {
          min: 0,
          max: 20,
          step: 0.5,
          hint: `Review the best ${draft.reviewMultiplier > 0 ? Math.ceil(draft.reviewMultiplier * draft.targetCount) : "(all)"} candidates by local score, plus replacements when needed. 0 = review every candidate.`,
        })}
        {num("concurrency", "Parallel requests", { min: 1, max: 16 })}
      </fieldset>

      <fieldset>
        <legend>Captions</legend>
        <label className="field">
          <span>Style</span>
          <select
            value={draft.captionStyle}
            onChange={(e) =>
              set("captionStyle", e.target.value as Settings["captionStyle"], 0)
            }
          >
            <option value="natural">
              Natural language (Krea 2, Flux, Qwen-Image)
            </option>
            <option value="tags">Booru tags (Illustrious, Pony, NoobAI)</option>
          </select>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={draft.captionDescribeHair}
            onChange={(e) => set("captionDescribeHair", e.target.checked, 0)}
          />
          Describe hair (turn off if the hairstyle should be part of the
          character)
        </label>
        <label className="field">
          <span>Extra instructions</span>
          <textarea
            rows={3}
            value={draft.captionInstructions}
            placeholder="e.g. Always mention the tattoo on the left arm."
            onChange={(e) => set("captionInstructions", e.target.value)}
          />
        </label>
      </fieldset>
    </aside>
  )
}
