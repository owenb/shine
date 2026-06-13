import { useRef, useState, type CSSProperties } from "react";

type ScrubberProps = {
  length: number;
  index: number;
  live: boolean;
  label: string;
  onScrub: (index: number) => void;
  onLive: () => void;
};

/**
 * The time-travel scrubber. Drag it and the world rewinds.
 *
 * Buttery rule: the thumb follows the pointer continuously (a local, un-quantized
 * position) so motion is frame-perfect, while the committed transaction only
 * changes when you cross into a new tick — so we never spam the network mid-drag.
 * A ripple blooms where you grab it; the thumb carries a soft glow that tightens
 * while held.
 */
export function Scrubber({ length, index, live, label, onScrub, onLive }: ScrubberProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragPos, setDragPos] = useState<number | null>(null);
  const [ripple, setRipple] = useState<{ key: number; x: number } | null>(null);
  const rippleKey = useRef(0);
  const lastIndex = useRef(index);

  const maxIndex = Math.max(length - 1, 0);
  const restPos = maxIndex === 0 ? 0 : index / maxIndex;
  const pos = dragPos ?? restPos;

  function ratioFromEvent(clientX: number) {
    const track = trackRef.current;
    if (!track) return 0;
    const rect = track.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - rect.left) / Math.max(rect.width, 1)));
  }

  function commit(ratio: number) {
    const next = Math.round(ratio * maxIndex);
    if (next !== lastIndex.current) {
      lastIndex.current = next;
      onScrub(next);
    }
  }

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (maxIndex === 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const ratio = ratioFromEvent(event.clientX);
    setDragPos(ratio);
    setRipple({ key: rippleKey.current++, x: ratio });
    lastIndex.current = index;
    commit(ratio);
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (dragPos === null) return;
    const ratio = ratioFromEvent(event.clientX);
    setDragPos(ratio);
    commit(ratio);
  }

  function endDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (dragPos === null) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDragPos(null);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      onScrub(Math.max(index - 1, 0));
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      onScrub(Math.min(index + 1, maxIndex));
    }
  }

  return (
    <div className="scrubber">
      <span className="scrubber-tx">{label}</span>
      <div
        ref={trackRef}
        className={`scrub-track${dragPos !== null ? " is-dragging" : ""}`}
        style={{ "--pos": pos } as CSSProperties}
        role="slider"
        tabIndex={0}
        aria-label="Time-travel scrubber"
        aria-valuemin={0}
        aria-valuemax={maxIndex}
        aria-valuenow={index}
        aria-valuetext={`${label}, ${live ? "live" : "history"}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        onKeyDown={onKeyDown}
      >
        <div className="scrub-fill" />
        <div className="scrub-thumb">
          {ripple ? (
            <span key={ripple.key} className="scrub-ripple" onAnimationEnd={() => setRipple(null)} />
          ) : null}
        </div>
      </div>
      <button type="button" className={`scrub-live${live ? " is-live" : ""}`} onClick={onLive}>
        Live
      </button>
    </div>
  );
}
