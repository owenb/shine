# Signal UI — Full Implementation Plan

> **Status:** living build doc · v1 · 2026-06-13 (hackathon day)
> **Track:** London A2A & A2UI Hackathon — Generative UI track
> **Thesis:** One constant data layer. Infinitely many personalized surfaces. **SaaS 2.0.**
> **Priority #1:** emotional/visual WOW. A beautiful, stunning UI beats everything.

---

## 0. The one-line pitch (what the judges should remember)

> The data never changes. Everything on top is yours — your dashboard, your theme, your
> layout, your components, even your own rendering engine — all derived per user from one
> immutable fact log you can rewind to any moment in history.

Same truth → different *world* → different UI. Drag a slider, watch any user's app rebuild
itself at any point in its life. Agents that **learn** you (Redis Agent Memory), **ground**
themselves in live web data (LinkUp), and **collaborate** to build your surface.

---

## 1. What we're judged on, and exactly how we hit it

| Judged / required | How it shows up in the build | On-camera moment |
|---|---|---|
| **CopilotKit** (required) | V2 runtime on Hono + `@copilotkit/react-core/v2` chat + `@copilotkit/a2ui-renderer` | The chat that builds the UI; the renderer painting surfaces |
| **AG-UI** (required) | Transport between the in-process `BuiltInAgent` and the runtime | Streaming agent turns; the Flight-Recorder event log |
| **A2UI v0.9** (required + judged) | Canonical render plan; **Signal compiles down to A2UI** | "It's not pixels — it's A2UI" inspector pill |
| **Generative UI creativity** (judged) | Signal → Loom layout → A2UI → Pretext → multi-renderer | Two users, same prompt, different beautiful UIs |
| **Redis** (sponsor) | Agent Memory + Context Retriever + LangCache effect-cache + live bus | "It learned I prefer tables" → instant re-render; "never pay twice" |
| **LinkUp** (sponsor) | Live, cited web data → typed A2UI panels (journaled effect) | Ask anything → a sourced, branded panel materializes |
| **Gemini** (model) | `gemini-3.1-flash-lite` (Signal) + `gemini-3.5-flash` (dynamic UI) | Fast, cheap intent → rich surface |
| **Technical difficulty / originality** (judged) | Immutable EAV store, time-travel, renderer abstraction, per-user code | The whole thing |

We **reach parity** with the official starter (chat-builds-a-dashboard) and then go far past it.
We **reference** the starter (cloned at `starter/`) but build our own in Vite + Hono.

---

## 2. First principles (the laws we never break)

1. **Facts are truth. Everything else is derived.** Never update/delete — append facts.
   Current state is a fold over facts ≤ a transaction number.
2. **Separate data from presentation — always.** Data (facts) → semantics (A2UI) →
   measured presentation (Pretext/Scene) → pixels (a renderer). Each boundary is clean,
   so we can swap rendering engines without touching anything above.
3. **Renderers are equals, not add-ons.** DOM, Fabric (cloth), Voice — every renderer is a
   peer that consumes the same `Scene`. The DOM renderer has no special status.
4. **Everything is per-user.** A user is a *world*. Personalization (theme, layout,
   components, even renderer choice and custom code) is just facts in that world.
5. **Build for the camera.** The deliverable is a demo video + repo. Optimize for the beats
   that land on screen; harden after.

---

## 3. Architecture — the layered pipeline

```
                          ┌─────────────────────────── AGENT LAYER ───────────────────────────┐
                          │  CopilotKit React (v2 chat)  ⇄  AG-UI  ⇄  BuiltInAgent (Gemini)    │
                          │  Curator agent (learns) ──writes──▶ Redis Agent Memory ◀──reads── Builder agent (composes) │
                          └───────────────────────────────────────────────────────────────────┘
                                                  │ emits
                                                  ▼
  INTENT      Signal            compact business-intent commands  (gemini-3.1-flash-lite)
                                                  │ compile (reads world facts + Agent Memory)
  COMPOSE     Loom              choose widgets + decide layout
                                                  │
  SEMANTIC    A2UI v0.9         canonical render plan (createSurface/updateComponents/updateDataModel)
                                                  │ measure
  PRESENT     Pretext  ──────▶  Scene             measured boxes + text runs + hotspots (renderer-agnostic)
                                                  │ render (pick per user)
  PIXELS      ┌── DOM renderer ──┐ ┌── Fabric (cloth) renderer ──┐ ┌── Voice lens ──┐   ← all EQUAL
              └──────────────────┘ └─────────────────────────────┘ └────────────────┘

  TRUTH       SQLite event store   txs · datoms(EAV) · receipts(=Flight Recorder) · effects · blobs · worlds
  SPEED/MIND  Redis                Agent Memory · Context Retriever · LangCache(effect cache) · Streams(live bus)
  GROUNDING   LinkUp               sourced/structured web data → journaled effect → typed A2UI
  LIVE        SSE bus              every accepted commit → all tabs + the time-travel slider
```

**The unification that makes this tractable:** a **Signal packet is a command** through the
store's one gate. The gate's `apply()` *is* Loom (it compiles Signal → A2UI facts). The
**receipt** *is* the Flight Recorder. **Worlds** *are* users. **Time-travel** *is* the
personalization-learning demo. We are not building two systems — we're building one
log-structured engine whose domain happens to be UI.

---

## 4. Confirmed stack (versions pinned from research — 2026-06-13)

> Pin these exact versions. Do not chase `-latest`. Target **Node 22+** (LinkUp SDK needs ≥22; node-redis v6 needs ≥20).

| Concern | Package(s) | Version | Notes / gotcha |
|---|---|---|---|
| Monorepo | `pnpm` workspaces + `tsx` + `concurrently` | — | **No Turborepo**, no build step. Two ports + Vite proxy. |
| Web | `vite`, `@vitejs/plugin-react`, `vite-tsconfig-paths` | 8.0.16 / 6.0.2 / latest | Proxy `/api`,`/agent` → Hono; **no CORS**. |
| Server | `hono`, `@hono/node-server` | 4.12.25 / 2.0.4 | `serve` still the export in v2. |
| Lang/tooling | `typescript`, `tsx`, `concurrently`, `dotenv` | 6.0.3 / 4.22.4 / 10.0.3 / 17.4.2 | tsx honors tsconfig `paths`. |
| Validation | `zod` | **^3.25** | **CRITICAL: must match `@copilotkit/a2ui-renderer`. Do NOT use zod v4** — mismatch silently classifies A2UI props as STATIC and `{path}` leaks through. |
| Truth store | `better-sqlite3` | latest | Native build. Fallback: Node 22 `node:sqlite` `DatabaseSync` (same sync shape). |
| CopilotKit | `@copilotkit/react-core`, `@copilotkit/runtime`, `@copilotkit/a2ui-renderer` | **1.57.4** | **Use the `/v2` entrypoints.** Client imports from `@copilotkit/react-core/v2` (NOT `react-ui`). CSS `@copilotkit/react-core/v2/styles.css`. |
| AG-UI | `@ag-ui/client`, `@ag-ui/core` | ^0.0.53 | `HttpAgent` for external agents; we mostly use `BuiltInAgent`. |
| Agent model | `@google/genai`; `@ai-sdk/google` + `ai` | 2.8.0 / latest | `BuiltInAgent({type:'aisdk', factory})` for in-process Gemini. |
| Models | `gemini-3.1-flash-lite` (Lite), `gemini-3.5-flash` (full), `gemini-2.5-flash-tts` (TTS) | — | Free key: aistudio.google.com/apikey → `GEMINI_API_KEY`. **Pin dated IDs, never `-latest`.** |
| React | `react`, `react-dom` | ^19.2.4 | Match CopilotKit's peer (19.2.4). |
| Web search | `linkup-sdk` (or REST fallback) | 3.2.5 | Node ≥22 for SDK. `sourcedAnswer` → `{answer,sources[]}`; `structured` → typed JSON. Free ~4k queries. |
| Redis client | `redis` (node-redis) | 6.0.0 | Node ≥20, explicit `await client.connect()`. Fallback `ioredis` 5.11.1. |
| Redis Iris | `agent-memory-client` | 0.3.1 | Agent Memory + Context Retriever (PREVIEW on Redis Cloud REST). |
| Cloth | `three`, `@types/three`, `modern-screenshot` | 0.184.0 / 0.184.1 / 4.7.0 | **Raw three.js, not R3F.** `modern-screenshot` only as fallback (we paint Scene→canvas instead). |

**Infra:** local `docker run -d -p 6379:6379 redis:8` for ZSET/Streams/pub-sub; **Redis Cloud free tier** for the Iris Agent Memory / Context Retriever / LangCache preview services. (Can run everything on Redis Cloud to simplify.)

---

## 5. Monorepo layout

```
signal-ui/
  pnpm-workspace.yaml          # packages: ["apps/*","packages/*"]
  .env                         # GEMINI_API_KEY, LINKUP_API_KEY, REDIS_URL, REDIS_CLOUD_URL (gitignored)
  tsconfig.base.json           # paths: @sig/* -> packages/*/src
  apps/
    web/                       # Vite React SPA (chat + canvas + timeline)
    server/                    # Hono: CopilotKit v2 runtime + /api/command + /api/events(SSE) + /api/search
  packages/
    signal/                    # Signal packet types + zod schemas (the wire protocol)
    loom/                      # Signal -> A2UI compiler (runs inside the gate's apply())
    gate/                      # zod + product validation helpers (the brief's Gate)
    db/                        # the SQLite event store (from the EAV doc) — store/blobs/effects/bus
    memory/                    # Redis: Agent Memory, Context Retriever, LangCache, bus adapter
    a2ui/                      # A2UI catalog (definitions + zod schemas + renderers) — our 21-ish components
    pretext/                   # measure A2UI -> Scene (boxes, text runs, hotspots); the reactive layer
    render-core/               # Renderer interface + Scene types (shared by all renderers)
    render-dom/                # DOM renderer (a2ui-renderer + Scene->DOM)
    render-fabric/             # cloth renderer (three.js, paints Scene->canvas texture)
    render-voice/              # voice lens (Scene/A2UI -> brief -> TTS -> Web Audio)
    theme/                     # design tokens + per-user palette system
```

**Type sharing (no build step):** `tsconfig.base.json` `paths` (`@sig/* → packages/*/src`)
+ `vite-tsconfig-paths` on the web side + `tsx watch` (honors paths) on the server side.
This is the "running in 15 minutes" path. (Upgrade to custom export-conditions only if needed.)

**Dev:** `concurrently "vite" "tsx watch apps/server/index.ts"`. Vite (`:5173`) proxies
`/api`,`/agent`,`/events` → Hono (`:8787`). Secrets live server-side; browser → Hono → keys.

---

## 6. Truth layer — the SQLite event store (adopt the EAV doc as-is)

Use the `db/` package straight from your event-sourcing doc. Tables: `txs`, `datoms` (EAV
append-only), `current_values` (rebuildable projection), `receipts`, `effects`, `blobs`,
`worlds`. The command gate is the single synchronous, atomic write doorway; every attempt
(accepted or rejected) yields a durable receipt.

**Mapping our domain onto it:**
- **Command** = a Signal submission (e.g. `renderPanel`, `setPreference`, `forkWorld`).
- **`apply()`** = Loom: read the user's world facts (+ Agent Memory), return A2UI as datoms.
- **`receipt`** = the Flight Recorder entry (accepted/rejected, code/field/message).
- **`world`** = a user (or a fork/candidate UI).
- **`effects`** = journaled Gemini + LinkUp calls (replay + cache → see §7).
- **`blobs`** = stored A2UI docs, uploaded images, and **per-user component code** (§10).
- **SSE bus** = publish after commit → live multiplayer + time-travel slider feed.

The only addition: a tiny in-memory **TimeMachine** for buttery scrubbing (§11).

---

## 7. Memory layer — Redis as the brain (learn / remember / collaborate)

Four roles; three of them are genuinely "learn/remember/collaborate" (the rest is speed).
These do **not** overlap with the fact log — each answers a different question:

| Layer | Question | Tech |
|---|---|---|
| SQLite fact log | *What is this user's UI, at any tx?* (truth, time-travel) | better-sqlite3 |
| **Redis Agent Memory** | *What has the agent learned about this user?* (prefers tables, dark, terse; cross-session) | `agent-memory-client` |
| **Redis Context Retriever** | *What knowledge grounds this answer?* (LinkUp results, docs, past panels) | Iris retriever |
| **Redis LangCache** | *speed* — semantic cache for Gemini/LinkUp effects ("never pay twice") | Iris LangCache |
| Redis Streams / pub-sub | *speed* — live bus across tabs/instances | node-redis |

**The agent flow that makes personalization feel intelligent:** Builder agent **reads**
Agent Memory + retrieves context → emits Signal → gate compiles to A2UI facts → render.
When you say *"I prefer tables,"* the Curator agent **writes** Agent Memory (learns) and the
UI change becomes a time-travelable fact.

**Collaboration (Redis's "not three bots in parallel"):**
- **Curator** watches the conversation, distills durable preferences, writes Agent Memory.
- **Builder** reads that memory + retrieved context, composes the Signal.
- They collaborate *through shared Redis memory*; the Flight Recorder shows
  "Curator learned X → Builder used X to build panel Y." Demo-deep = two roles/nodes, not a full A2A mesh.

> Effect cache = your EAV doc's effect journal, with Redis LangCache as the semantic
> front: scrub the timeline, the LLM/LinkUp answer reappears instantly, `reused:true`.

---

## 8. Intent → UI pipeline (Signal → Loom → A2UI → Pretext → Scene)

**Signal** (the wire protocol, from the brief): compact packets the agent emits — `panel`,
`source`, `metric`, `table`, `chart`, `approval`, `note`, etc. Gemini emits them via
**structured output** (`@google/genai`, `config.responseMimeType:'application/json'` +
`config.responseSchema` = JSON-Schema of `SignalPacket[]`), or **forced function-calling**
(`toolConfig.functionCallingConfig.mode: ANY`) for interactive turns. `gemini-3.1-flash-lite`
for cheap high-volume Signal; `gemini-3.5-flash` for the harder dynamic-component invention.

**Loom** (`packages/loom`): the gate `apply()` that compiles Signal → A2UI. **This is where
personalization happens** — it reads the user's world facts (theme, density, preferred widget
types, component overrides) *and* Agent Memory to decide layout and component choices. Same
Signal + different world → different A2UI.

**A2UI v0.9** (canonical): `createSurface` / `updateComponents` / `updateDataModel`. Rendered
by `@copilotkit/a2ui-renderer` (we do not hand-roll the primitive renderers). Stored as facts
so it's persistent, forkable, and time-travelable.

**Pretext → Scene** (`packages/pretext`): the reactive presentation layer. Measures A2UI +
the user's theme into a **`Scene`** — a flat, renderer-agnostic list of positioned boxes,
measured text runs (x/y/font/weight/tone), and interactive **hotspots** (rect + actionId).
Because data is separate from presentation, when a fact changes the Scene recomputes and
every renderer redraws — **reactive by default.** And the Scene's measured hotspot rects are
exactly what the cloth renderer needs for click-mapping (§9) — so Pretext de-risks Fabric for free.

---

## 9. Renderers as equals (the modular rendering system)

```ts
// packages/render-core
export interface Renderer {
  mount(container: HTMLElement, scene: Scene, opts: { onAction: (actionId: string, args?: any) => void }): void;
  update(scene: Scene): void;     // reactive: re-measure happened upstream; diff + redraw
  unmount(): void;
}
```

- **DOM renderer** (`render-dom`): the fast/parity path. Renders A2UI via
  `@copilotkit/a2ui-renderer`, positioned by the Scene. Gorgeous default; brand-themed.
- **Fabric (cloth) renderer** (`render-fabric`): **paints the Scene straight to a 2D canvas**
  (boxes + text + cards, like the brief's `drawFrameToCanvas`), uses it as a `THREE.CanvasTexture`
  on a subdivided `PlaneGeometry`, runs the brief's Verlet cloth sim (raw three.js 0.184,
  per-frame `position` mutation + `computeVertexNormals()`), and maps clicks via
  raycast → `intersection.uv` → Scene hotspot rect → action. Set `material.side = DoubleSide`.
  **Painting from the Scene eliminates the canvas-taint risk entirely** (no cross-origin DOM
  capture) and gives hotspots for free. `modern-screenshot` 4.7 kept only as a fallback.
  Plus the **fabric transition trick** (scrunch → hold → refresh → unfold) on data change.
- **Voice lens** (`render-voice`): projects the Scene/A2UI into a ranked **voice brief**, then
  `gemini-2.5-flash-tts` (`responseModalities:['AUDIO']` + `speechConfig`) → Web Audio scheduler
  (PCM chunks with overlap/fade, from the brief). Push-to-talk via Gemini Live API = stretch.

**Per-user renderer choice is a world fact** (`renderer: "dom" | "fabric" | …`) — so two users
can literally perceive the *same data* through *different engines*. That's the renderer
abstraction paying off as a personalization feature.

---

## 10. Personalization & the per-user model (SaaS 2.0)

A user = a **world** that overlays a shared base template world (so onboarding = an O(1) fork).
Personalization is just facts in that world:

| Fact | Effect |
|---|---|
| `theme.*` tokens (palette, radius, density) | colors/styles |
| `layout.*` (density, ordering, pinned tiles) | where widgets go (Loom reads these) |
| `catalog.overrides` | which component variant renders |
| `renderer` | DOM vs Fabric vs Voice |
| `component.code` → blob hash + `world.code_pin` | **custom component code, per user** (stretch) |

**Custom components (the stretch hero):** store a user's component renderer as a
content-addressed **code blob**; pin their world to it (`worlds.code_pin`). Load via
`import("data:text/javascript;base64,…")`, keyed by hash. Old worlds keep old code → replay
old *state* against old *code*. "Every user can have their own customized components."

**The two-user reveal:** open two windows (two worlds). Same agent prompt → Loom reads each
world's facts → different A2UI → different Scene → different render. Visibly different apps,
same data underneath.

---

## 11. The time machine (buttery-smooth time-travel + infinite undo)

Naïve folding (re-query all datoms ≤ tx) is O(facts) — fine for correctness, **not** buttery.
For 60fps scrubbing:

- Keep an in-memory **materialized entity map** per world plus each tx's **datom delta**
  (we already store per-tx datoms; `txDetail(tx)` returns them).
- **Scrubbing = stepping the map by per-tx deltas**, not re-folding from zero. Dragging from
  tx N→N-1 reverses tx N's datoms only — O(datoms-in-that-tx), tiny. Instant either direction.
- **Scene recompute is incremental** (only changed entities re-measure). For demo scale we can
  even recompute the whole Scene per step (still cheap).
- **Smooth morph:** animate position/opacity deltas between consecutive Scenes (spring tween);
  on the cloth renderer, the scrunch/unfold transition covers state swaps.

**Infinite undo for all:** scrubbing is a *non-destructive preview*. "Restore to here" either
appends inverse facts (bringing head back to that state) or forks a new world from that tx —
nothing is ever lost, because the whole history always exists. The slider is `?atTx=N`.

API: `/api/timeline?world=`, `/api/state?world=&atTx=`, `/api/tx/:tx`. Client `TimeMachine`
drives the slider + the live "● Live" follow toggle (snaps to head; SSE advances head).

---

## 12. Agent layer — CopilotKit + AG-UI + Gemini (in-process, all-TS)

**Runtime (Hono, native):**
```ts
// apps/server/index.ts (sketch)
import { serve } from '@hono/node-server';
import { CopilotRuntime, createCopilotEndpoint, InMemoryAgentRunner, BuiltInAgent } from '@copilotkit/runtime/v2';
import { google } from '@ai-sdk/google';
import { streamText, convertMessagesToVercelAISDKMessages } from 'ai';

const builder = new BuiltInAgent({
  type: 'aisdk',
  factory: ({ input, abortSignal }) => streamText({
    model: google('gemini-3.5-flash'),          // full tier for dynamic UI; Lite for cheap Signal turns
    messages: convertMessagesToVercelAISDKMessages(input.messages),
    tools: { /* emitSignal -> POST /api/command (the gate) */ },
    abortSignal,
  }),
});

const runtime = new CopilotRuntime({
  agents: { default: builder, builder },
  runner: new InMemoryAgentRunner(),
  a2ui: { injectA2UITool: false },              // we emit A2UI from the gate, not via the frontend tool
});
const app = createCopilotEndpoint({ runtime, basePath: '/api/copilotkit' });
serve({ fetch: app.fetch, port: 8787 });        // ← the one swap vs the starter's hono/vercel handle()
```

**Client (Vite):** `<CopilotKit runtimeUrl="/api/copilotkit" …>` from `@copilotkit/react-core/v2`.
A2UI comes back as activity messages; a mirror renderer drops an inspector pill in chat.

**Two streams, separated:** CopilotKit's AG-UI stream = chat + agent turns. Our SSE bus
(`/api/events`) = fact changes for time-travel + multiplayer. The canvas renders A2UI **from
the fact store** (so time-travel/personalization work); CopilotKit owns the conversation.

**The agent's job:** read Agent Memory + retrieve context → emit Signal → call the gate
(`/api/command`) → facts written → SSE publishes → all surfaces update. Curator/Builder split
per §7.

---

## 13. LinkUp — "something impressive" (recommended use)

LinkUp is a **journaled effect** (so it's cached + replayable). Best combo:
- **Structured fetch → typed A2UI, no LLM glue:** `outputType:'structured'` +
  `structuredOutputSchema` returns JSON in *our* shape → pipe straight into a typed A2UI panel.
  e.g. "build me a live competitor snapshot for Stripe" → `{price, change, headline, rivals[]}`
  → metrics + table, instantly.
- **Sourced answer → cited card:** `outputType:'sourcedAnswer'` → `{answer, sources[]}` with
  favicon/title/snippet/url → a beautiful cited "why" card beside the data.
- **Personalized + grounded:** the *same* LinkUp result renders differently per user (their
  theme/layout/renderer) — grounding × personalization in one shot. Use `depth:'fast'` for live demo responsiveness.

The on-camera beat: *type a real-world question → a sourced, branded, personalized panel
builds itself → scrub back in time → it's cached, instant, `reused:true` (Redis).*

---

## 14. Visual & motion design — the EMOTIONAL WOW (priority #1)

This is where we win. Invest here continuously, not at the end.

- **A stunning default theme system** (`packages/theme`): tasteful palettes, soft depth,
  crisp measured typography (Pretext gives us pixel-perfect type), generous spacing,
  motion-forward. Per-user palettes that feel *designed*, not random.
- **Motion language:** spring-based enter/move/exit; state-morph tweens between time-travel
  frames; the fabric scrunch/unfold on data change; subtle ambient motion so the canvas feels alive.
- **The reveal choreography** (the demo's spine): the two-user diverge, the "it learned me"
  re-theme, the time-travel rewind, the cloth flip, the voice narration — each a deliberate,
  rehearsed beat with motion that sells the emotion.
- **The cloth** is the showstopper visual; the **time-travel scrub** is the "whoa, it's all
  real" visual; the **two-user diverge** is the "this is new" visual.

---

## 15. Build order (sequenced; everything in scope)

Ordered so **a demoable artifact exists at every checkpoint** — whatever time we have, we're
always shippable. Estimates are honest (cloth is the big rock); the order is the point.

1. **Scaffold** (~0.75h) — pnpm workspaces, Vite+Hono, proxy, `.env`, deps pinned per §4.
2. **Truth store** (~1h) — drop in the EAV `db/` package; prove a command writes facts + a receipt.
3. **Signal → Loom → A2UI → DOM render** (~2h) — hardcoded Signal first, then real. **★ SPINE GATE:
   a panel renders from facts via `@copilotkit/a2ui-renderer`. Everything else layers on this.**
4. **CopilotKit chat + BuiltInAgent (Gemini)** (~2h) — agent emits Signal → gate. Parity reached.
5. **Worlds + Pretext/Scene + time-travel slider** (~1.5h) — two-user diverge + buttery scrub.
6. **Redis** (~1.5h) — Agent Memory (learn prefs) + Context Retriever + LangCache effect-cache; SSE→Streams.
7. **LinkUp** (~0.75h) — structured + sourcedAnswer panels as journaled effects.
8. **Fabric (cloth) renderer** (~3–5.5h) — paint Scene→texture, Verlet cloth, raycast→hotspot, transitions.
9. **Voice lens** (~1h) — narration via TTS + Web Audio (push-to-talk = stretch).
10. **Custom components** (~1–2h, stretch) — code blobs + per-world code-pins.
11. **Polish + record the demo video** — the choreography in §16; social post; public repo README.

> Dependencies: 3 unblocks everything; 5 needs 2+3; 8 needs 3+5 (Scene+hotspots); 9 needs 3.
> If the clock gets real, the natural checkpoints are after 4 (parity), 5 (the hero), and 7
> (sponsors in). 8–10 are pure upside captured on camera.

---

## 16. The demo script (the beats judges watch)

1. **Open** — a beautiful console builds itself from a chat prompt. ("Not pixels — A2UI.")
2. **Diverge** — second window, second user, *same prompt*, a visibly different beautiful UI.
3. **Learn** — "I prefer tables and a calmer palette." The UI re-composes; the Flight Recorder
   shows the Curator writing Agent Memory, the Builder using it. (Redis.)
4. **Ground** — ask a real-world question → a sourced, cited, on-brand panel materializes. (LinkUp.)
5. **Rewind** — drag the slider; the whole app smoothly rebuilds itself at any past moment.
   Cached effects reappear instantly. (Time-travel + Redis "never pay twice.")
6. **Cloth** — flip the renderer; the same panel becomes a living cloth surface you can grab and
   click. (Renderer-as-equal.)
7. **Voice** — it narrates the panel. (Voice lens.)
8. **Custom** — one user has their *own* component code the others don't. (Per-user code.)
9. **Close** — "One data layer. Every user, their own everything. **SaaS 2.0.**"

---

## 17. Risks & how we de-risk

| Risk | Mitigation |
|---|---|
| **Cloth is the big rock (~5.5h, taint)** | Paint **Scene → canvas** (no DOM capture) → taint impossible; hotspots free. `modern-screenshot` fallback only. Build it *after* the spine; it's pure upside. |
| **zod major mismatch breaks A2UI binding** | Pin **zod ^3.25** repo-wide to match `@copilotkit/a2ui-renderer`. |
| `better-sqlite3` native build fails | Fall back to Node 22 `node:sqlite` (`DatabaseSync`) — same sync API. |
| Redis Iris previews require Cloud | Use Redis Cloud free tier for Agent Memory/Retriever/LangCache; local Docker for ZSET/Streams. Can run all on Cloud. |
| A2UI middleware vs `BuiltInAgent` tool results | Primary render path is **from our facts** (not the middleware), so this can't block us. Verify the middleware path early as a bonus; HttpAgent+separate-agent is the proven fallback. |
| Two research probes didn't finish | **Re-verify early:** (a) exact A2UI envelope JSON + driving `a2ui-renderer` with a static doc; (b) AG-UI event/SSE specifics. We have strong signal from the starter code already. |
| Over-scope vs the clock | The §15 checkpoints guarantee a shippable demo at 4, 5, 7. |

---

## 18. Open items to confirm

- **Product name** (Signal UI / LoomKit / FramePilot / Copilot Canvas / Agent Panels / new).
- **Re-run the 2 unfinished probes** (A2UI renderer-with-static-doc; AG-UI SSE) before building §3/§12 in earnest.
- **Redis: Cloud-only vs Cloud+local Docker** split for the demo.
- **Curator/Builder**: confirmed two-role collaboration (locked unless you say otherwise).
