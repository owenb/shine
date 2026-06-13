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
  type WidgetFrame,
  type WorldId,
  type WorldState,
} from "@sig/core";
import { FabricSurface } from "./FabricSurface";
import { VoiceSurface } from "./VoiceSurface";
import { ShineBackground } from "./ShineBackground";
import { Scrubber } from "./Scrubber";
import { backgroundChoices, users, type BgPalette } from "./users";
import shineLogo from "./assets/shine-logo.png";

type RendererKind = "dom" | "fabric" | "voice";

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
  const [userId, setUserId] = useState<string>(users[0].id);
  const [state, setState] = useState<WorldState | null>(null);
  const [atTx, setAtTx] = useState<number | null>(null);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [componentStyle, setComponentStyle] = useState<CSSProperties | null>(null);
  const [rendererOverride, setRendererOverride] = useState<RendererKind | null>(null);
  const [rendererFlash, setRendererFlash] = useState(false);
  const [backgroundByUser, setBackgroundByUser] = useState<Record<string, string>>(() => loadBackgroundPrefs());
  const stateCache = useRef(new Map<string, WorldState>());
  const inflightState = useRef(new Map<string, Promise<WorldState>>());
  const user = users.find((item) => item.id === userId) ?? users[0];
  const world: WorldId = user.world;
  const backgroundId = backgroundByUser[user.id];
  const selectedBackground = backgroundChoices.find((choice) => choice.id === backgroundId);
  const palette: BgPalette = selectedBackground?.bg ?? user.bg;
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
        throw new Error("CopilotKit builder did not return a Shine state snapshot");
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

  const chooseBackground = useCallback(
    (id: string) => {
      setBackgroundByUser((current) => {
        const next = { ...current, [user.id]: id };
        saveBackgroundPrefs(next);
        return next;
      });
    },
    [user.id],
  );

  return (
    <A2UIProvider catalog={signalCatalog}>
      <ShineBackground palette={palette} />
      <main
        className="app-shell"
        data-live={live ? "true" : "false"}
        data-density={user.density}
        style={{ ...(componentStyle ?? {}), ...user.theme } as CSSProperties}
      >
        <header className="topbar">
          <div className="brand">
            <img src={shineLogo} alt="Shine" className="brand-logo" />
          </div>
          <div className="user-switcher" role="radiogroup" aria-label="User">
            <span className="user-name">{user.name}</span>
            <div className="user-avatars">
              {users.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="radio"
                  aria-checked={item.id === userId}
                  aria-label={item.name}
                  title={item.name}
                  className={item.id === userId ? "user-avatar selected" : "user-avatar"}
                  style={{ background: item.avatar }}
                  onClick={() => {
                    setUserId(item.id);
                    setAtTx(null);
                  }}
                >
                  {item.initial}
                </button>
              ))}
            </div>
            <div className="bg-switcher" aria-label="Background">
              {backgroundChoices.map((choice) => (
                <button
                  key={choice.id}
                  type="button"
                  aria-label={`${choice.label} background`}
                  className={choice.id === selectedBackground?.id ? "bg-swatch selected" : "bg-swatch"}
                  style={{ background: choice.swatch }}
                  onClick={() => chooseBackground(choice.id)}
                />
              ))}
            </div>
          </div>
        </header>

        <section className="canvas" aria-label="A2UI Surface">
          <DesktopSurface state={state} renderer={activeRenderer} onLayoutCommit={commitLayout} />
        </section>

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
            label={`tx ${String(state?.selectedTx ?? 0).padStart(3, "0")}`}
            onScrub={scrub}
            onLive={() => setAtTx(null)}
          />
        </section>
      </main>
    </A2UIProvider>
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
  renderer,
  onLayoutCommit,
}: {
  state: WorldState | null;
  renderer: RendererKind;
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
      <SurfaceSwitch state={readyState} renderer={renderer} />
    </DraggableWidget>
  );
}

function SurfaceSwitch({ state, renderer }: { state: ReadyWorldState; renderer: RendererKind }) {
  if (!state?.surface) {
    return <div className="empty-widget" />;
  }

  if (renderer === "fabric") {
    return <FabricSurface surface={state.surface} scene={state.scene} />;
  }

  if (renderer === "voice") {
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
  const prevKind = useRef<string | null>(null);
  const createdSurface = useRef(false);

  useEffect(() => {
    if (prevKind.current !== state.surface.kind) {
      clearSurfaces();
      createdSurface.current = false;
      prevKind.current = state.surface.kind;
    }
    const ops = state.surface.ops ?? [];
    if (createdSurface.current) {
      processMessages(ops.filter((op) => !("createSurface" in op)));
    } else {
      processMessages(ops);
      createdSurface.current = true;
    }
  }, [clearSurfaces, processMessages, state.surface.kind, state.selectedTx, state.surface.ops]);

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

function rendererLabel(renderer: RendererKind) {
  return renderer === "fabric" ? "Cloth" : renderer === "voice" ? "Voice" : "DOM";
}

function loadBackgroundPrefs() {
  try {
    const raw = window.localStorage.getItem("shine:bg");
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function saveBackgroundPrefs(value: Record<string, string>) {
  try {
    window.localStorage.setItem("shine:bg", JSON.stringify(value));
  } catch {
    // Non-critical preference.
  }
}

function isWorldState(value: unknown): value is WorldState {
  if (!value || typeof value !== "object") return false;
  const maybe = value as Partial<WorldState>;
  return typeof maybe.world === "string" && isWorldId(maybe.world) && typeof maybe.headTx === "number";
}
