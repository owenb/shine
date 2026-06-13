import { z } from "zod";

export const worlds = ["world-a", "world-b", "world-c", "world-d", "world-e"] as const;
export type WorldId = (typeof worlds)[number];

export const WorldIdSchema = z.enum(worlds);

export const CommandSchema = z.object({
  world: WorldIdSchema,
  prompt: z.string().min(1).max(500),
  source: z.enum(["composer", "copilotkit", "demo"]).optional(),
});

export type CommandInput = z.infer<typeof CommandSchema>;

export const WidgetFrameSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().min(0.18).max(0.95),
  height: z.number().min(0.2).max(0.9),
});

export const LayoutPatchSchema = z.object({
  world: WorldIdSchema,
  surfaceId: z.string().min(1).max(120),
  frame: WidgetFrameSchema,
});

export type WidgetFrame = z.infer<typeof WidgetFrameSchema>;
export type LayoutPatchInput = z.infer<typeof LayoutPatchSchema>;

export type DesktopLayout = {
  widgets: Record<string, WidgetFrame>;
};

export type SignalPacket =
  | {
      type: "renderWidget";
      intent: "revenue" | "competitors" | "research" | "pipeline" | "summary";
      prompt: string;
    }
  | {
      type: "setPreference";
      key: "presentation" | "tone" | "renderer" | "component";
      value: string;
      prompt: string;
    };

export type A2UIOp = Record<string, unknown> & { version: "v0.9" };

export type TrendDatum = {
  label: string;
  value: number;
};

export type TableRow = Record<string, string>;

export type Source = {
  title: string;
  url: string;
  label: string;
  snippet?: string;
};

export type Grounding = {
  answer: string;
  sources: Source[];
  reused: boolean;
  provider: "linkup";
};

export type SignalSurfaceData = {
  title: string;
  subtitle: string;
  stat: {
    label: string;
    value: string;
    delta: string;
  };
  trend: TrendDatum[];
  rows: TableRow[];
  sources: Source[];
  memoryNote: string;
  txLabel: string;
  grounded?: Grounding;
};

export type SurfaceKind = "metric" | "trend" | "table" | "sources";
export type ComponentVariant = "crystal" | "ledger" | "brief";

export type SignalSurface = {
  surfaceId: string;
  catalogId: string;
  kind: SurfaceKind;
  variant: ComponentVariant;
  data: SignalSurfaceData;
  ops: A2UIOp[];
};

export type SceneNode =
  | {
      type: "box";
      id: string;
      x: number;
      y: number;
      width: number;
      height: number;
      radius: number;
      fill: string;
      stroke?: string;
      shadow?: string;
    }
  | {
      type: "text";
      id: string;
      text: string;
      x: number;
      y: number;
      maxWidth: number;
      lineHeight: number;
      fontSize: number;
      fontWeight: number;
      color: string;
    }
  | {
      type: "rule";
      id: string;
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      color: string;
    }
  | {
      type: "metric";
      id: string;
      label: string;
      value: string;
      delta: string;
      x: number;
      y: number;
      accent: string;
    }
  | {
      type: "chart";
      id: string;
      points: Array<{ x: number; y: number }>;
      accent: string;
    };

export type SceneHotspot = {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  action:
    | {
        type: "openUrl";
        url: string;
      }
    | {
        type: "none";
      };
};

export type SignalScene = {
  width: number;
  height: number;
  accent: string;
  nodes: SceneNode[];
  hotspots: SceneHotspot[];
};

export type AgentRole = "curator" | "researcher" | "builder";

export type Receipt = {
  tx: number;
  accepted: boolean;
  code: string;
  message: string;
  at: string;
  role?: AgentRole | null;
};

export type TimelineItem = {
  tx: number;
  summary: string;
  at: string;
};

export type WorldPreferences = {
  presentation: "visual" | "table" | "brief";
  tone: "calm" | "sharp";
  renderer: "dom" | "fabric" | "voice";
  component: ComponentVariant;
};

export type WorldState = {
  world: WorldId;
  headTx: number;
  selectedTx: number;
  preferences: WorldPreferences;
  surface: SignalSurface | null;
  scene: SignalScene | null;
  timeline: TimelineItem[];
  receipts: Receipt[];
  componentModule: {
    hash: string;
    body: string;
  } | null;
  layout: DesktopLayout;
  agent: {
    provider: "gemini";
    model: string;
    reused: boolean;
    grounded: boolean;
    memory?: {
      provider: "redis-hash";
      count: number;
    };
  } | null;
  redis: {
    configured: boolean;
    connected: boolean;
    memory: Record<string, string>;
  };
  linkup: {
    configured: boolean;
  };
};

export const CATALOG_ID = "https://signal-ui.local/catalog/v0";
export const SURFACE_ID = "signal-surface";

export function isWorldId(value: string): value is WorldId {
  return worlds.includes(value as WorldId);
}

export function defaultPreferences(world: WorldId): WorldPreferences {
  switch (world) {
    case "world-b":
      return { presentation: "table", tone: "calm", renderer: "dom", component: "ledger" };
    case "world-c":
      return { presentation: "brief", tone: "calm", renderer: "dom", component: "brief" };
    case "world-d":
      return { presentation: "visual", tone: "sharp", renderer: "fabric", component: "crystal" };
    case "world-e":
      return { presentation: "table", tone: "sharp", renderer: "dom", component: "ledger" };
    default:
      return { presentation: "visual", tone: "sharp", renderer: "dom", component: "crystal" };
  }
}

export function defaultDesktopLayout(world: WorldId): DesktopLayout {
  return {
    widgets: {
      [SURFACE_ID]:
        world === "world-b"
          ? { x: 0.25, y: 0.12, width: 0.56, height: 0.54 }
          : { x: 0.25, y: 0.16, width: 0.54, height: 0.5 },
    },
  };
}

export function normalizeWidgetFrame(frame: WidgetFrame): WidgetFrame {
  const width = clamp(frame.width, 0.18, 0.95);
  const height = clamp(frame.height, 0.2, 0.9);
  return {
    x: clamp(frame.x, 0, 1 - width),
    y: clamp(frame.y, 0, 1 - height),
    width,
    height,
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function composeSurface(
  world: WorldId,
  preferences: WorldPreferences,
  signal: SignalPacket,
  tx: number,
  grounding?: Grounding,
): SignalSurface {
  const intent = signal.type === "renderWidget" ? signal.intent : "summary";
  const useTable =
    preferences.presentation === "table" ||
    (world === "world-b" && preferences.presentation !== "visual");
  const kind: SurfaceKind =
    intent === "competitors" || intent === "research"
      ? "sources"
      : useTable
        ? "table"
        : intent === "summary" || preferences.presentation === "brief"
          ? "metric"
          : "trend";

  const data = dataForIntent(intent, preferences, tx, grounding);
  const rootComponent =
    kind === "table"
      ? "ledger-table"
      : kind === "sources"
        ? "source-card"
        : kind === "metric"
          ? "metric-card"
          : "trend-card";

  const ops: A2UIOp[] = [
    {
      version: "v0.9",
      createSurface: {
        surfaceId: SURFACE_ID,
        catalogId: CATALOG_ID,
      },
    },
    {
      version: "v0.9",
      updateComponents: {
        surfaceId: SURFACE_ID,
        components: [
          {
            id: "root",
            component: "SignalWidget",
            variant: preferences.component,
            kind,
            child: rootComponent,
          },
          {
            id: "metric-card",
            component: "MetricCard",
            label: { path: "/stat/label" },
            value: { path: "/stat/value" },
            delta: { path: "/stat/delta" },
          },
          {
            id: "trend-card",
            component: "TrendCard",
            title: { path: "/title" },
            subtitle: { path: "/subtitle" },
            data: { path: "/trend" },
          },
          {
            id: "ledger-table",
            component: "LedgerTable",
            title: { path: "/title" },
            rows: { path: "/rows" },
          },
          {
            id: "source-card",
            component: "SourceCard",
            title: { path: "/title" },
            subtitle: { path: "/subtitle" },
            sources: { path: "/sources" },
          },
        ],
      },
    },
    {
      version: "v0.9",
      updateDataModel: {
        surfaceId: SURFACE_ID,
        path: "/",
        value: data,
      },
    },
  ];

  return {
    surfaceId: SURFACE_ID,
    catalogId: CATALOG_ID,
    kind,
    variant: preferences.component,
    data,
    ops,
  };
}

export function composeScene(surface: SignalSurface, preferences: WorldPreferences): SignalScene {
  const accent = accentForComponent(preferences.component);
  const nodes: SceneNode[] = [
    {
      type: "box",
      id: "frame",
      x: 40,
      y: 42,
      width: 840,
      height: 430,
      radius: preferences.component === "ledger" ? 10 : 18,
      fill: "rgba(255,255,255,0.97)",
      stroke: "rgba(17,17,20,0.08)",
      shadow: "rgba(20,24,32,0.16)",
    },
    {
      type: "text",
      id: "title",
      text: surface.data.title,
      x: 86,
      y: 128,
      maxWidth: 700,
      lineHeight: 56,
      fontSize: 54,
      fontWeight: 650,
      color: "#111114",
    },
    {
      type: "text",
      id: "subtitle",
      text: surface.data.subtitle,
      x: 88,
      y: 190,
      maxWidth: 650,
      lineHeight: 34,
      fontSize: 24,
      fontWeight: 400,
      color: "#6f7280",
    },
  ];
  const hotspots: SceneHotspot[] = [];

  if (surface.kind === "sources") {
    surface.data.sources.slice(0, 4).forEach((source, index) => {
      const y = 280 + index * 58;
      nodes.push({
        type: "rule",
        id: `rule-${index}`,
        x1: 88,
        y1: y - 28,
        x2: 832,
        y2: y - 28,
        color: "#e8e8ec",
      });
      nodes.push({
        type: "text",
        id: `source-title-${index}`,
        text: source.title,
        x: 88,
        y,
        maxWidth: 420,
        lineHeight: 28,
        fontSize: 22,
        fontWeight: 600,
        color: "#111114",
      });
      nodes.push({
        type: "text",
        id: `source-label-${index}`,
        text: source.label,
        x: 690,
        y,
        maxWidth: 140,
        lineHeight: 24,
        fontSize: 18,
        fontWeight: 400,
        color: "#8a8c94",
      });
      hotspots.push({
        id: `source-${index}`,
        label: source.title,
        x: 78,
        y: y - 40,
        width: 764,
        height: 52,
        action: { type: "openUrl", url: source.url },
      });
    });
  } else if (surface.kind === "table") {
    surface.data.rows.slice(0, 4).forEach((row, index) => {
      const y = 280 + index * 58;
      const values = Object.values(row);
      nodes.push({
        type: "rule",
        id: `rule-${index}`,
        x1: 88,
        y1: y - 28,
        x2: 832,
        y2: y - 28,
        color: "#e8e8ec",
      });
      nodes.push({
        type: "text",
        id: `row-primary-${index}`,
        text: values[0] ?? "",
        x: 88,
        y,
        maxWidth: 330,
        lineHeight: 28,
        fontSize: 22,
        fontWeight: 600,
        color: "#111114",
      });
      nodes.push({
        type: "text",
        id: `row-rest-${index}`,
        text: values.slice(1).join("  "),
        x: 520,
        y,
        maxWidth: 300,
        lineHeight: 28,
        fontSize: 20,
        fontWeight: 400,
        color: "#8a8c94",
      });
    });
  } else if (surface.kind === "trend") {
    const points = chartPoints(surface.data.trend, 88, 280, 744, 140);
    nodes.push({ type: "chart", id: "trend", points, accent });
  } else {
    nodes.push({
      type: "metric",
      id: "metric",
      label: surface.data.stat.label,
      value: surface.data.stat.value,
      delta: surface.data.stat.delta,
      x: 88,
      y: 330,
      accent,
    });
  }

  return {
    width: 920,
    height: 520,
    accent,
    nodes,
    hotspots,
  };
}

export function accentForComponent(component: ComponentVariant) {
  if (component === "ledger") return "#111114";
  if (component === "brief") return "#1db36b";
  return "#1677ff";
}

function dataForIntent(
  intent: "revenue" | "competitors" | "research" | "pipeline" | "summary",
  preferences: WorldPreferences,
  tx: number,
  grounding?: Grounding,
): SignalSurfaceData {
  const suffix = preferences.presentation === "table" ? "as rows" : "as motion";
  if (intent === "competitors" || intent === "research") {
    const groundedSources = grounding?.sources ?? [];
    const rows = groundedSources.length
      ? groundedSources.map((source) => ({
          source: source.title,
          domain: source.label,
          signal: source.snippet ? source.snippet.slice(0, 64) : "Live citation",
        }))
      : [];
    return {
      title: intent === "competitors" ? "Stripe competitor pulse" : "Research pulse",
      subtitle: grounding
        ? conciseGroundingAnswer(grounding.answer, groundedSources)
        : "Live citations unavailable until LINKUP_API_KEY is configured.",
      stat: {
        label: "Sources",
        value: String(groundedSources.length),
        delta: grounding?.reused ? "cached" : grounding ? "live" : "not configured",
      },
      trend: [
        { label: "Mon", value: 18 },
        { label: "Tue", value: 28 },
        { label: "Wed", value: 22 },
        { label: "Thu", value: 34 },
        { label: "Fri", value: 41 },
      ],
      rows,
      sources: groundedSources,
      memoryNote: `Rendered ${suffix}`,
      txLabel: `tx ${String(tx).padStart(3, "0")}`,
      grounded: grounding,
    };
  }

  if (intent === "pipeline") {
    return {
      title: "Pipeline velocity",
      subtitle: "Same facts, personalized surface.",
      stat: { label: "Qualified", value: "$2.8M", delta: "+14%" },
      trend: [
        { label: "Jan", value: 21 },
        { label: "Feb", value: 24 },
        { label: "Mar", value: 32 },
        { label: "Apr", value: 30 },
        { label: "May", value: 39 },
        { label: "Jun", value: 45 },
      ],
      rows: [
        { segment: "Enterprise", value: "$1.4M", change: "+19%" },
        { segment: "Mid-market", value: "$820k", change: "+8%" },
        { segment: "Startup", value: "$560k", change: "+11%" },
      ],
      sources: [],
      memoryNote: `Rendered ${suffix}`,
      txLabel: `tx ${String(tx).padStart(3, "0")}`,
    };
  }

  if (intent === "summary") {
    return {
      title: "Operating summary",
      subtitle: "The agent compressed the current world into one surface.",
      stat: { label: "Health", value: "92", delta: "+5" },
      trend: [
        { label: "1", value: 62 },
        { label: "2", value: 72 },
        { label: "3", value: 70 },
        { label: "4", value: 84 },
        { label: "5", value: 92 },
      ],
      rows: [
        { area: "Product", state: "Ahead", next: "Launch review" },
        { area: "Revenue", state: "Stable", next: "QBR pack" },
        { area: "Support", state: "Watch", next: "Queue triage" },
      ],
      sources: [],
      memoryNote: `Rendered ${suffix}`,
      txLabel: `tx ${String(tx).padStart(3, "0")}`,
    };
  }

  return {
    title: "Revenue overview",
    subtitle: "A live widget the agent composed into A2UI.",
    stat: { label: "ARR", value: "$12.4M", delta: "+18%" },
    trend: [
      { label: "Jan", value: 42 },
      { label: "Feb", value: 48 },
      { label: "Mar", value: 51 },
      { label: "Apr", value: 57 },
      { label: "May", value: 63 },
      { label: "Jun", value: 76 },
    ],
    rows: [
      { metric: "ARR", value: "$12.4M", change: "+18%" },
      { metric: "Net retention", value: "128%", change: "+6%" },
      { metric: "Expansion", value: "$1.9M", change: "+22%" },
    ],
    sources: [],
    memoryNote: `Rendered ${suffix}`,
    txLabel: `tx ${String(tx).padStart(3, "0")}`,
  };
}

function conciseGroundingAnswer(answer: string, sources: Source[]) {
  const labels = sources
    .map((source) => source.label)
    .filter(Boolean)
    .slice(0, 3);

  if (labels.length) {
    const sourceWord = sources.length === 1 ? "source" : "sources";
    return `Live LinkUp research from ${sources.length} cited ${sourceWord}: ${labels.join(", ")}.`;
  }

  const normalized = answer.replace(/\s+/g, " ").trim();
  return normalized
    ? `LinkUp returned a live answer without cited sources: ${normalized.slice(0, 160)}`
    : "LinkUp returned a live answer without cited sources.";
}

function chartPoints(
  data: TrendDatum[],
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const max = Math.max(...data.map((d) => d.value), 1);
  const min = Math.min(...data.map((d) => d.value), 0);
  const span = Math.max(max - min, 1);
  return data.map((datum, index) => ({
    x: x + (index / Math.max(data.length - 1, 1)) * width,
    y: y + height - ((datum.value - min) / span) * height,
  }));
}
