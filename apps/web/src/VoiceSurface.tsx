import { useEffect, useRef, type ReactNode } from "react";
import type { SignalSurface } from "@sig/core";

export function VoiceSurface({
  surface,
  children,
}: {
  surface: SignalSurface;
  children: ReactNode;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let audioUrl: string | null = null;
    const summary = [
      surface.data.title,
      surface.data.subtitle,
      surface.data.stat.label,
      surface.data.stat.value,
      surface.data.stat.delta,
    ]
      .filter(Boolean)
      .join(". ");
    const text = `[calm, precise, quietly confident] ${summary}`;

    void fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice: "Kore" }),
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as
            | { details?: string; error?: string }
            | null;
          throw new Error(body?.details ?? body?.error ?? `TTS failed with ${response.status}`);
        }
        return response.blob();
      })
      .then(async (blob) => {
        audioUrl = URL.createObjectURL(blob);
        const audio = new Audio(audioUrl);
        audioRef.current?.pause();
        audioRef.current = audio;
        await audio.play();
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          console.error("[voice] Gemini TTS failed", error);
        }
      });

    return () => {
      controller.abort();
      audioRef.current?.pause();
      audioRef.current = null;
      if (audioUrl) URL.revokeObjectURL(audioUrl);
    };
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
