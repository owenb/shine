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
import { CopilotKit, useAgentContext } from "@copilotkit/react-core/v2";
import { signalCatalog } from "./a2ui-catalog";
import {
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
  const [userId, setUserId] = useState<string>(() => userIdFromLocation());
  const [state, setState] = useState<WorldState | null>(null);
  const [atTx, setAtTx] = useState<number | null>(null);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [componentStyle, setComponentStyle] = useState<CSSProperties | null>(null);
  const [rendererMode, setRendererMode] = useState<RendererKind>("dom");
  const [rendererFlash, setRendererFlash] = useState(false);
  const [backgroundByUser, setBackgroundByUser] = useState<Record<string, string>>(() => loadBackgroundPrefs());
  const stateCache = useRef(new Map<string, WorldState>());
  const inflightState = useRef(new Map<string, Promise<WorldState>>());
  const user = users.find((item) => item.id === userId) ?? users[0];
  const world: WorldId = user.world;
  const selectedBackground =
    backgroundChoices.find((choice) => choice.id === backgroundByUser[user.id]) ?? backgroundChoices[0];
  const activeBackgroundId = selectedBackground?.id ?? "";
  const palette: BgPalette = selectedBackground?.bg ?? user.bg;
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

  useEffect(() => {
    function onPopState() {
      setUserId(userIdFromLocation());
      setAtTx(null);
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

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
  const activeRenderer: RendererKind = rendererMode;

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key.toLowerCase() !== "r" || event.metaKey || event.ctrlKey || event.altKey) return;
      const el = event.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      event.preventDefault();
      const order: RendererKind[] = ["dom", "fabric", "voice"];
      setRendererMode((current) => {
        return order[(order.indexOf(current) + 1) % order.length];
      });
      setRendererFlash(true);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!rendererFlash) return;
    const id = window.setTimeout(() => setRendererFlash(false), 1400);
    return () => window.clearTimeout(id);
  }, [rendererFlash]);

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
      const next = await sendAgentCommand(world, trimmed);
      cacheWorldState(next);
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

  const deleteWidget = useCallback(
    async (surfaceId: string) => {
      if (!state) return;
      const next = await deleteLayout(world, surfaceId);
      cacheWorldState(next);
      setAtTx(null);
      setState(next);
    },
    [cacheWorldState, state, world],
  );

  const selectUser = useCallback((nextUserId: string) => {
    setUserId(nextUserId);
    setAtTx(null);
    pushUserIdToLocation(nextUserId);
  }, []);

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
        data-theme={selectedBackground?.bg.dark ? "dark" : "light"}
        style={{ ...(componentStyle ?? {}), ...user.theme } as CSSProperties}
      >
        <header className="topbar">
          <div className="brand" aria-label="Shine">
            <span className="brand-logo" aria-hidden="true" />
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
                  onClick={() => selectUser(item.id)}
                >
                  {item.initial}
                </button>
              ))}
            </div>
          </div>
        </header>
        <div className="bg-switcher" aria-label="Background" role="group">
          {backgroundChoices.map((choice) => (
            <button
              key={choice.id}
              type="button"
              aria-label={`${choice.label} background`}
              title={choice.label}
              className={choice.id === activeBackgroundId ? "bg-swatch selected" : "bg-swatch"}
              style={{ background: choice.swatch }}
              onClick={() => chooseBackground(choice.id)}
            />
          ))}
        </div>

        <section className="canvas" aria-label="A2UI Surface">
          <DesktopSurface
            state={state}
            renderer={activeRenderer}
            onLayoutCommit={commitLayout}
            onWidgetDelete={deleteWidget}
          />
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
  onDelete,
}: {
  surfaceId: string;
  frame: WidgetFrame;
  tx: number;
  editable: boolean;
  children: ReactNode;
  onCommit: (frame: WidgetFrame) => Promise<void>;
  onDelete: () => Promise<void>;
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
            <button
              type="button"
              className="widget-delete"
              aria-label="Delete widget"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                void onDelete();
              }}
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
  onWidgetDelete,
}: {
  state: WorldState | null;
  renderer: RendererKind;
  onLayoutCommit: (surfaceId: string, frame: WidgetFrame) => Promise<void>;
  onWidgetDelete: (surfaceId: string) => Promise<void>;
}) {
  const surfaces = state?.surfaces?.length ? state.surfaces : state?.surface ? [state.surface] : [];
  const visibleSurfaces = surfaces.filter((surface) => Boolean(state?.layout.widgets[surface.surfaceId]));

  if (!state || !visibleSurfaces.length) {
    return null;
  }
  const editable = state.selectedTx === state.headTx;

  return (
    <>
      {visibleSurfaces.map((surface) => {
        const frame = state.layout.widgets[surface.surfaceId] ?? {
          x: 0.25,
          y: 0.16,
          width: 0.54,
          height: 0.5,
        };
        return (
          <DraggableWidget
            key={surface.surfaceId}
            frame={frame}
            surfaceId={surface.surfaceId}
            tx={state.selectedTx}
            editable={editable}
            onCommit={(nextFrame) => onLayoutCommit(surface.surfaceId, nextFrame)}
            onDelete={() => onWidgetDelete(surface.surfaceId)}
          >
            <SurfaceSwitch
              world={state.world}
              selectedTx={state.selectedTx}
              surface={surface}
              scene={state.scenes?.[surface.surfaceId] ?? null}
              renderer={renderer}
            />
          </DraggableWidget>
        );
      })}
    </>
  );
}

function SurfaceSwitch({
  world,
  selectedTx,
  surface,
  scene,
  renderer,
}: {
  world: WorldId;
  selectedTx: number;
  surface: NonNullable<WorldState["surface"]>;
  scene: WorldState["scene"];
  renderer: RendererKind;
}) {
  if (renderer === "fabric") {
    return <FabricSurface surface={surface} scene={scene} />;
  }

  if (renderer === "voice") {
    return (
      <VoiceSurface surface={surface}>
        <DomSurface world={world} selectedTx={selectedTx} surface={surface} />
      </VoiceSurface>
    );
  }

  return <DomSurface world={world} selectedTx={selectedTx} surface={surface} />;
}

function DomSurface({
  world,
  selectedTx,
  surface,
}: {
  world: WorldId;
  selectedTx: number;
  surface: NonNullable<WorldState["surface"]>;
}) {
  const { processMessages } = useA2UI();
  const createdSurface = useRef(false);

  useEffect(() => {
    const ops = surface.ops ?? [];
    if (createdSurface.current) {
      processMessages(ops.filter((op) => !("createSurface" in op)));
    } else {
      processMessages(ops);
      createdSurface.current = true;
    }
  }, [processMessages, selectedTx, surface.ops]);

  return (
    <div className="surface-stage" key={`${world}:${surface.surfaceId}:${surface.kind}`}>
      <A2UIRenderer surfaceId={surface.surfaceId} fallback={null} />
    </div>
  );
}

async function loadState(world: WorldId, atTx: number | null) {
  const params = new URLSearchParams({ world });
  if (atTx !== null) params.set("atTx", String(atTx));
  return fetch(`/api/state?${params}`).then((res) => res.json() as Promise<WorldState>);
}

async function sendAgentCommand(world: WorldId, prompt: string) {
  const response = await fetch("/api/agent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world, prompt, source: "composer" }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as
      | { details?: string; error?: string }
      | null;
    throw new Error(body?.details ?? body?.error ?? `Agent failed with ${response.status}`);
  }
  return response.json() as Promise<WorldState>;
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

async function deleteLayout(world: WorldId, surfaceId: string) {
  const response = await fetch("/api/layout/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world, surfaceId }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as
      | { details?: unknown; error?: string }
      | null;
    throw new Error(body?.error ?? `Widget delete failed with ${response.status}`);
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

function userIdFromLocation() {
  if (typeof window === "undefined") return users[0].id;
  const value = new URLSearchParams(window.location.search).get("user");
  return isKnownUserId(value) ? value : users[0].id;
}

function pushUserIdToLocation(userId: string) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (url.searchParams.get("user") === userId) return;
  url.searchParams.set("user", userId);
  window.history.pushState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

function isKnownUserId(value: string | null): value is string {
  return users.some((item) => item.id === value);
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
