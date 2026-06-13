import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
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
import { isWorldId, worlds, type Receipt, type WorldId, type WorldState } from "@sig/core";
import { FabricSurface } from "./FabricSurface";
import { VoiceSurface } from "./VoiceSurface";
import { ShineBackground } from "./ShineBackground";
import { Scrubber } from "./Scrubber";

const worldLabels: Record<WorldId, string> = {
  "world-a": "World A",
  "world-b": "World B",
};

type RendererKind = "dom" | "fabric" | "voice";

type FlightEffect = {
  world: WorldId;
  tx: number;
  kind: string;
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
  const [flight, setFlight] = useState<FlightRecorder | null>(null);
  const [componentStyle, setComponentStyle] = useState<CSSProperties | null>(null);
  const [rendererOverride, setRendererOverride] = useState<RendererKind | null>(null);
  const [rendererFlash, setRendererFlash] = useState(false);
  const stateCache = useRef(new Map<string, WorldState>());
  const inflightState = useRef(new Map<string, Promise<WorldState>>());
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
  const activeRenderer: RendererKind = rendererOverride ?? state?.preferences.renderer ?? "dom";

  // Press R to cycle rendering engines (DOM → Cloth → Voice). A renderer command
  // from the agent (or a world switch) clears the manual override.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key.toLowerCase() !== "r" || event.metaKey || event.ctrlKey || event.altKey) return;
      const el = event.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      event.preventDefault();
      const order: RendererKind[] = ["dom", "fabric", "voice"];
      setRendererOverride((prev) => {
        const current = prev ?? state?.preferences.renderer ?? "dom";
        return order[(order.indexOf(current) + 1) % order.length];
      });
      setRendererFlash(true);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state?.preferences.renderer]);

  useEffect(() => {
    if (!rendererFlash) return;
    const id = window.setTimeout(() => setRendererFlash(false), 1400);
    return () => window.clearTimeout(id);
  }, [rendererFlash, rendererOverride]);

  useEffect(() => {
    setRendererOverride(null);
  }, [state?.preferences.renderer, world]);

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
        throw new Error("CopilotKit builder did not return a Shine surface snapshot");
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

  return (
    <A2UIProvider catalog={signalCatalog}>
      <ShineBackground />
      <main
        className="app-shell"
        data-live={live ? "true" : "false"}
        style={componentStyle ?? undefined}
      >
        <header className="topbar">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true" />
            Shine
            <span className={state?.redis.connected ? "memory-dot on" : "memory-dot"} />
          </div>
          <div className="world-toggle" data-active={world} role="radiogroup" aria-label="World">
            <span className="world-toggle-thumb" aria-hidden="true" />
            {worlds.map((id) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={id === world}
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
          <SurfaceSwitch state={state} renderer={activeRenderer} />
        </section>

        <FlightRecorderPanel state={state} flight={flight} />

        {rendererFlash ? (
          <div className="renderer-flash" aria-live="polite">
            <span>{rendererLabel(activeRenderer)}</span>
            <small>press R to cycle</small>
          </div>
        ) : null}

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

          <Scrubber
            length={timeline.length}
            index={selectedIndex}
            live={live}
            label={state?.surface?.data.txLabel ?? "tx 000"}
            onScrub={scrub}
            onLive={() => setAtTx(null)}
          />
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
        <mark>{state?.redis.agentMemory.connected ? "Iris on" : "Iris off"}</mark>
      </div>

      <div className="flight-list" aria-label="Receipts">
        {receipts.map((receipt) => (
          <div key={`${receipt.tx}-${receipt.code}`} className="flight-line">
            <span>{receipt.code.replace(/_/g, " ").toLowerCase()}</span>
            <strong>{String(receipt.tx).padStart(3, "0")}</strong>
          </div>
        ))}
      </div>

      <div className="flight-effects" aria-label="Effects">
        {effects.map((effect) => (
          <div key={`${effect.tx}-${effect.kind}-${effect.at}`} className="flight-line">
            <span>{effect.kind.replace(/^gemini-/, "")}</span>
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

function SurfaceSwitch({ state, renderer }: { state: WorldState | null; renderer: RendererKind }) {
  if (!state?.surface) {
    return <div className="empty-widget" />;
  }
  const readyState = state as ReadyWorldState;

  if (renderer === "fabric") {
    return <FabricSurface surface={readyState.surface} scene={readyState.scene} />;
  }

  if (renderer === "voice") {
    return (
      <VoiceSurface surface={readyState.surface}>
        <DomSurface state={readyState} />
      </VoiceSurface>
    );
  }

  return <DomSurface state={readyState} />;
}

type ReadyWorldState = WorldState & { surface: NonNullable<WorldState["surface"]> };

function DomSurface({ state }: { state: ReadyWorldState }) {
  const { processMessages, clearSurfaces } = useA2UI();
  const prevKind = useRef<string | null>(null);
  const created = useRef(false);

  useEffect(() => {
    // Tear down only when the surface *shape* changes; scrubbing within one kind
    // keeps the component instances mounted so values roll instead of flashing.
    if (prevKind.current !== state.surface.kind) {
      clearSurfaces();
      created.current = false;
      prevKind.current = state.surface.kind;
    }
    const ops = state.surface.ops ?? [];
    if (created.current) {
      // Re-sending createSurface for an existing surface throws "already exists"
      // and aborts the whole batch — so updateDataModel never runs and the value
      // freezes. Skip it; replay only the component + data ops.
      processMessages(ops.filter((op) => !("createSurface" in op)));
    } else {
      processMessages(ops);
      created.current = true;
    }
  }, [clearSurfaces, processMessages, state.surface.kind, state.selectedTx, state.surface.ops]);

  // Keyed by world + kind: a kind change replays the enter animation, while
  // same-kind scrubs keep instances mounted so the metric can roll.
  return (
    <div className="surface-stage" key={`${state.world}:${state.surface.kind}`}>
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

function compactModel(model: string) {
  return model.replace(/^gemini-/, "").replace(/-flash/, " flash");
}

function rendererLabel(renderer: RendererKind) {
  return renderer === "fabric" ? "Cloth" : renderer === "voice" ? "Voice" : "DOM";
}

function isWorldState(value: unknown): value is WorldState {
  if (!value || typeof value !== "object") return false;
  const maybe = value as Partial<WorldState>;
  return typeof maybe.world === "string" && isWorldId(maybe.world) && typeof maybe.headTx === "number";
}
