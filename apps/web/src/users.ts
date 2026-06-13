import type { WorldId } from "@sig/core";

/**
 * Five fake users (no real auth — hackathon). Switching user changes the whole
 * desktop: a different backend world (own data + own Redis memory), accent,
 * density, and an ambient background palette. The background palettes are kept
 * deliberately pale and slow — they read as "lit from within", never busy.
 */
export type BgPalette = {
  /** Four pale RGB triplets (0..1) the shader blends between. */
  colors: [[number, number, number], [number, number, number], [number, number, number], [number, number, number]];
  /** Drift speed — tiny. The whole point is "hardly moving". */
  speed: number;
  /** How far the result is lifted toward white (0..1). Higher = calmer. */
  lift: number;
};

export type ShineUser = {
  id: string;
  name: string;
  initial: string;
  world: WorldId;
  density: "compact" | "default" | "spacious";
  /** CSS gradient for the avatar. */
  avatar: string;
  /** CSS custom-property overrides applied to the shell. */
  theme: Record<string, string>;
  bg: BgPalette;
};

export const users: ShineUser[] = [
  {
    id: "aria",
    name: "Aria Chen",
    initial: "A",
    world: "world-a",
    density: "default",
    avatar: "linear-gradient(140deg, #6b7bff, #9b6bff)",
    theme: {
      "--accent": "#5b6cff",
      "--accent-soft": "rgba(91, 108, 255, 0.12)",
      "--accent-line": "rgba(91, 108, 255, 0.42)",
    },
    bg: {
      colors: [
        [0.74, 0.79, 1.0],
        [0.85, 0.8, 1.0],
        [0.8, 0.88, 1.0],
        [0.9, 0.86, 1.0],
      ],
      speed: 0.022,
      lift: 0.32,
    },
  },
  {
    id: "mori",
    name: "Mori Tan",
    initial: "M",
    world: "world-b",
    density: "spacious",
    avatar: "linear-gradient(140deg, #f0915f, #e85d8a)",
    theme: {
      "--accent": "#e0794a",
      "--accent-soft": "rgba(224, 121, 74, 0.13)",
      "--accent-line": "rgba(224, 121, 74, 0.42)",
    },
    bg: {
      colors: [
        [1.0, 0.87, 0.76],
        [1.0, 0.82, 0.74],
        [1.0, 0.91, 0.82],
        [1.0, 0.85, 0.8],
      ],
      speed: 0.02,
      lift: 0.34,
    },
  },
  {
    id: "sol",
    name: "Sol Reyes",
    initial: "S",
    world: "world-c",
    density: "default",
    avatar: "linear-gradient(140deg, #14b8a6, #2dd4bf)",
    theme: {
      "--accent": "#12a594",
      "--accent-soft": "rgba(18, 165, 148, 0.13)",
      "--accent-line": "rgba(18, 165, 148, 0.42)",
    },
    bg: {
      colors: [
        [0.76, 0.96, 0.9],
        [0.8, 0.95, 0.88],
        [0.84, 0.98, 0.93],
        [0.88, 0.96, 0.91],
      ],
      speed: 0.024,
      lift: 0.33,
    },
  },
  {
    id: "noor",
    name: "Noor Hassan",
    initial: "N",
    world: "world-d",
    density: "compact",
    avatar: "linear-gradient(140deg, #a78bfa, #c084fc)",
    theme: {
      "--accent": "#8b5cf6",
      "--accent-soft": "rgba(139, 92, 246, 0.12)",
      "--accent-line": "rgba(139, 92, 246, 0.42)",
    },
    bg: {
      colors: [
        [0.86, 0.79, 1.0],
        [0.91, 0.81, 0.98],
        [0.84, 0.77, 0.97],
        [0.94, 0.86, 1.0],
      ],
      speed: 0.02,
      lift: 0.34,
    },
  },
  {
    id: "kai",
    name: "Kai Möller",
    initial: "K",
    world: "world-e",
    density: "spacious",
    avatar: "linear-gradient(140deg, #64748b, #94a3b8)",
    theme: {
      "--accent": "#5a6b7b",
      "--accent-soft": "rgba(90, 107, 123, 0.12)",
      "--accent-line": "rgba(90, 107, 123, 0.4)",
    },
    bg: {
      colors: [
        [0.87, 0.9, 0.94],
        [0.89, 0.91, 0.95],
        [0.91, 0.93, 0.96],
        [0.85, 0.89, 0.93],
      ],
      speed: 0.016,
      lift: 0.38,
    },
  },
];
