import { useEffect, useRef, useState } from "react";
import type { Framing, Settings, VeniceModel } from "../../src/types";
import { api } from "../api";

interface Props {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
}

/** Edits are kept locally and sent after a short pause, so typing doesn't re-run selection on every key. */
export function SettingsPanel({ settings, onChange }: Props) {
  const [draft, setDraft] = useState(settings);
  const pending = useRef<Partial<Settings>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [models, setModels] = useState<VeniceModel[] | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);

  useEffect(() => {
    if (!timer.current) setDraft(settings);
  }, [settings]);

  useEffect(() => {
    api.models().then(setModels, (e) => setModelError(e.message));
  }, []);

  const set = <K extends keyof Settings>(key: K, value: Settings[K], delay = 600) => {
    setDraft((d) => ({ ...d, [key]: value }));
    pending.current[key] = value;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      const patch = pending.current;
      pending.current = {};
      onChange(patch);
    }, delay);
  };

  const num = (key: keyof Settings, label: string, opts: { min?: number; max?: number; step?: number; hint?: string }) => (
    <label className="field">
      <span>{label}</span>
      <input
        type="number"
        min={opts.min}
        max={opts.max}
        step={opts.step ?? 1}
        value={draft[key] as number}
        onChange={(e) => e.target.value !== "" && set(key, Number(e.target.value) as never)}
      />
      {opts.hint && <small>{opts.hint}</small>}
    </label>
  );

  const modelSelect = (key: "tagModel" | "captionModel", label: string, hint: string) => {
    const current = draft[key];
    const list = models ?? [];
    return (
      <label className="field">
        <span>{label}</span>
        <select value={current} onChange={(e) => set(key, e.target.value, 0)}>
          {!list.some((m) => m.id === current) && <option value={current}>{current}</option>}
          {list.map((m) => (
            <option key={m.id} value={m.id}>
              {m.id}
              {m.priceIn != null ? ` — $${m.priceIn}/$${m.priceOut} per M` : ""}
              {m.schema ? "" : " (no JSON mode)"}
            </option>
          ))}
        </select>
        <small>{hint}</small>
      </label>
    );
  };

  const setMix = (f: Framing, v: number) => set("framingMix", { ...draft.framingMix, [f]: v });

  return (
    <aside className="settings">
      <h2>Settings</h2>

      <fieldset>
        <legend>Character</legend>
        <label className="field">
          <span>Trigger word</span>
          <input value={draft.triggerWord} placeholder="e.g. ohwx or jane_doe" onChange={(e) => set("triggerWord", e.target.value)} />
          <small>Captions start with this name.</small>
        </label>
        <label className="field">
          <span>Class</span>
          <input value={draft.subjectClass} placeholder="woman, man, person" onChange={(e) => set("subjectClass", e.target.value)} />
        </label>
      </fieldset>

      <fieldset>
        <legend>Selection</legend>
        {num("targetCount", "Target images", { min: 1, max: 500 })}
        <label className="field">
          <span>
            Variety vs quality <b>{Math.round(draft.diversity * 100)}%</b>
          </span>
          <input type="range" min={0} max={1} step={0.05} value={draft.diversity} onChange={(e) => set("diversity", Number(e.target.value), 300)} />
          <small>0% picks the highest scores; 100% favours images unlike those already picked.</small>
        </label>
        <div className="field">
          <span>Framing mix (share of the target)</span>
          <div className="mix">
            {(["closeup", "half", "full"] as Framing[]).map((f) => (
              <label key={f}>
                <small>{f === "closeup" ? "Close-up" : f === "half" ? "Half" : "Full"}</small>
                <input type="number" min={0} max={1} step={0.05} value={draft.framingMix[f]} onChange={(e) => setMix(f, Number(e.target.value))} />
              </label>
            ))}
          </div>
        </div>
      </fieldset>

      <fieldset>
        <legend>Filters</legend>
        {num("minShortSide", "Min short side (px)", { min: 256, step: 64 })}
        {num("preferredShortSide", "Preferred short side (px)", { min: 256, step: 64 })}
        {num("minFaceSharpness", "Min face sharpness", { min: 0, step: 5, hint: "See \"Face sharpness\" in an image's details." })}
        {num("identityThreshold", "Identity threshold", { min: 0, max: 1, step: 0.02, hint: "Face similarity needed to count as the character (0.35–0.5)." })}
        {num("otherPersonMinFace", "Other-person face size", { min: 0, max: 1, step: 0.01, hint: "Smaller background faces are ignored." })}
        {num("dedupPhashDistance", "Duplicate: hash distance", { min: 0, max: 32 })}
        {num("dedupClipSimilarity", "Duplicate: similarity", { min: 0.5, max: 1, step: 0.01 })}
        {draft.referenceImageIds.length > 0 && (
          <div className="field">
            <span>Identity references: {draft.referenceImageIds.length}</span>
            <button className="ghost small" onClick={() => set("referenceImageIds", [], 0)}>
              Clear (use automatic)
            </button>
          </div>
        )}
      </fieldset>

      <fieldset>
        <legend>Venice AI</legend>
        {modelError && <div className="banner error small">{modelError}</div>}
        {modelSelect("tagModel", "Review model", "Rates every image that passes the local filters. A cheap model is fine.")}
        {modelSelect("captionModel", "Caption model", "Only selected images are captioned.")}
        {num("concurrency", "Parallel requests", { min: 1, max: 16 })}
      </fieldset>

      <fieldset>
        <legend>Captions</legend>
        <label className="field">
          <span>Style</span>
          <select value={draft.captionStyle} onChange={(e) => set("captionStyle", e.target.value as Settings["captionStyle"], 0)}>
            <option value="natural">Natural language (Krea 2, Flux, Qwen-Image)</option>
            <option value="tags">Booru tags (Illustrious, Pony, NoobAI)</option>
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={draft.captionDescribeHair} onChange={(e) => set("captionDescribeHair", e.target.checked, 0)} />
          Describe hair (turn off if the hairstyle should be part of the character)
        </label>
        <label className="field">
          <span>Extra instructions</span>
          <textarea rows={3} value={draft.captionInstructions} placeholder="e.g. Always mention the tattoo on the left arm." onChange={(e) => set("captionInstructions", e.target.value)} />
        </label>
      </fieldset>
    </aside>
  );
}
