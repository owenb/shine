# Shine — Coding Agent Tasks (review handoff)

Reviewer notes + next tasks, prioritized. Context: monorepo at repo root (`apps/server`, `apps/web`, `packages/core`). The agent is mid-build on **drag-and-drop widget layout** — that work is good (see §3); don't rebuild it, just refine.

**Already landed and verified (don't redo):** CopilotKit v2 driven end-to-end via `useAgent`/`runAgent`; A2UI real via `@copilotkit/a2ui-renderer`; Gemini live (Vertex Express key + `vertexai:true` is correct — **do not flip it to false**); time-travel scrubber (drag + client cache); **Flight Recorder panel**; LinkUp broadened (`research` intent + `shouldGroundPrompt`, world-scoped cache); effects table has `world`/`tx`/`reused_tx`; widget layout persisted as an append-only fact.

---

## 1. ⭐ Redis: make agents genuinely *learn, remember, and collaborate* (headline)

**Why:** the briefing rewards "agents that actually learn, remember, and **collaborate** — not three bots in parallel." Today `applyAgentCommand` is one function that does everything and writes a single `"Curator learned X; Builder re-rendered"` receipt string. Memory (learn/remember) is real; **collaboration is cosmetic.** Make it real *and visible*, reusing the Flight Recorder we already render.

**Principle:** *memory is the shared workspace; each agent reads what another wrote.* The dependency (sequential, not parallel) is the collaboration.

**Do this — split `applyAgentCommand` into three role-tagged steps** ([apps/server/src/index.ts](apps/server/src/index.ts) ~`applyAgentCommand`/`applySignalCommand`). Each step emits **its own receipt + AG-UI `CUSTOM` event + Redis stream entry**, in order, against the same world:

1. **Curator — `curatorLearn(world, prompt, memory)`**
   - Detect durable preferences (presentation/tone/renderer/component) — the `setPreference` logic that's currently inline.
   - **Writes** them to Redis Agent Memory (`createLongTermMemory`) **and** to pref facts.
   - Emits receipt `CURATOR_LEARNED` ("Curator learned presentation=table"), event `signal.curator.learned`, stream `curator`.
   - Returns the learned prefs.
2. **Researcher — `researcherGround(world, prompt)`** (only when `shouldGroundPrompt`)
   - Calls LinkUp; **writes** grounded data + citations into the world (fact) / working memory.
   - Emits receipt `RESEARCHER_GROUNDED`, event `signal.researcher.grounded`, stream `researcher`.
   - Returns grounding.
3. **Builder — `builderCompose(world, signal, prefs, grounding)`**
   - **Reads** the Curator's prefs + the Researcher's grounding (from memory/world it just wrote) → `composeSurface` → A2UI.
   - Emits receipt `BUILDER_RENDERED`, event `signal.builder.rendered`, stream `builder`.

Add a `role: "curator" | "researcher" | "builder"` field to receipts (and effects) so the Flight Recorder can tag the handoff. **Acceptance:** a grounded turn shows three role-tagged receipts in order in the Flight Recorder, with a memory write visibly between Curator and Builder; the three AG-UI custom events fire. Narrate truthfully as "Redis-backed memory; each agent builds on what the last one wrote."

**Stretch (only if there's spare time) — cross-world "team memory":** a shared `team:memory` namespace (or Iris memory at a team scope) both Builders consult. World A learns a preference; World B's Builder proactively offers it ("learned from the team") via a `BUILDER_SUGGESTED_FROM_TEAM` receipt. This is the most "not-three-bots-in-parallel" beat and is pure on-thesis (one data layer, shared learning).

> Keep it honest: `agent-memory-client` is the real Redis Agent Memory client — narrate exactly that. Don't claim more than the observable handoff.

---

## 2. Robustness & correctness fixes

1. **Heuristic fallback (live-demo blocker).** `resolveSignal` `catch` currently `throw`s ([index.ts:958](apps/server/src/index.ts)), so any transient Gemini error → red "Agent failed" banner, no surface. Fall back to `signalFromPrompt(prompt)` with `provider:"heuristic"` instead of rethrowing, and surface a `heuristic` badge/receipt so it stays **honest** (it degrades, it doesn't lie). One Gemini hiccup must never blank the demo.
2. **Effects `reused` preservation.** Verify `cacheEffect`'s upsert doesn't clobber a previously-set `reused=1` (use `ON CONFLICT(key) DO UPDATE … ` preserving `reused`, e.g. `reused = MAX(effects.reused, excluded.reused)`), and don't reset `created_at` on a reuse hit (use `reused_tx`/a separate timestamp). The "never pay twice" badge must not flicker off.
3. **`getWorldState` runs up to 3×/command** (pre-read, broadcast, route response). Return the post-commit state from `applySignalCommand` for the route handler; use a cheap `getCurrentPreferences(world)` for the pre-read instead of a full fold.
4. **SSE `broadcast` mutates the client Set while iterating** and only reaps dead clients on the next write. Collect dead controllers in a local array, delete after the loop; add a periodic SSE heartbeat so drops are reaped.
5. **Verify (likely already done):** `VoiceSurface` effect deps are primitives (no double-speak); `FabricSurface` doesn't fully rebuild the WebGL scene on every data change (create-once renderer/geometry, redraw the texture + hotspots on a scene-signature change).

---

## 3. Drag-and-drop layout — refinements (the core is correct, keep it)

The design is right: `/api/layout` → append-only `layout/desktop` fact at a new tx; `getWorldState` folds it; positions time-travel. Good. Refinements:

1. **Guard against mid-drag state pushes.** In `DraggableWidget`, the `frame`-resync `useEffect` ([App.tsx:488](apps/web/src/App.tsx)) can overwrite an in-progress drag if an SSE/state update or the prefetch-all-tx effect arrives. Skip the resync while `gesture.current !== null`.
2. **Bounds:** ensure `normalizeWidgetFrame` ([core](packages/core/src/index.ts)) clamps `x/y/width/height` so a widget can't be dragged off-canvas or sized to zero.
3. **Editing in the past:** committing a move calls `setAtTx(null)` (snaps to live). Be intentional — either disable drag handles while viewing a past tx, or treat an edit-in-the-past as a branch. Don't let it silently rewrite "now" from a rewound view without signalling it.
4. **Timeline noise:** each drag = one `"Moved widget"` tx (fine, even nice as history). Make the summary distinct (e.g. include the surface id) so the timeline stays readable.
5. **Multi-widget?** Today `DesktopSurface` renders one `DraggableWidget` for the single surface. `layout.widgets` is already a map — decide if a true multi-widget desktop is in scope (stronger "build your own dashboard" story) or if single move/resize is enough for the demo.

---

## 4. Housekeeping (low priority)

- **Rename "Signal UI" → "Shine"** (brand text [App.tsx:273](apps/web/src/App.tsx), server log, `CATALOG_ID`, package names). ⚠️ Renaming the Redis namespace (`signal:*`) or the SQLite file orphans state — do those together with a `pnpm reset`.
- **Git:** repo still isn't initialized. Worth `git init` + a `.gitignore` that covers `.env.local` (it holds the live key) so two agents' edits are tracked. **Do not push.**

---

### Priority order
**1 (Redis collaboration)** and **2.1 (heuristic fallback)** first — they're the biggest judged-criteria and demo-robustness wins. Then 2.2–2.4, then drag-drop refinements (§3), then housekeeping.
