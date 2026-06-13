import { useEffect, useRef, useState, type ReactNode } from "react";
import { z } from "zod";
import { createCatalog, type CatalogRenderers, type RendererProps } from "@copilotkit/a2ui-renderer";
import { CATALOG_ID, type Source, type TableRow, type TrendDatum } from "@sig/core";
import "./charts.css";

const childRef = z.string();
const stringOrPath = z.union([z.string(), z.object({ path: z.string() })]);

export const definitions = {
  SignalWidget: {
    description: "Minimal outer frame for one generated Shine widget.",
    props: z.object({
      child: childRef,
      kind: z.enum(["metric", "trend", "table", "sources", "bar", "donut"]),
      variant: z.enum(["crystal", "ledger", "brief"]),
    }),
  },
  MetricCard: {
    description: "One large metric with delta.",
    props: z.object({
      label: stringOrPath,
      value: stringOrPath,
      delta: stringOrPath,
    }),
  },
  TrendCard: {
    description: "One calm line chart widget.",
    props: z.object({
      title: stringOrPath,
      subtitle: stringOrPath,
      data: z.union([z.array(z.object({ label: z.string(), value: z.number() })), z.object({ path: z.string() })]),
    }),
  },
  BarChart: {
    description: "A bar chart of a labeled numeric series.",
    props: z.object({
      title: stringOrPath,
      subtitle: stringOrPath,
      data: z.union([z.array(z.object({ label: z.string(), value: z.number() })), z.object({ path: z.string() })]),
    }),
  },
  DonutChart: {
    description: "A donut chart of labeled segments with a legend.",
    props: z.object({
      title: stringOrPath,
      subtitle: stringOrPath,
      segments: z.union([z.array(z.object({ label: z.string(), value: z.number() })), z.object({ path: z.string() })]),
    }),
  },
  LedgerTable: {
    description: "A compact table widget.",
    props: z.object({
      title: stringOrPath,
      rows: z.union([z.array(z.record(z.string())), z.object({ path: z.string() })]),
    }),
  },
  SourceCard: {
    description: "A sourced web-data card.",
    props: z.object({
      title: stringOrPath,
      subtitle: stringOrPath,
      sources: z.union([
        z.array(
          z.object({
            title: z.string(),
            url: z.string(),
            label: z.string(),
            snippet: z.string().optional(),
          }),
        ),
        z.object({ path: z.string() }),
      ]),
    }),
  },
};

/**
 * An odometer for a single value: when the string changes, the new one rises in
 * (with a whisper of blur) while the old one lifts out. As you scrub back through
 * time, the hero metric rolls between states instead of snapping — the change is
 * something you *watch happen*.
 */
function RollingValue({ value }: { value: string }) {
  const prev = useRef(value);
  const counter = useRef(0);
  const [leaving, setLeaving] = useState<{ text: string; key: number } | null>(null);

  useEffect(() => {
    if (prev.current === value) return;
    const previous = prev.current;
    prev.current = value;
    // Reduced motion: swap the value cleanly, no overlapping leave element.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setLeaving(null);
      return;
    }
    setLeaving({ text: previous, key: counter.current++ });
    const id = window.setTimeout(() => setLeaving(null), 480);
    return () => window.clearTimeout(id);
  }, [value]);

  return (
    <span className="roll">
      <span className="roll-in" key={value}>
        {value}
      </span>
      {leaving ? (
        <span className="roll-out" key={leaving.key} aria-hidden="true">
          {leaving.text}
        </span>
      ) : null}
    </span>
  );
}

const renderers = {
  SignalWidget: ({
    props,
    children,
  }: RendererProps<{ child: string; kind: string; variant: string }>) => (
    <article className={`signal-widget signal-widget--${props.variant}`} data-kind={props.kind}>
      {children(props.child) as ReactNode}
    </article>
  ),

  MetricCard: ({
    props,
  }: RendererProps<{ label: string; value: string; delta: string }>) => (
    <div className="metric-card">
      <p>{props.label}</p>
      <div>
        <strong>
          <RollingValue value={props.value} />
        </strong>
        <span>
          <RollingValue value={props.delta} />
        </span>
      </div>
    </div>
  ),

  TrendCard: ({
    props,
  }: RendererProps<{ title: string; subtitle: string; data: TrendDatum[] }>) => (
    <div className="trend-card">
      <div className="widget-copy">
        <h1>{props.title}</h1>
        <p>{props.subtitle}</p>
      </div>
      <MiniLineChart data={props.data} />
    </div>
  ),

  BarChart: ({
    props,
  }: RendererProps<{ title: string; subtitle: string; data: TrendDatum[] }>) => (
    <div className="trend-card chart-card">
      <div className="widget-copy">
        <h1>{props.title}</h1>
        <p>{props.subtitle}</p>
      </div>
      <BarChartView data={props.data} />
    </div>
  ),

  DonutChart: ({
    props,
  }: RendererProps<{ title: string; subtitle: string; segments: Array<{ label: string; value: number }> }>) => (
    <div className="trend-card chart-card">
      <div className="widget-copy">
        <h1>{props.title}</h1>
        <p>{props.subtitle}</p>
      </div>
      <DonutView segments={props.segments} />
    </div>
  ),

  LedgerTable: ({
    props,
  }: RendererProps<{ title: string; rows: TableRow[] }>) => (
    <div className="ledger-card">
      <h1>{props.title}</h1>
      <table>
        <tbody>
          {props.rows.map((row, index) => (
            <tr key={index}>
              {Object.entries(row).map(([key, value]) => (
                <td key={key} data-label={key}>
                  {value}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ),

  SourceCard: ({
    props,
  }: RendererProps<{ title: string; subtitle: string; sources: Source[] }>) => {
    const visibleSources = props.sources.slice(0, 3);
    return (
      <div className="source-card">
        <div className="widget-copy">
          <h1>{props.title}</h1>
          <p>{props.subtitle}</p>
        </div>
        <div className="source-list">
          {visibleSources.length ? (
            visibleSources.map((source) => (
              <a href={source.url} target="_blank" rel="noreferrer" key={source.url}>
                <span>
                  <strong>{cleanSourceText(source.title)}</strong>
                  {source.snippet ? <em>{trimSnippet(source.snippet)}</em> : null}
                </span>
                <small>{source.label}</small>
              </a>
            ))
          ) : (
            <div className="source-empty">No live citations</div>
          )}
        </div>
      </div>
    );
  },
};

export const signalCatalog = createCatalog(
  definitions,
  renderers as unknown as CatalogRenderers<typeof definitions>,
  { catalogId: CATALOG_ID, includeBasicCatalog: true },
);

function MiniLineChart({ data }: { data: TrendDatum[] }) {
  const width = 520;
  const height = 180;
  const padding = 18;
  const max = Math.max(...data.map((d) => d.value), 1);
  const min = Math.min(...data.map((d) => d.value), 0);
  const span = Math.max(max - min, 1);
  const coords = data.map((d, index) => {
    const x = padding + (index / Math.max(data.length - 1, 1)) * (width - padding * 2);
    const y = height - padding - ((d.value - min) / span) * (height - padding * 2);
    return { x, y };
  });
  const line = coords.map((p) => `${p.x},${p.y}`).join(" ");
  const first = coords[0] ?? { x: padding, y: height - padding };
  const last = coords[coords.length - 1] ?? { x: width - padding, y: height - padding };
  const area = `M ${first.x},${height - padding} ${coords.map((p) => `L ${p.x},${p.y}`).join(" ")} L ${last.x},${height - padding} Z`;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="mini-chart" role="img" aria-label="Trend">
      <defs>
        <linearGradient id="shine-trend-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--accent, #1677ff)" stopOpacity="0.24" />
          <stop offset="100%" stopColor="var(--accent, #1677ff)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`M ${padding} ${height - padding} H ${width - padding}`} />
      <path className="trend-area" d={area} fill="url(#shine-trend-grad)" />
      <polyline className="trend-line" points={line} pathLength={100} />
      {coords.map((p, index) => (
        <circle key={data[index].label} cx={p.x} cy={p.y} r={4} />
      ))}
    </svg>
  );
}

function BarChartView({ data }: { data: TrendDatum[] }) {
  const width = 520;
  const height = 200;
  const pad = 18;
  const gap = 12;
  const max = Math.max(...data.map((d) => d.value), 1);
  const n = Math.max(data.length, 1);
  const bw = (width - pad * 2 - gap * (n - 1)) / n;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="bar-chart" role="img" aria-label="Bar chart">
      <path className="bar-base" d={`M ${pad} ${height - pad} H ${width - pad}`} />
      {data.map((d, index) => {
        const barHeight = (d.value / max) * (height - pad * 2);
        const x = pad + index * (bw + gap);
        const y = height - pad - barHeight;
        return (
          <rect
            key={d.label}
            className="bar"
            x={x}
            y={y}
            width={bw}
            height={Math.max(barHeight, 1)}
            rx={6}
            style={{ animationDelay: `${index * 60}ms` }}
          />
        );
      })}
    </svg>
  );
}

function DonutView({ segments }: { segments: Array<{ label: string; value: number }> }) {
  const size = 200;
  const stroke = 32;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const cx = size / 2;
  const cy = size / 2;
  const total = segments.reduce((sum, seg) => sum + seg.value, 0) || 1;
  const colors = donutColors(segments.length);
  let offset = 0;
  return (
    <div className="donut-wrap">
      <svg viewBox={`0 0 ${size} ${size}`} className="donut-chart" role="img" aria-label="Donut chart">
        <circle cx={cx} cy={cy} r={radius} fill="none" stroke="#ececf0" strokeWidth={stroke} />
        {segments.map((seg, index) => {
          const dash = (seg.value / total) * circumference;
          const node = (
            <circle
              key={seg.label}
              className="donut-seg"
              cx={cx}
              cy={cy}
              r={radius}
              fill="none"
              stroke={colors[index]}
              strokeWidth={stroke}
              strokeDasharray={`${dash} ${circumference - dash}`}
              strokeDashoffset={-offset}
              transform={`rotate(-90 ${cx} ${cy})`}
              style={{ animationDelay: `${index * 110}ms` }}
            />
          );
          offset += dash;
          return node;
        })}
        <text x={cx} y={cy} className="donut-total" textAnchor="middle" dominantBaseline="central">
          {Math.round(((segments[0]?.value ?? 0) / total) * 100)}%
        </text>
      </svg>
      <div className="donut-legend">
        {segments.map((seg, index) => (
          <span key={seg.label}>
            <i style={{ background: colors[index] }} />
            {seg.label} {Math.round((seg.value / total) * 100)}%
          </span>
        ))}
      </div>
    </div>
  );
}

function donutColors(count: number) {
  const ramp = ["#1677ff", "#1db36b", "#f5a524", "#9b8afb", "#ff6b8a"];
  return Array.from({ length: count }, (_, index) => ramp[index % ramp.length]);
}

function trimSnippet(snippet: string) {
  const normalized = cleanSourceText(snippet);
  return normalized.length > 130 ? `${normalized.slice(0, 127)}...` : normalized;
}

function cleanSourceText(text: string) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCharCode(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number.parseInt(code, 10)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}
