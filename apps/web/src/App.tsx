import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { A2UIProvider, A2UIRenderer, useA2UI } from "@copilotkit/a2ui-renderer";
import { CopilotKit } from "@copilotkit/react-core/v2";
import { signalCatalog } from "./a2ui-catalog";
import { worlds, type WorldId, type WorldState } from "@sig/core";
import { FabricSurface } from "./FabricSurface";
import { VoiceSurface } from "./VoiceSurface";

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
  const [componentStyle, setComponentStyle] = useState<CSSProperties | null>(null);

  useEffect(() => {
    void loadState(world, atTx).then(setState);
  }, [world, atTx]);

  useEffect(() => {
    if (atTx !== null) return;
    const events = new EventSource(`/api/events?world=${world}`);
    events.addEventListener("state", (event) => {
      setState(JSON.parse((event as MessageEvent).data) as WorldState);
    });
    return () => events.close();
  }, [world, atTx]);

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
    setPrompt("");
    try {
      const next = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ world, prompt: trimmed }),
      }).then((res) => res.json() as Promise<WorldState>);
      setAtTx(null);
      setState(next);
    } finally {
      setBusy(false);
    }
  }

  function scrub(index: number) {
    const item = timeline[index];
    if (!item || !state) return;
    setAtTx(item.tx === state.headTx ? null : item.tx);
  }

  return (
    <CopilotKit
      runtimeUrl="/api/copilotkit"
      useSingleEndpoint={false}
      showDevConsole={false}
      enableInspector={false}
    >
      <A2UIProvider catalog={signalCatalog}>
      <main
        className="app-shell"
        style={componentStyle ?? undefined}
      >
        <header className="topbar">
          <div className="brand">
            Signal UI
            <span className={state?.redis.connected ? "memory-dot on" : "memory-dot"} />
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

          <div className="scrubber">
            <span>{state?.surface?.data.txLabel ?? "tx 000"}</span>
            <div
              className="scrub-track"
              role="slider"
              tabIndex={0}
              aria-label="Transaction scrubber"
              aria-valuemin={0}
              aria-valuemax={Math.max(timeline.length - 1, 0)}
              aria-valuenow={selectedIndex}
              onPointerDown={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                const ratio = (event.clientX - rect.left) / Math.max(rect.width, 1);
                scrub(Math.round(ratio * Math.max(timeline.length - 1, 0)));
              }}
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

  useEffect(() => {
    clearSurfaces();
    if (state.surface.ops) {
      processMessages(state.surface.ops);
    }
  }, [clearSurfaces, processMessages, state.selectedTx, state.surface.ops]);

  return (
    <div className="surface-stage" key={`${state.world}-${state.selectedTx}`}>
      <A2UIRenderer surfaceId={state.surface.surfaceId} fallback={<div className="empty-widget" />} />
    </div>
  );
}

async function loadState(world: WorldId, atTx: number | null) {
  const params = new URLSearchParams({ world });
  if (atTx !== null) params.set("atTx", String(atTx));
  return fetch(`/api/state?${params}`).then((res) => res.json() as Promise<WorldState>);
}
