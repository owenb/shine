# Shine — Charts & Rich Dashboard (coding-agent spec)

Goal: go from "one pretty widget per surface" to **chart-heavy, composed dashboards** — the thing that best shows off A2UI rendering. All pure SVG, **no new deps**. Apple/Stripe minimal, animated.

Touch points (a clean vertical slice):
- `apps/web/src/a2ui-catalog.tsx` — new component **definitions (zod) + renderers**.
- `packages/core/src/index.ts` — `composeSurface` (emit the new A2UI ops), `composeScene` (cloth/canvas nodes), `dataForIntent` (data), a new `dashboard` kind/intent.
- `apps/web/src/FabricSurface.tsx` — paint the new Scene node types (⚠️ **I'll take this part** so the cloth lens doesn't go blank — coding agent can stub it).

---

## P1 — the charts (do these first, this is the "charts and cool shit")

### 1. `BarChart`
- **props:** `title: stringOrPath`, `data: [{label, value}] | {path}`.
- **renderer:** vertical bars, rounded tops, accent fill, value labels above; **grow-in animation** (scaleY from 0, staggered 40ms). Baseline rule in `--line`.

### 2. `DonutChart`
- **props:** `title`, `segments: [{label, value}] | {path}`.
- **renderer:** SVG donut (stroke-dasharray arcs), **big total in the center**, legend chips below; **draw-on animation** (animate `stroke-dashoffset`). Use a tasteful 3–4 color ramp derived from `--accent`.

### 3. `GradientTrend` (upgrade the existing TrendCard look)
- Add a **gradient area fill** under the line (`<linearGradient>` accent→transparent) + **draw-on stroke** (`stroke-dasharray` reveal) + a soft glow on the last point. This alone makes the existing revenue/pipeline panels look 5× cooler.

### Compose path
- Add intent **`dashboard`** (and keep `revenue`/`pipeline` emitting `GradientTrend`).
- `dataForIntent` returns `bars` (segment→value), `split` (for donut, e.g. revenue mix), plus the existing `trend`/`rows`/`stat`.
- Trigger prompts: **"Build me a full revenue dashboard"**, "show me the whole picture", "executive dashboard".

---

## P2 — the composed dashboard (the real A2UI flex)

One surface that **nests multiple widgets** via `SignalWidget` children:

```
SignalWidget(root, kind="dashboard")
 ├─ Heading            (title + subtitle)
 ├─ StatRow            (3 × StatCard, each with a sparkline + delta chip)
 ├─ BarChart  OR  DonutChart
 ├─ LedgerTable        (compact)
 └─ Callout            (tone-colored status line)
```

**Required change:** `SignalWidget` currently renders a single `props.child`. Give it **`children: string[]`** and have the renderer map `children(id)` over the array (and `composeSurface` emit a `children` list on root for the dashboard kind). Keep single-`child` working for the simple kinds.

New small components for the dashboard:
- **`StatRow`** — `stats: [{label, value, delta, spark: number[]}]`; renders a row of stat cards each with a tiny inline **sparkline**.
- **`Badge`** — `label`, `tone`; pill chip.
- **`Callout`** — `text`, `tone`; left-accent-bar highlighted note.

---

## P3 — "cool shit" polish (cheap, high wow)

- **Count-up numbers** on StatCards/Donut center (animate 0→value over ~600ms).
- **Staggered entrance** (each child fades/springs in 60ms apart).
- **Gradient + soft glow** on chart accents (drop-shadow on the line/bars in the accent color).
- Respect **`prefers-reduced-motion`** (skip the draw-on/count-up, render final state) — matches the DOM lens's existing reduced-motion behavior.

---

## Cloth-lens parity (⚠️ my lane — Fabric)
`composeScene` must emit node types for the new charts (`bar`, `donut`, and a richer `chart`/area variant) so `FabricSurface.drawNode` can paint them onto the canvas texture. **I'll add the Scene node types + the canvas painters** so the dashboard renders as cloth too (a whole dashboard wobbling on fabric is the screenshot of the demo). Coding agent: just emit the Scene nodes from `composeScene`; leave the canvas drawing to me (or stub with a TODO).

---

## Acceptance
- "Build me a full revenue dashboard" → one surface with a heading, 3 animated stat cards, a bar **or** donut chart, a table, and a callout — all real A2UI components through `@copilotkit/a2ui-renderer`.
- The same dashboard renders (legibly) through the **cloth** and **voice** lenses.
- Charts animate in; reduced-motion users get the final state instantly.

**Priority:** P1 first (you'll *see charts* within the first component), then P2 (the composed dashboard = the A2UI money-shot), then P3 polish.
