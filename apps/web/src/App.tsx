import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
} from "react";
import { A2UIProvider, A2UIRenderer, useA2UI } from "@copilotkit/a2ui-renderer";
import {
  CopilotKit,
  UseAgentUpdate,
  useAgent,
  useAgentContext,
  useCopilotKit,
} from "@copilotkit/react-core/v2";
import { signalCatalog } from "./a2ui-catalog";
import {
  isWorldId,
  normalizeWidgetFrame,
  worlds,
  type AgentRole,
  type Receipt,
  type WidgetFrame,
  type WorldId,
  type WorldState,
} from "@sig/core";
import { FabricSurface } from "./FabricSurface";
import { VoiceSurface } from "./VoiceSurface";
import shineLogo from "./assets/shine-logo.png";

const worldLabels: Record<WorldId, string> = {
  "world-a": "World A",
  "world-b": "World B",
};

type FlightEffect = {
  world: WorldId;
  tx: number;
  kind: string;
  role?: AgentRole | null;
  input: unknown;
  output: unknown;
  reused: boolean;
  at: string;
};

type FlightRecorder = {
  world: WorldId;
  headTx: number;
  selectedTx: number;
  redis: WorldState["redis"];
  linkup: WorldState["linkup"];
  receipts: Array<Receipt & { summary?: string }>;
  effects: FlightEffect[];
};

export function App() {
  return (
    <CopilotKit
      runtimeUrl="/api/copilotkit"
      useSingleEndpoint={false}
      showDevConsole={false}
      enableInspector={false}
    >
      <SignalApp />
    </CopilotKit>
  );
}

function SignalApp() {
  const [world, setWorld] = useState<WorldId>("world-a");
  const [state, setState] = useState<WorldState | null>(null);
  const [atTx, setAtTx] = useState<number | null>(null);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const [flight, setFlight] = useState<FlightRecorder | null>(null);
  const [componentStyle, setComponentStyle] = useState<CSSProperties | null>(null);
  const stateCache = useRef(new Map<string, WorldState>());
  const inflightState = useRef(new Map<string, Promise<WorldState>>());
  const draggingScrubber = useRef(false);
  const { copilotkit } = useCopilotKit();
  const { agent } = useAgent({
    agentId: "builder",
    updates: [UseAgentUpdate.OnStateChanged, UseAgentUpdate.OnRunStatusChanged],
  });
  const agentContext = useMemo(
    () => ({
      world,
      selectedTx: state?.selectedTx ?? null,
      headTx: state?.headTx ?? null,
    }),
    [world, state?.selectedTx, state?.headTx],
  );

  useAgentContext({
    description: "signal-ui-context",
    value: agentContext,
  });

  const cacheWorldState = useCallback((next: WorldState) => {
    stateCache.current.set(stateCacheKey(next.world, next.selectedTx), next);
    if (next.selectedTx === next.headTx) {
      stateCache.current.set(stateCacheKey(next.world, null), next);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadStateCached(world, atTx, stateCache.current, inflightState.current).then((next) => {
      if (cancelled) return;
      cacheWorldState(next);
      setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, [world, atTx, cacheWorldState]);

  useEffect(() => {
    if (atTx !== null) return;
    const events = new EventSource(`/api/events?world=${world}`);
    events.addEventListener("state", (event) => {
      const next = JSON.parse((event as MessageEvent).data) as WorldState;
      cacheWorldState(next);
      setState(next);
    });
    return () => events.close();
  }, [world, atTx, cacheWorldState]);

  useEffect(() => {
    if (!state) return;
    let cancelled = false;
    void loadFlight(world, state.selectedTx)
      .then((next) => {
        if (!cancelled) setFlight(next);
      })
      .catch(() => {
        if (!cancelled) setFlight(null);
      });
    return () => {
      cancelled = true;
    };
  }, [world, state?.selectedTx]);

  const timeline = state?.timeline ?? [];
  const timelineKey = useMemo(() => timeline.map((item) => item.tx).join(","), [timeline]);
  const selectedIndex = useMemo(() => {
    if (!timeline.length || !state) return 0;
    return Math.max(
      0,
      timeline.findIndex((item) => item.tx === state.selectedTx),
    );
  }, [state, timeline]);
  const live = state ? state.selectedTx === state.headTx : true;

  useEffect(() => {
    for (const item of timeline) {
      void loadStateCached(world, item.tx, stateCache.current, inflightState.current)
        .then(cacheWorldState)
        .catch(() => undefined);
    }
  }, [world, timelineKey, cacheWorldState]);

  useEffect(() => {
    let cancelled = false;
    async function loadComponentModule() {
      if (!state?.componentModule?.body) {
        setComponentStyle(null);
        return;
      }
      const encoded = btoa(unescape(encodeURIComponent(state.componentModule.body)));
      const module = (await import(/* @vite-ignore */ `data:text/javascript;base64,${encoded}`)) as {
        component?: { accent?: string; radius?: string; shadow?: string };
        default?: (data: unknown) => { accent?: string; radius?: string; shadow?: string };
      };
      if (!cancelled) {
        const rendered = module.default?.(state.surface?.data ?? {});
        const tokens = {
          accent: rendered?.accent ?? module.component?.accent,
          radius: rendered?.radius ?? module.component?.radius,
          shadow: rendered?.shadow ?? module.component?.shadow,
        };
        setComponentStyle(
          tokens.accent || tokens.radius || tokens.shadow
            ? ({
                "--accent": tokens.accent,
                "--component-radius": tokens.radius,
                "--component-shadow": tokens.shadow,
              } as CSSProperties)
            : null,
        );
      }
    }
    void loadComponentModule().catch(() => {
      if (!cancelled) setComponentStyle(null);
    });
    return () => {
      cancelled = true;
    };
  }, [state?.componentModule?.body, state?.surface?.data]);

  async function submit() {
    const trimmed = prompt.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    setPrompt("");
    try {
      agent.addMessage({
        id: crypto.randomUUID(),
        role: "user",
        content: trimmed,
      });
      await copilotkit.runAgent({ agent });
      if (!isWorldState(agent.state)) {
        throw new Error("CopilotKit builder did not return a Signal UI state snapshot");
      }
      cacheWorldState(agent.state);
      setAtTx(null);
      setState(agent.state);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setBusy(false);
    }
  }

  function scrub(index: number) {
    const item = timeline[index];
    if (!item || !state) return;
    if (item.tx === state.selectedTx) return;
    const nextAtTx = item.tx === state.headTx ? null : item.tx;
    const cached = stateCache.current.get(stateCacheKey(world, nextAtTx ?? item.tx));
    if (cached) setState(cached);
    setAtTx(nextAtTx);
  }

  function scrubFromPointer(event: PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = clamp((event.clientX - rect.left) / Math.max(rect.width, 1), 0, 1);
    scrub(Math.round(ratio * Math.max(timeline.length - 1, 0)));
  }

  function stopScrubbing(event: PointerEvent<HTMLDivElement>) {
    draggingScrubber.current = false;
    setScrubbing(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  const commitLayout = useCallback(
    async (surfaceId: string, frame: WidgetFrame) => {
      if (!state) return;
      const next = await patchLayout(world, surfaceId, normalizeWidgetFrame(frame));
      cacheWorldState(next);
      setAtTx(null);
      setState(next);
    },
    [cacheWorldState, state, world],
  );

  return (
    <A2UIProvider catalog={signalCatalog}>
      <main
        className="app-shell"
        style={componentStyle ?? undefined}
      >
        <header className="topbar">
          <div className="brand">
            <img src={shineLogo} alt="shine" className="brand-logo" />
          </div>
          <div className="world-toggle" aria-label="World">
            {worlds.map((id) => (
              <button
                key={id}
                type="button"
                className={id === world ? "selected" : ""}
                onClick={() => {
                  setWorld(id);
                  setAtTx(null);
                }}
              >
                {worldLabels[id]}
              </button>
            ))}
          </div>
        </header>

        <section className="canvas" aria-label="A2UI Surface">
          <DesktopSurface state={state} onLayoutCommit={commitLayout} />
        </section>

        <FlightRecorderPanel state={state} flight={flight} />

        <section className="composer-wrap" aria-label="Command composer">
          <div className="composer">
            <input
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void submit();
              }}
              placeholder="Ask for a widget..."
              aria-label="Ask for a widget"
            />
            <button type="button" onClick={() => void submit()} disabled={busy || !prompt.trim()}>
              {busy ? (
                <span className="sending-dot" />
              ) : (
                <svg viewBox="0 0 20 20" aria-hidden="true">
                  <path d="M10 15.5V4.5M10 4.5 5.5 9M10 4.5 14.5 9" />
                </svg>
              )}
            </button>
          </div>

          {error ? <p className="composer-error">Agent failed: {error}</p> : null}

          <div className="scrubber">
            <span>tx {String(state?.selectedTx ?? 0).padStart(3, "0")}</span>
            <div
              className={scrubbing ? "scrub-track dragging" : "scrub-track"}
              role="slider"
              tabIndex={0}
              aria-label="Transaction scrubber"
              aria-valuemin={0}
              aria-valuemax={Math.max(timeline.length - 1, 0)}
              aria-valuenow={selectedIndex}
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId);
                draggingScrubber.current = true;
                setScrubbing(true);
                scrubFromPointer(event);
              }}
              onPointerMove={(event) => {
                if (draggingScrubber.current) scrubFromPointer(event);
              }}
              onPointerUp={stopScrubbing}
              onPointerCancel={stopScrubbing}
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft") scrub(Math.max(selectedIndex - 1, 0));
                if (event.key === "ArrowRight") {
                  scrub(Math.min(selectedIndex + 1, Math.max(timeline.length - 1, 0)));
                }
              }}
            >
              <div
                className="scrub-fill"
                style={{
                  width: `${timeline.length <= 1 ? 0 : (selectedIndex / (timeline.length - 1)) * 100}%`,
                }}
              />
              <div
                className="scrub-thumb"
                style={{
                  left: `${timeline.length <= 1 ? 0 : (selectedIndex / (timeline.length - 1)) * 100}%`,
                }}
              />
            </div>
            <button type="button" onClick={() => setAtTx(null)} className={live ? "live" : ""}>
              Live
            </button>
          </div>
        </section>
      </main>
    </A2UIProvider>
  );
}

function FlightRecorderPanel({
  state,
  flight,
}: {
  state: WorldState | null;
  flight: FlightRecorder | null;
}) {
  const agent = state?.agent;
  const memory = Object.entries(state?.redis.memory ?? {}).slice(0, 3);
  const receipts = (flight?.receipts.length ? flight.receipts : state?.receipts ?? []).slice(0, 3);
  const effects = (flight?.effects ?? []).slice(0, 4);
  const selectedTx = flight?.selectedTx ?? state?.selectedTx ?? 0;

  return (
    <aside className="flight-panel" aria-label="Flight Recorder">
      <div className="flight-head">
        <span>Flight</span>
        <strong>tx {String(selectedTx).padStart(3, "0")}</strong>
      </div>

      <div className="flight-badges" aria-label="Agent proof">
        <ProofBadge label={agent?.provider ?? "agent"} value={agent?.model ? compactModel(agent.model) : "waiting"} />
        <ProofBadge label="cache" value={agent?.reused ? "reused" : "fresh"} active={Boolean(agent?.reused)} />
        <ProofBadge label="LinkUp" value={agent?.grounded ? "grounded" : state?.linkup.configured ? "ready" : "no key"} active={Boolean(agent?.grounded)} />
        <ProofBadge
          label="memory"
          value={agent?.memory ? `${agent.memory.provider} ${agent.memory.count}` : `${memory.length}`}
          active={Boolean(agent?.memory?.count)}
        />
      </div>

      <div className="flight-memory" aria-label="Redis memory">
        <span className={state?.redis.connected ? "flight-dot on" : "flight-dot"} />
        <span>Redis</span>
        {memory.length ? (
          memory.map(([key, value]) => (
            <mark key={key}>
              {key}:{value}
            </mark>
          ))
        ) : (
          <mark>empty</mark>
        )}
      </div>

      <div className="flight-list" aria-label="Receipts">
        {receipts.map((receipt) => (
          <div key={`${receipt.tx}-${receipt.code}`} className="flight-line">
            <span>
              {receipt.role ? `${receipt.role} / ` : ""}
              {receipt.code.replace(/_/g, " ").toLowerCase()}
            </span>
            <strong>{String(receipt.tx).padStart(3, "0")}</strong>
          </div>
        ))}
      </div>

      <div className="flight-effects" aria-label="Effects">
        {effects.map((effect) => (
          <div key={`${effect.tx}-${effect.kind}-${effect.at}`} className="flight-line">
            <span>
              {effect.role ? `${effect.role} / ` : ""}
              {effect.kind.replace(/^gemini-/, "")}
            </span>
            <strong>{effect.reused ? "reused" : `tx ${String(effect.tx).padStart(3, "0")}`}</strong>
          </div>
        ))}
      </div>
    </aside>
  );
}

function ProofBadge({
  label,
  value,
  active = false,
}: {
  label: string;
  value: string;
  active?: boolean;
}) {
  return (
    <span className={active ? "proof-badge active" : "proof-badge"}>
      <small>{label}</small>
      {value}
    </span>
  );
}

type WidgetGestureMode = "move" | "east" | "south" | "corner";

type WidgetGesture = {
  mode: WidgetGestureMode;
  pointerId: number;
  startX: number;
  startY: number;
  frame: WidgetFrame;
  desktopWidth: number;
  desktopHeight: number;
};

function DraggableWidget({
  surfaceId,
  frame,
  tx,
  editable,
  children,
  onCommit,
}: {
  surfaceId: string;
  frame: WidgetFrame;
  tx: number;
  editable: boolean;
  children: ReactNode;
  onCommit: (frame: WidgetFrame) => Promise<void>;
}) {
  const [draft, setDraft] = useState(() => normalizeWidgetFrame(frame));
  const [activeMode, setActiveMode] = useState<WidgetGestureMode | null>(null);
  const gesture = useRef<WidgetGesture | null>(null);
  const cleanupGesture = useRef<(() => void) | null>(null);
  const latestFrame = useRef(draft);

  useEffect(() => {
    if (gesture.current) return;
    const next = normalizeWidgetFrame(frame);
    latestFrame.current = next;
    setDraft(next);
  }, [frame.x, frame.y, frame.width, frame.height, surfaceId, tx]);

  const updateDraft = useCallback((next: WidgetFrame) => {
    const normalized = normalizeWidgetFrame(next);
    latestFrame.current = normalized;
    setDraft(normalized);
  }, []);

  const startGesture = useCallback(
    (mode: WidgetGestureMode, event: PointerEvent<HTMLDivElement>) => {
      if (!editable) return;
      const desktop = event.currentTarget.closest(".canvas");
      if (!(desktop instanceof HTMLElement)) return;
      const rect = desktop.getBoundingClientRect();
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      gesture.current = {
        mode,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        frame: latestFrame.current,
        desktopWidth: Math.max(rect.width, 1),
        desktopHeight: Math.max(rect.height, 1),
      };
      setActiveMode(mode);

      const updateFromWindowPointer = (pointerEvent: globalThis.PointerEvent) => {
        const current = gesture.current;
        if (!current || current.pointerId !== pointerEvent.pointerId) return;
        pointerEvent.preventDefault();
        const dx = (pointerEvent.clientX - current.startX) / current.desktopWidth;
        const dy = (pointerEvent.clientY - current.startY) / current.desktopHeight;
        const next = { ...current.frame };

        if (current.mode === "move") {
          next.x += dx;
          next.y += dy;
        }
        if (current.mode === "east" || current.mode === "corner") {
          next.width += dx;
        }
        if (current.mode === "south" || current.mode === "corner") {
          next.height += dy;
        }

        updateDraft(next);
      };

      const finishFromWindowPointer = (pointerEvent: globalThis.PointerEvent) => {
        const current = gesture.current;
        if (!current || current.pointerId !== pointerEvent.pointerId) return;
        cleanupGesture.current?.();
        cleanupGesture.current = null;
        gesture.current = null;
        setActiveMode(null);
        const committed = latestFrame.current;
        if (frameChanged(current.frame, committed)) {
          void onCommit(committed).catch((error) => {
            console.error("[layout] failed to persist widget frame", error);
            updateDraft(current.frame);
          });
        }
      };

      cleanupGesture.current?.();
      window.addEventListener("pointermove", updateFromWindowPointer);
      window.addEventListener("pointerup", finishFromWindowPointer);
      window.addEventListener("pointercancel", finishFromWindowPointer);
      cleanupGesture.current = () => {
        window.removeEventListener("pointermove", updateFromWindowPointer);
        window.removeEventListener("pointerup", finishFromWindowPointer);
        window.removeEventListener("pointercancel", finishFromWindowPointer);
      };
    },
    [editable, onCommit, updateDraft],
  );

  useEffect(() => {
    return () => {
      cleanupGesture.current?.();
    };
  }, []);

  const moveGesture = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const current = gesture.current;
      if (!current || current.pointerId !== event.pointerId) return;
      event.preventDefault();
      const dx = (event.clientX - current.startX) / current.desktopWidth;
      const dy = (event.clientY - current.startY) / current.desktopHeight;
      const next = { ...current.frame };

      if (current.mode === "move") {
        next.x += dx;
        next.y += dy;
      }
      if (current.mode === "east" || current.mode === "corner") {
        next.width += dx;
      }
      if (current.mode === "south" || current.mode === "corner") {
        next.height += dy;
      }

      updateDraft(next);
    },
    [updateDraft],
  );

  const stopGesture = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const current = gesture.current;
      if (!current || current.pointerId !== event.pointerId) return;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      cleanupGesture.current?.();
      cleanupGesture.current = null;
      gesture.current = null;
      setActiveMode(null);
      const committed = latestFrame.current;
      if (frameChanged(current.frame, committed)) {
        void onCommit(committed).catch((error) => {
          console.error("[layout] failed to persist widget frame", error);
          updateDraft(current.frame);
        });
      }
    },
    [onCommit, updateDraft],
  );

  const sharedGestureProps = {
    onPointerMove: moveGesture,
    onPointerUp: stopGesture,
    onPointerCancel: stopGesture,
  };

  return (
    <div
      className={[
        "desktop-widget",
        activeMode ? "moving" : "",
        editable ? "" : "locked",
      ].filter(Boolean).join(" ")}
      data-surface-id={surfaceId}
      data-tx={tx}
      data-editable={editable}
      style={{
        left: `${draft.x * 100}%`,
        top: `${draft.y * 100}%`,
        width: `${draft.width * 100}%`,
        height: `${draft.height * 100}%`,
      }}
    >
      <div className="widget-frame">
        <div className="widget-content">{children}</div>
        {editable ? (
          <>
            <div
              className="widget-move-handle"
              role="button"
              tabIndex={0}
              aria-label="Move widget"
              onPointerDown={(event) => startGesture("move", event)}
              {...sharedGestureProps}
            />
            <div
              className="widget-resize-handle east"
              aria-label="Stretch widget width"
              onPointerDown={(event) => startGesture("east", event)}
              {...sharedGestureProps}
            />
            <div
              className="widget-resize-handle south"
              aria-label="Stretch widget height"
              onPointerDown={(event) => startGesture("south", event)}
              {...sharedGestureProps}
            />
            <div
              className="widget-resize-handle corner"
              aria-label="Resize widget"
              onPointerDown={(event) => startGesture("corner", event)}
              {...sharedGestureProps}
            />
          </>
        ) : null}
      </div>
    </div>
  );
}

function frameChanged(first: WidgetFrame, second: WidgetFrame) {
  return (
    Math.abs(first.x - second.x) > 0.001 ||
    Math.abs(first.y - second.y) > 0.001 ||
    Math.abs(first.width - second.width) > 0.001 ||
    Math.abs(first.height - second.height) > 0.001
  );
}

function DesktopSurface({
  state,
  onLayoutCommit,
}: {
  state: WorldState | null;
  onLayoutCommit: (surfaceId: string, frame: WidgetFrame) => Promise<void>;
}) {
  if (!state?.surface) {
    return <div className="empty-widget" />;
  }
  const readyState = state as ReadyWorldState;
  const surfaceId = readyState.surface.surfaceId;
  const editable = readyState.selectedTx === readyState.headTx;
  const frame = readyState.layout.widgets[surfaceId] ?? {
    x: 0.25,
    y: 0.16,
    width: 0.54,
    height: 0.5,
  };

  return (
    <DraggableWidget
      frame={frame}
      surfaceId={surfaceId}
      tx={readyState.selectedTx}
      editable={editable}
      onCommit={(nextFrame) => onLayoutCommit(surfaceId, nextFrame)}
    >
      <SurfaceSwitch state={readyState} />
    </DraggableWidget>
  );
}

function SurfaceSwitch({ state }: { state: ReadyWorldState }) {
  if (!state?.surface) {
    return <div className="empty-widget" />;
  }

  if (state.preferences.renderer === "fabric") {
    return <FabricSurface surface={state.surface} scene={state.scene} />;
  }

  if (state.preferences.renderer === "voice") {
    return (
      <VoiceSurface surface={state.surface}>
        <DomSurface state={state} />
      </VoiceSurface>
    );
  }

  return <DomSurface state={state} />;
}

type ReadyWorldState = WorldState & { surface: NonNullable<WorldState["surface"]> };

function DomSurface({ state }: { state: ReadyWorldState }) {
  const { processMessages, clearSurfaces } = useA2UI();
  const createdSurface = useRef(false);

  useEffect(() => {
    if (state.surface.ops) {
      const ops = createdSurface.current
        ? state.surface.ops.filter((op) => !("createSurface" in op))
        : state.surface.ops;
      processMessages(ops);
      createdSurface.current = true;
    }
  }, [processMessages, state.surface.ops]);

  useEffect(() => {
    return () => {
      clearSurfaces();
      createdSurface.current = false;
    };
  }, [clearSurfaces]);

  return (
    <div className="surface-stage">
      <A2UIRenderer surfaceId={state.surface.surfaceId} fallback={<div className="empty-widget" />} />
    </div>
  );
}

async function loadState(world: WorldId, atTx: number | null) {
  const params = new URLSearchParams({ world });
  if (atTx !== null) params.set("atTx", String(atTx));
  return fetch(`/api/state?${params}`).then((res) => res.json() as Promise<WorldState>);
}

async function loadFlight(world: WorldId, atTx: number) {
  const params = new URLSearchParams({ world, atTx: String(atTx) });
  return fetch(`/api/flight?${params}`).then((res) => res.json() as Promise<FlightRecorder>);
}

async function patchLayout(world: WorldId, surfaceId: string, frame: WidgetFrame) {
  const response = await fetch("/api/layout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world, surfaceId, frame }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as
      | { details?: unknown; error?: string }
      | null;
    throw new Error(body?.error ?? `Layout update failed with ${response.status}`);
  }
  return response.json() as Promise<WorldState>;
}

async function loadStateCached(
  world: WorldId,
  atTx: number | null,
  cache: Map<string, WorldState>,
  inflight: Map<string, Promise<WorldState>>,
) {
  const key = stateCacheKey(world, atTx);
  const cached = cache.get(key);
  if (cached) return cached;

  const pending = inflight.get(key);
  if (pending) return pending;

  const request = loadState(world, atTx)
    .then((next) => {
      cache.set(stateCacheKey(next.world, next.selectedTx), next);
      if (next.selectedTx === next.headTx) {
        cache.set(stateCacheKey(next.world, null), next);
      }
      return next;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, request);
  return request;
}

function stateCacheKey(world: WorldId, atTx: number | null) {
  return `${world}:${atTx ?? "live"}`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function compactModel(model: string) {
  return model.replace(/^gemini-/, "").replace(/-flash/, " flash");
}

function isWorldState(value: unknown): value is WorldState {
  if (!value || typeof value !== "object") return false;
  const maybe = value as Partial<WorldState>;
  return typeof maybe.world === "string" && isWorldId(maybe.world) && typeof maybe.headTx === "number";
}
