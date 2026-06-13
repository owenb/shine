import type { CSSProperties } from "react";
import type { BgPalette } from "./users";

function channel(value: number) {
  return Math.round(Math.max(0, Math.min(1, value)) * 255);
}

function colorStop(color: [number, number, number], alpha: number) {
  return `rgba(${channel(color[0])}, ${channel(color[1])}, ${channel(color[2])}, ${alpha})`;
}

export function ShineBackground({ palette }: { palette: BgPalette }) {
  return (
    <div
      className="shine-bg shine-bg--css"
      aria-hidden="true"
      style={
        {
          "--shine-bg-1": colorStop(palette.colors[0], 0.55),
          "--shine-bg-2": colorStop(palette.colors[1], 0.48),
          "--shine-bg-3": colorStop(palette.colors[2], 0.42),
          "--shine-bg-4": colorStop(palette.colors[3], 0.36),
        } as CSSProperties
      }
    />
  );
}
