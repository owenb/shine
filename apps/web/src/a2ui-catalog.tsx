import type { ReactNode } from "react";
import { z } from "zod";
import { createCatalog, type CatalogRenderers, type RendererProps } from "@copilotkit/a2ui-renderer";
import { CATALOG_ID, type Source, type TableRow, type TrendDatum } from "@sig/core";

const childRef = z.string();
const stringOrPath = z.union([z.string(), z.object({ path: z.string() })]);

export const definitions = {
  SignalWidget: {
    description: "Minimal outer frame for one generated Signal UI widget.",
    props: z.object({
      child: childRef,
      kind: z.enum(["metric", "trend", "table", "sources"]),
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
        <strong>{props.value}</strong>
        <span>{props.delta}</span>
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
  { catalogId: CATALOG_ID, includeBasicCatalog: false },
);

function MiniLineChart({ data }: { data: TrendDatum[] }) {
  const width = 520;
  const height = 180;
  const padding = 18;
  const max = Math.max(...data.map((d) => d.value), 1);
  const min = Math.min(...data.map((d) => d.value), 0);
  const span = Math.max(max - min, 1);
  const points = data
    .map((d, index) => {
      const x = padding + (index / Math.max(data.length - 1, 1)) * (width - padding * 2);
      const y = height - padding - ((d.value - min) / span) * (height - padding * 2);
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="mini-chart" role="img" aria-label="Trend">
      <path d={`M ${padding} ${height - padding} H ${width - padding}`} />
      <polyline points={points} />
      {data.map((d, index) => {
        const x = padding + (index / Math.max(data.length - 1, 1)) * (width - padding * 2);
        const y = height - padding - ((d.value - min) / span) * (height - padding * 2);
        return <circle key={d.label} cx={x} cy={y} r={4} />;
      })}
    </svg>
  );
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
