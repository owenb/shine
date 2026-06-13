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
import { CopilotKit } from "@copilotkit/react-core/v2";
import { signalCatalog } from "./a2ui-catalog";
import { worlds, type WorldId, type WorldState } from "@sig/core";
import { FabricSurface } from "./FabricSurface";
import { VoiceSurface } from "./VoiceSurface";
import { ShineBackground } from "./ShineBackground";
import { Scrubber } from "./Scrubber";

const worldLabels: Record<WorldId, string> = {
  "world-a": "World A",
  "world-b": "World B",
};

export function App() {
  const [world, setWorld] = useState<WorldId>("world-a");
  const [state, setState] = useState<WorldState | null>(null);
  const [atTx, setAtTx] = useState<number | null>(null);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [componentStyle, setComponentStyle] = useState<CSSProperties | null>(null);
  const cacheRef = useRef<Map<string, WorldState>>(new Map());
  const remember = useCallback((next: WorldState) => {
    cacheRef.current.set(cacheKey(next.world, next.selectedTx), next);
  }, []);

  // Resolve the surface for the current world + tx. History is immutable, so we
  // serve scrubs straight from cache (zero network → the thumb and the surface
  // move as one). Only a cache miss or going Live touches the server.
  useEffect(() => {
    if (atTx !== null) {
      const cached = cacheRef.current.get(cacheKey(world, atTx));
      if (cached) {
        setState(cached);
        return;
      }
    }
    const controller = new AbortController();
    void loadState(world, atTx, controller.signal)
      .then((next) => {
        remember(next);
        setState(next);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [world, atTx, remember]);

  // Live updates only while pinned to head — scrubbing the past is never yanked
  // forward by a new commit.
  useEffect(() => {
    if (atTx !== null) return;
    const events = new EventSource(`/api/events?world=${world}`);
    events.addEventListener("state", (event) => {
      const next = JSON.parse((event as MessageEvent).data) as WorldState;
      remember(next);
      setState(next);
    });
    return () => events.close();
  }, [world, atTx, remember]);

  // Warm the cache for every point in the timeline so the first scrub is already
  // instant. Keyed on headTx (a stable proxy for "the timeline grew") so it does
  // not re-scan on every live tick's fresh array reference.
  useEffect(() => {
    const controller = new AbortController();
    for (const item of state?.timeline ?? []) {
      if (cacheRef.current.has(cacheKey(world, item.tx))) continue;
      void loadState(world, item.tx, controller.signal)
        .then((next) => remember(next))
        .catch(() => {});
    }
    return () => controller.abort();
  }, [world, state?.headTx, remember]);

  const timeline = state?.timeline ?? [];
  const selectedIndex = useMemo(() => {
    if (!timeline.length || !state) return 0;
    return Math.max(
      0,
      timeline.findIndex((item) => item.tx === state.selectedTx),
    );
  }, [state, timeline]);
  const live = state ? state.selectedTx === state.headTx : true;

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
      const response = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ world, prompt: trimmed }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { details?: string; error?: string } | null;
        throw new Error(body?.details ?? body?.error ?? `Request failed with ${response.status}`);
      }
      const next = (await response.json()) as WorldState;
      setAtTx(null);
      setState(next);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setBusy(false);
    }
  }

  function scrub(index: number) {
    const item = timeline[index];
    if (!item || !state) return;
    const nextTx = item.tx === state.headTx ? null : item.tx;
    setAtTx(nextTx);
    // Pull the state synchronously from cache so the surface updates on the same
    // frame as the thumb — no waiting on a fetch.
    const cached = cacheRef.current.get(cacheKey(world, nextTx ?? state.headTx));
    if (cached) setState(cached);
  }

  return (
    <CopilotKit
      runtimeUrl="/api/copilotkit"
      useSingleEndpoint={false}
      showDevConsole={false}
      enableInspector={false}
    >
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
          <SurfaceSwitch state={state} />
        </section>

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

          {error ? <p className="composer-error">Gemini failed: {error}</p> : null}

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
    </CopilotKit>
  );
}

function SurfaceSwitch({ state }: { state: WorldState | null }) {
  if (!state?.surface) {
    return <div className="empty-widget" />;
  }
  const readyState = state as ReadyWorldState;

  if (readyState.preferences.renderer === "fabric") {
    return <FabricSurface surface={readyState.surface} scene={readyState.scene} />;
  }

  if (readyState.preferences.renderer === "voice") {
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

function cacheKey(world: WorldId, tx: number) {
  return `${world}:${tx}`;
}

async function loadState(world: WorldId, atTx: number | null, signal?: AbortSignal) {
  const params = new URLSearchParams({ world });
  if (atTx !== null) params.set("atTx", String(atTx));
  return fetch(`/api/state?${params}`, { signal }).then((res) => res.json() as Promise<WorldState>);
}
