import type { CSSProperties } from "react";
import type { BgPalette } from "./users";

function channel(value: number) {
  return Math.round(Math.max(0, Math.min(1, value)) * 255);
}

function colorStop(color: [number, number, number], alpha: number) {
  return `rgba(${channel(color[0])}, ${channel(color[1])}, ${channel(color[2])}, ${alpha})`;
}

export function ShineBackground({ palette }: { palette: BgPalette }) {
  // Dark palettes lean into the glow (Luma look); light ones stay barely-there.
  const alpha = palette.dark ? [0.92, 0.78, 0.66, 0.52] : [0.55, 0.48, 0.42, 0.36];
  const base = palette.base ?? [1, 1, 1];
  return (
    <div
      className={palette.dark ? "shine-bg shine-bg--css shine-bg--dark" : "shine-bg shine-bg--css"}
      aria-hidden="true"
      style={
        {
          "--shine-bg-base": colorStop(base, 1),
          "--shine-bg-1": colorStop(palette.colors[0], alpha[0]),
          "--shine-bg-2": colorStop(palette.colors[1], alpha[1]),
          "--shine-bg-3": colorStop(palette.colors[2], alpha[2]),
          "--shine-bg-4": colorStop(palette.colors[3], alpha[3]),
        } as CSSProperties
      }
    />
  );
}
