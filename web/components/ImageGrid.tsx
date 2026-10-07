import { memo } from "react";
import { REASON_LABELS, type ImageRecord, type Override } from "../../src/types";
import { thumbUrl } from "../api";

interface Props {
  images: ImageRecord[];
  references: number[];
  onOpen: (id: number) => void;
  onOverride: (id: number, o: Override) => void;
}

export function ImageGrid({ images, references, onOpen, onOverride }: Props) {
  return (
    <div className="grid">
      {images.map((im) => (
        <Card key={im.id} im={im} isRef={references.includes(im.id)} onOpen={onOpen} onOverride={onOverride} />
      ))}
    </div>
  );
}

const FRAMING_SHORT = { closeup: "close", half: "half", full: "full" } as const;

const Card = memo(function Card({
  im,
  isRef,
  onOpen,
  onOverride,
}: {
  im: ImageRecord;
  isRef: boolean;
  onOpen: (id: number) => void;
  onOverride: (id: number, o: Override) => void;
}) {
  const stop = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn();
  };
  return (
    <div className={`card status-${im.status}`} onClick={() => onOpen(im.id)} title={im.relPath}>
      <div className="thumb">
        <img src={thumbUrl(im.hash)} loading="lazy" alt={im.relPath} />
        <div className="card-badges">
          {im.score != null && <span className="badge score">{Math.round(im.score * 100)}</span>}
          {im.framing && <span className="badge">{FRAMING_SHORT[im.framing]}</span>}
          {im.override && <span className={`badge override-${im.override}`}>{im.override === "include" ? "pinned" : "excluded"}</span>}
          {isRef && <span className="badge ref">ref</span>}
          {im.status === "selected" && im.caption && <span className="badge caption">txt</span>}
        </div>
        <div className="card-actions">
          {im.override !== "include" && (
            <button className="icon" title="Always include" onClick={stop(() => onOverride(im.id, "include"))}>
              ✓
            </button>
          )}
          {im.override !== "exclude" && (
            <button className="icon" title="Always exclude" onClick={stop(() => onOverride(im.id, "exclude"))}>
              ✕
            </button>
          )}
          {im.override && (
            <button className="icon" title="Let the AI decide" onClick={stop(() => onOverride(im.id, null))}>
              ↺
            </button>
          )}
        </div>
      </div>
      {im.reasons.length > 0 && (
        <div className="card-reasons">
          {im.reasons.slice(0, 2).map((r) => (
            <span key={r} className="reason">
              {REASON_LABELS[r] ?? r}
            </span>
          ))}
          {im.reasons.length > 2 && <span className="reason">+{im.reasons.length - 2}</span>}
        </div>
      )}
    </div>
  );
});
