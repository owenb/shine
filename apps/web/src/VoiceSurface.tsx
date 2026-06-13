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
  const { title, subtitle, stat } = surface.data;

  useEffect(() => {
    const controller = new AbortController();
    let audioUrl: string | null = null;
    const summary = [
      title,
      subtitle,
      stat.label,
      stat.value,
      stat.delta,
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
  }, [surface.surfaceId, title, subtitle, stat.label, stat.value, stat.delta]);

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
