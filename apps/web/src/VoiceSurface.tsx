import { useEffect, type ReactNode } from "react";
import type { SignalSurface } from "@sig/core";

export function VoiceSurface({
  surface,
  children,
}: {
  surface: SignalSurface;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!("speechSynthesis" in window)) return;
    const summary = [
      surface.data.title,
      surface.data.subtitle,
      surface.data.stat.label,
      surface.data.stat.value,
      surface.data.stat.delta,
    ]
      .filter(Boolean)
      .join(". ");
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(summary);
    utterance.rate = 0.94;
    utterance.pitch = 1;
    window.speechSynthesis.speak(utterance);
    return () => window.speechSynthesis.cancel();
  }, [surface.surfaceId, surface.data.title, surface.data.subtitle, surface.data.stat]);

  return (
    <div className="voice-stage">
      {children}
      <div className="voice-wave" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}
