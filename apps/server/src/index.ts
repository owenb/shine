import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { serve } from "@hono/node-server";
import {
  BuiltInAgent,
  CopilotRuntime,
  InMemoryAgentRunner,
  createCopilotEndpoint,
} from "@copilotkit/runtime/v2";
import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/client";
import { GoogleGenAI } from "@google/genai";
import { config as loadEnv } from "dotenv";
import { LinkupClient } from "linkup-sdk";
import { createClient, type RedisClientType } from "redis";
import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  CATALOG_ID,
  CommandSchema,
  LayoutPatchSchema,
  SURFACE_ID,
  composeSurface,
  composeScene,
  defaultDesktopLayout,
  defaultPreferences,
  isWorldId,
  normalizeWidgetFrame,
  worlds,
  type AgentRole,
  type Grounding,
  type CommandInput,
  type DesktopLayout,
  type LayoutPatchInput,
  type Receipt,
  type SignalSurface,
  type SignalPacket,
  type TimelineItem,
  type WorldId,
  type WorldPreferences,
  type WorldState,
} from "@sig/core";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "../../..");
loadEnv({ path: join(rootDir, ".env.local"), quiet: true });
loadEnv({ path: join(rootDir, ".env"), quiet: true });
const dataDir = join(rootDir, "data");
mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(join(dataDir, "signal.sqlite"));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS txs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    world TEXT NOT NULL,
    summary TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS facts (
    tx INTEGER NOT NULL,
    world TEXT NOT NULL,
    entity TEXT NOT NULL,
    attr TEXT NOT NULL,
    value TEXT NOT NULL,
    FOREIGN KEY (tx) REFERENCES txs(id)
  );
  CREATE TABLE IF NOT EXISTS receipts (
    tx INTEGER NOT NULL,
    world TEXT NOT NULL,
    accepted INTEGER NOT NULL,
    code TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS blobs (
    hash TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS effects (
    key TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    input TEXT NOT NULL,
    output TEXT NOT NULL,
    reused INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS facts_world_tx ON facts(world, tx);
  CREATE INDEX IF NOT EXISTS txs_world_id ON txs(world, id);
`);
ensureColumn("effects", "world", "TEXT");
ensureColumn("effects", "tx", "INTEGER");
ensureColumn("effects", "reused_tx", "INTEGER");
ensureColumn("effects", "role", "TEXT");
ensureColumn("receipts", "role", "TEXT");
db.exec("CREATE INDEX IF NOT EXISTS effects_world_tx ON effects(world, tx);");

type FactValue = string | number | boolean | object | null;

type ServerRedis = {
  configured: boolean;
  connected: boolean;
  client: RedisClientType | null;
  memory: Map<WorldId, Record<string, string>>;
};

type MemoryContext = {
  provider: "redis-hash";
  memories: string[];
  effects: EffectUse[];
};

type EffectUse = {
  key: string;
  reused: boolean;
  role?: AgentRole;
};

type CommandResult = {
  receipt: Receipt;
  state: WorldState;
};

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
const redis: ServerRedis = {
  configured: true,
  connected: false,
  client: null,
  memory: new Map(),
};
const geminiApiKey = process.env.GEMINI_API_KEY;
const geminiModel = process.env.GEMINI_MODEL ?? "gemini-3.1-flash-lite";
const geminiTtsModel = process.env.GEMINI_TTS_MODEL ?? "gemini-3.1-flash-tts-preview";
const geminiVertexai = true;
const gemini = geminiApiKey
  ? new GoogleGenAI({ apiKey: geminiApiKey, vertexai: geminiVertexai })
  : null;
const linkup = process.env.LINKUP_API_KEY
  ? new LinkupClient({ apiKey: process.env.LINKUP_API_KEY })
  : null;

void connectRedis();
seedIfEmpty();

const app = new Hono();
app.use("*", cors());

const copilotBuilder = new BuiltInAgent({
  type: "custom",
  factory: ({ input }) => runSignalBuilderAgent(input),
});

const copilotApp = createCopilotEndpoint({
  runtime: new CopilotRuntime({
    agents: { default: copilotBuilder, builder: copilotBuilder },
    runner: new InMemoryAgentRunner(),
    a2ui: { injectA2UITool: false },
  }),
  basePath: "/api/copilotkit",
});

app.route("/", copilotApp);

const sseClients = new Map<WorldId, Set<ReadableStreamDefaultController>>();

app.get("/api/health", (c) =>
  c.json({
    ok: true,
    redis: { configured: redis.configured, connected: redis.connected },
    gemini: {
      configured: Boolean(gemini),
      model: geminiModel,
      ttsModel: geminiTtsModel,
      vertexai: geminiVertexai,
    },
    linkup: {
      configured: Boolean(linkup),
    },
    catalogId: CATALOG_ID,
    surfaceId: SURFACE_ID,
  }),
);

app.get("/api/state", (c) => {
  const world = parseWorld(c.req.query("world"));
  const atTx = parseOptionalInt(c.req.query("atTx"));
  return c.json(getWorldState(world, atTx));
});

app.get("/api/timeline", (c) => {
  const world = parseWorld(c.req.query("world"));
  return c.json({ world, timeline: getTimeline(world) });
});

app.get("/api/tx/:tx", (c) => {
  const tx = parseOptionalInt(c.req.param("tx"));
  if (!tx) return c.json({ error: "Invalid tx" }, 400);
  return c.json(getTxDetail(tx));
});

app.get("/api/flight", (c) => {
  const world = parseWorld(c.req.query("world"));
  const atTx = parseOptionalInt(c.req.query("atTx"));
  return c.json(getFlightRecorder(world, atTx));
});

app.post("/api/command", async (c) => {
  const raw = await c.req.json().catch(() => null);
  const parsed = CommandSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: "Invalid command", details: parsed.error.flatten() }, 400);
  }
  try {
    const result = await applyAgentCommand(parsed.data);
    return c.json(result.state);
  } catch (error) {
    return c.json(
      {
        error: "Signal agent failed",
        details: error instanceof Error ? error.message : String(error),
      },
      502,
    );
  }
});

app.post("/api/agent", async (c) => {
  const raw = await c.req.json().catch(() => null);
  const parsed = CommandSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: "Invalid command", details: parsed.error.flatten() }, 400);
  }
  try {
    const result = await applyAgentCommand({ ...parsed.data, source: "composer" });
    return c.json(result.state);
  } catch (error) {
    return c.json(
      {
        error: "Signal agent failed",
        details: error instanceof Error ? error.message : String(error),
      },
      502,
    );
  }
});

app.post("/api/layout", async (c) => {
  const raw = await c.req.json().catch(() => null);
  const parsed = LayoutPatchSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: "Invalid layout patch", details: parsed.error.flatten() }, 400);
  }
  const state = await applyLayoutPatch(parsed.data);
  return c.json(state);
});

app.post("/api/tts", async (c) => {
  const raw = (await c.req.json().catch(() => null)) as
    | { text?: unknown; voice?: unknown }
    | null;
  const text = typeof raw?.text === "string" ? raw.text.trim().slice(0, 1_200) : "";
  const voiceName = typeof raw?.voice === "string" && raw.voice.trim() ? raw.voice.trim() : "Kore";
  if (!text) {
    return c.json({ error: "Missing text" }, 400);
  }

  try {
    const audio = await synthesizeVoice(text, voiceName);
    const body = new Uint8Array(audio);
    return new Response(body, {
      headers: {
        "Content-Type": "audio/wav",
        "Cache-Control": "private, max-age=3600",
        "X-Gemini-TTS-Model": geminiTtsModel,
      },
    });
  } catch (error) {
    return c.json(
      {
        error: "Gemini TTS failed",
        details: error instanceof Error ? error.message : String(error),
      },
      502,
    );
  }
});

app.post("/api/reset", async (c) => {
  db.exec("DELETE FROM receipts; DELETE FROM facts; DELETE FROM txs; DELETE FROM blobs; DELETE FROM effects;");
  db.exec("DELETE FROM sqlite_sequence WHERE name IN ('txs');");
  redis.memory.clear();
  await clearRedisNamespace();
  seedIfEmpty();
  for (const world of worlds) {
    broadcast(world, getWorldState(world));
  }
  return c.json({ ok: true });
});

app.get("/api/events", (c) => {
  const world = parseWorld(c.req.query("world"));
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const stream = new ReadableStream({
    start(controller) {
      if (!sseClients.has(world)) sseClients.set(world, new Set());
      sseClients.get(world)!.add(controller);
      writeSse(controller, "state", getWorldState(world));
      heartbeat = setInterval(() => {
        try {
          writeSse(controller, "heartbeat", { at: new Date().toISOString() });
        } catch {
          sseClients.get(world)?.delete(controller);
          if (heartbeat) clearInterval(heartbeat);
        }
      }, 15_000);
    },
    cancel(controller) {
      sseClients.get(world)?.delete(controller);
      if (heartbeat) clearInterval(heartbeat);
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
});

serve({ fetch: app.fetch, port: 8787 });
console.log("Signal UI server on http://localhost:8787");

async function connectRedis() {
  try {
    const client = createClient({ url: redisUrl }) as RedisClientType;
    client.on("error", (err) => {
      redis.connected = false;
      console.warn("[redis] offline:", err.message);
    });
    await client.connect();
    redis.client = client;
    redis.connected = true;
    await hydrateRedisMemory();
    console.log("[redis] connected");
  } catch (error) {
    redis.connected = false;
    console.warn("[redis] unavailable; continuing without it");
  }
}

function seedIfEmpty() {
  for (const world of worlds) {
    const count = db.prepare("SELECT COUNT(*) AS count FROM txs WHERE world = ?").get(world) as {
      count: number;
    };
    if (count.count > 0) continue;

    const prefs = defaultPreferences(world);
    const codeHash = insertComponentBlob(prefs.component);
    const tx = insertTx(world, "Created world");
    insertFact(tx, world, "world", "preferences", prefs);
    insertFact(tx, world, "world", "codePin", codeHash);
    insertFact(tx, world, "layout", "desktop", defaultDesktopLayout(world));
    insertReceipt(tx, world, true, "WORLD_CREATED", `Seeded ${world}`);

    const surfaceTx = insertTx(world, "Rendered first widget");
    const surface = composeSurface(
      world,
      prefs,
      { type: "renderWidget", intent: "revenue", prompt: "Build the opening revenue widget" },
      surfaceTx,
    );
    insertFact(surfaceTx, world, "surface", "current", surface);
    insertReceipt(surfaceTx, world, true, "SURFACE_RENDERED", "Opening A2UI surface stored");
  }
}

async function applyAgentCommand(input: CommandInput): Promise<CommandResult> {
  const memoryContext = await retrieveMemoryContext(input.world, input.prompt);
  const signalResult = await resolveSignal(input.world, input.prompt, memoryContext);
  let signal = signalResult.signal;
  const groundingResult =
    signal.type === "renderWidget" && shouldGroundPrompt(input.prompt, signal.intent)
      ? await resolveGrounding(input.world, input.prompt)
      : undefined;
  if (signal.type === "renderWidget" && groundingResult && signal.intent !== "competitors") {
    signal = { ...signal, intent: "research" };
  }
  return applySignalCommand({
    input,
    signal,
    grounding: groundingResult?.grounding,
    memoryContext,
    effects: [
      ...(memoryContext?.effects ?? []),
      { key: signalResult.effect.key, reused: signalResult.effect.reused },
      ...(groundingResult ? [{ key: groundingResult.effect.key, reused: groundingResult.effect.reused }] : []),
    ],
    agent: {
      provider: signalResult.provider,
      model: signalResult.model,
      reused: signalResult.reused,
      grounded: Boolean(groundingResult?.grounding),
      memory: memoryContext
        ? { provider: memoryContext.provider, count: memoryContext.memories.length }
        : undefined,
    },
  });
}

async function applyLayoutPatch(input: LayoutPatchInput): Promise<WorldState> {
  const currentLayout = getCurrentLayout(input.world);
  const frame = normalizeWidgetFrame(input.frame);
  const layout: DesktopLayout = {
    widgets: {
      ...currentLayout.widgets,
      [input.surfaceId]: frame,
    },
  };
  const tx = insertTx(input.world, `Moved ${input.surfaceId} widget`);
  insertFact(tx, input.world, "layout", "desktop", layout);
  const receipt = insertReceipt(
    tx,
    input.world,
    true,
    "LAYOUT_UPDATED",
    `Stored ${input.surfaceId} frame for ${input.world}.`,
  );
  await writeRedisStream("layout", {
    world: input.world,
    tx,
    surfaceId: input.surfaceId,
    frame,
  });
  const state = getWorldState(input.world, tx);
  broadcast(input.world, state);
  return state;
}

async function* runSignalBuilderAgent(input: RunAgentInput): AsyncIterable<BaseEvent> {
  const world = extractCopilotWorld(input);
  const prompt = extractLatestUserText(input);
  if (!prompt) {
    throw new Error("CopilotKit builder received an empty user prompt");
  }

  const messageId = `signal-${input.runId}`;
  yield {
    type: EventType.CUSTOM,
    name: "signal.ui.command",
    value: { world, prompt },
  };

  const result = await applyAgentCommand({ world, prompt, source: "copilotkit" });
  const roleReceipts = getReceiptsForTx(world, result.receipt.tx);
  for (const roleReceipt of roleReceipts) {
    if (!roleReceipt.role) continue;
    yield {
      type: EventType.CUSTOM,
      name: roleEventName(roleReceipt),
      value: { world, tx: roleReceipt.tx, receipt: roleReceipt },
    };
  }
  const state = result.state;

  yield {
    type: EventType.STATE_SNAPSHOT,
    snapshot: state,
  };
  yield {
    type: EventType.TEXT_MESSAGE_START,
    messageId,
    role: "assistant",
  };
  yield {
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId,
    delta: `Rendered ${state.surface?.data.title ?? "Signal UI"}.`,
  };
  yield {
    type: EventType.TEXT_MESSAGE_END,
    messageId,
  };
  yield {
    type: EventType.CUSTOM,
    name: "signal.ui.state",
    value: { receipt: result.receipt, state },
  };
}

async function applySignalCommand({
  input,
  signal,
  grounding,
  memoryContext,
  effects,
  agent,
}: {
  input: CommandInput;
  signal: SignalPacket;
  grounding?: Grounding;
  memoryContext?: MemoryContext;
  effects?: EffectUse[];
  agent: NonNullable<WorldState["agent"]>;
}): Promise<CommandResult> {
  const nextPrefs = { ...getCurrentPreferences(input.world) };
  const tx = insertTx(input.world, summarize(input.prompt));
  await annotateEffectUses(effects ?? [], input.world, tx);
  const preferenceChanges: Array<{
    key: keyof WorldPreferences;
    value: string;
  }> = [];
  const learnedChanges: Array<{
    key: keyof WorldPreferences;
    value: string;
  }> = [];

  if (signal.type === "setPreference") {
    preferenceChanges.push({ key: signal.key, value: signal.value });
  }
  for (const hint of preferenceHintsFromPrompt(input.prompt)) {
    if (!preferenceChanges.some((change) => change.key === hint.key)) {
      preferenceChanges.push(hint);
    }
  }

  for (const change of preferenceChanges) {
    if (change.key === "presentation" && isPresentation(change.value)) {
      nextPrefs.presentation = change.value;
      await remember(input.world, tx, change.key, change.value);
      learnedChanges.push(change);
    }
    if (change.key === "tone" && isTone(change.value)) {
      nextPrefs.tone = change.value;
      await remember(input.world, tx, change.key, change.value);
      learnedChanges.push(change);
    }
    if (change.key === "renderer" && isRenderer(change.value)) {
      nextPrefs.renderer = change.value;
      await remember(input.world, tx, change.key, change.value);
      learnedChanges.push(change);
    }
    if (change.key === "component" && isComponent(change.value)) {
      nextPrefs.component = change.value;
      const hash = insertComponentBlob(change.value);
      insertFact(tx, input.world, "world", "codePin", hash);
      await remember(input.world, tx, change.key, change.value);
      learnedChanges.push(change);
    }
  }

  if (learnedChanges.length) {
    insertFact(tx, input.world, "world", "preferences", nextPrefs);
  }

  const curatorReceipt = insertReceipt(
    tx,
    input.world,
    true,
    learnedChanges.length ? "CURATOR_LEARNED" : memoryContext ? "CURATOR_RECALLED" : "CURATOR_READY",
    learnedChanges.length
      ? `Curator learned ${learnedChanges.map((change) => `${change.key}=${change.value}`).join(", ")}.`
      : memoryContext
        ? `Curator recalled ${memoryContext.memories.length} ${memoryContext.provider} memories.`
        : "Curator accepted the Gemini signal.",
    "curator",
  );
  await writeRedisStream("curator", {
    world: input.world,
    tx,
    role: "curator",
    code: curatorReceipt.code,
    learned: learnedChanges,
    memoryProvider: memoryContext?.provider,
    memoryCount: memoryContext?.memories.length ?? 0,
  });

  let researcherReceipt: Receipt | undefined;
  if (grounding) {
    insertFact(tx, input.world, "researcher", "grounding", grounding);
    researcherReceipt = insertReceipt(
      tx,
      input.world,
      true,
      "RESEARCHER_GROUNDED",
      `Researcher grounded ${grounding.sources.length} LinkUp sources.`,
      "researcher",
    );
    await writeRedisStream("researcher", {
      world: input.world,
      tx,
      role: "researcher",
      code: researcherReceipt.code,
      sourceCount: grounding.sources.length,
      reused: grounding.reused,
    });
  }

  const builderGrounding = grounding ? getLatestResearchGrounding(input.world, tx) ?? grounding : undefined;
  const surface = composeSurface(input.world, nextPrefs, signal, tx, builderGrounding);
  insertFact(tx, input.world, "surface", "current", surface);
  insertFact(tx, input.world, "agent", "last", agent);
  const receipt = insertReceipt(
    tx,
    input.world,
    true,
    "BUILDER_RENDERED",
    agent.grounded
      ? "Builder rendered a LinkUp-grounded A2UI surface."
      : "Builder compiled the Gemini signal through Loom into A2UI.",
    "builder",
  );
  const state = getWorldState(input.world, tx);
  await writeRedisStream("builder", {
    world: input.world,
    tx,
    role: "builder",
    code: receipt.code,
    provider: agent.provider,
    reused: agent.reused,
    grounded: agent.grounded,
    readResearch: Boolean(builderGrounding),
    readMemory: memoryContext?.memories.length ?? 0,
  });
  await writeRedisStream("receipt", {
    world: input.world,
    tx,
    receipts: [curatorReceipt, researcherReceipt, receipt].filter(Boolean),
  });
  broadcast(input.world, state);
  return { receipt, state };
}

function getLatestResearchGrounding(world: WorldId, tx: number): Grounding | undefined {
  const row = db
    .prepare(
      `SELECT value
       FROM facts
       WHERE world = ? AND entity = 'researcher' AND attr = 'grounding' AND tx <= ?
       ORDER BY tx DESC
       LIMIT 1`,
    )
    .get(world, tx) as { value: string } | undefined;
  if (!row) return undefined;
  return cleanGrounding(JSON.parse(row.value) as Grounding);
}

function extractCopilotWorld(input: RunAgentInput): WorldId {
  for (const item of input.context ?? []) {
    try {
      const value = JSON.parse(item.value) as { world?: unknown };
      if (typeof value.world === "string" && isWorldId(value.world)) {
        return value.world;
      }
    } catch {
      // Ignore unrelated CopilotKit context entries.
    }
  }
  return "world-a";
}

function extractLatestUserText(input: RunAgentInput): string {
  for (const message of [...input.messages].reverse()) {
    if (message.role === "user" && typeof message.content === "string") {
      return message.content.trim();
    }
  }
  return "";
}

function getWorldState(world: WorldId, atTx?: number): WorldState {
  const headTx = getHeadTx(world);
  const selectedTx = atTx ?? headTx;
  const facts = db
    .prepare(
      "SELECT entity, attr, value FROM facts WHERE world = ? AND tx <= ? ORDER BY tx ASC",
    )
    .all(world, selectedTx) as Array<{ entity: string; attr: string; value: string }>;

  let preferences = defaultPreferences(world);
  let layout = defaultDesktopLayout(world);
  let surface: SignalSurface | null = null;
  let codePin: string | null = null;
  let agent: WorldState["agent"] = null;

  for (const fact of facts) {
    const value = JSON.parse(fact.value) as FactValue;
    if (fact.entity === "world" && fact.attr === "preferences") {
      preferences = { ...preferences, ...(value as Partial<WorldPreferences>) };
    }
    if (fact.entity === "layout" && fact.attr === "desktop") {
      layout = normalizeDesktopLayout(world, value);
    }
    if (fact.entity === "surface" && fact.attr === "current") {
      surface = value as SignalSurface;
    }
    if (fact.entity === "world" && fact.attr === "codePin") {
      codePin = String(value);
    }
    if (fact.entity === "agent" && fact.attr === "last") {
      agent = value as WorldState["agent"];
    }
  }

  return {
    world,
    headTx,
    selectedTx,
    preferences,
    surface,
    scene: surface ? composeScene(surface, preferences) : null,
    timeline: getTimeline(world),
    receipts: getReceipts(world, selectedTx),
    componentModule: codePin ? getBlob(codePin) : null,
    layout,
    agent,
    redis: {
      configured: redis.configured,
      connected: redis.connected,
      memory: redis.memory.get(world) ?? {},
    },
    linkup: {
      configured: Boolean(linkup),
    },
  };
}

function getCurrentPreferences(world: WorldId): WorldPreferences {
  const row = db
    .prepare(
      `SELECT value
       FROM facts
       WHERE world = ? AND entity = 'world' AND attr = 'preferences'
       ORDER BY tx DESC, rowid DESC
       LIMIT 1`,
    )
    .get(world) as { value: string } | undefined;
  if (!row) return defaultPreferences(world);
  return {
    ...defaultPreferences(world),
    ...(JSON.parse(row.value) as Partial<WorldPreferences>),
  };
}

function getCurrentLayout(world: WorldId): DesktopLayout {
  const row = db
    .prepare(
      `SELECT value
       FROM facts
       WHERE world = ? AND entity = 'layout' AND attr = 'desktop'
       ORDER BY tx DESC, rowid DESC
       LIMIT 1`,
    )
    .get(world) as { value: string } | undefined;
  if (!row) return defaultDesktopLayout(world);
  return normalizeDesktopLayout(world, JSON.parse(row.value) as FactValue);
}

function getTimeline(world: WorldId): TimelineItem[] {
  return db
    .prepare("SELECT id AS tx, summary, created_at AS at FROM txs WHERE world = ? ORDER BY id ASC")
    .all(world) as TimelineItem[];
}

function normalizeDesktopLayout(world: WorldId, value: FactValue): DesktopLayout {
  const fallback = defaultDesktopLayout(world);
  if (!value || typeof value !== "object" || !("widgets" in value)) return fallback;
  const widgets = (value as { widgets?: unknown }).widgets;
  if (!widgets || typeof widgets !== "object") return fallback;

  const normalized: DesktopLayout = { widgets: { ...fallback.widgets } };
  for (const [surfaceId, rawFrame] of Object.entries(widgets as Record<string, unknown>)) {
    const parsed = LayoutPatchSchema.shape.frame.safeParse(rawFrame);
    if (parsed.success) {
      normalized.widgets[surfaceId] = normalizeWidgetFrame(parsed.data);
    }
  }
  return normalized;
}

function getReceipts(world: WorldId, atTx: number): Receipt[] {
  return db
    .prepare(
      `SELECT tx, accepted, code, message, created_at AS at, role
       FROM receipts
       WHERE world = ? AND tx <= ?
       ORDER BY tx DESC
       LIMIT 5`,
    )
    .all(world, atTx)
    .map((row) => ({
      ...(row as Omit<Receipt, "accepted"> & { accepted: number }),
      accepted: Boolean((row as { accepted: number }).accepted),
    }));
}

function getReceiptsForTx(world: WorldId, tx: number): Receipt[] {
  return db
    .prepare(
      `SELECT tx, accepted, code, message, created_at AS at, role
       FROM receipts
       WHERE world = ? AND tx = ?
       ORDER BY rowid ASC`,
    )
    .all(world, tx)
    .map((row) => ({
      ...(row as Omit<Receipt, "accepted"> & { accepted: number }),
      accepted: Boolean((row as { accepted: number }).accepted),
    }));
}

function roleEventName(receipt: Receipt) {
  if (receipt.role === "curator") {
    if (receipt.code === "CURATOR_LEARNED") return "signal.curator.learned";
    if (receipt.code === "CURATOR_RECALLED") return "signal.curator.recalled";
    return "signal.curator.ready";
  }
  if (receipt.role === "researcher") return "signal.researcher.grounded";
  return "signal.builder.rendered";
}

function getTxDetail(tx: number) {
  const txRow = db.prepare("SELECT id AS tx, world, summary, created_at AS at FROM txs WHERE id = ?").get(tx);
  const facts = db
    .prepare("SELECT world, entity, attr, value FROM facts WHERE tx = ? ORDER BY rowid ASC")
    .all(tx)
    .map((row) => ({
      ...(row as { world: string; entity: string; attr: string; value: string }),
      value: JSON.parse((row as { value: string }).value),
    }));
  const receipts = db
    .prepare(
      "SELECT tx, world, accepted, code, message, created_at AS at, role FROM receipts WHERE tx = ? ORDER BY rowid ASC",
    )
    .all(tx)
    .map((row) => ({
      ...(row as { accepted: number }),
      accepted: Boolean((row as { accepted: number }).accepted),
    }));
  return { tx: txRow ?? { tx }, facts, receipts };
}

function getFlightRecorder(world: WorldId, atTx?: number) {
  const headTx = getHeadTx(world);
  const selectedTx = atTx ?? headTx;
  const receipts = db
    .prepare(
      `SELECT receipts.tx, receipts.accepted, receipts.code, receipts.message, receipts.created_at AS at, receipts.role, txs.summary
       FROM receipts
       JOIN txs ON txs.id = receipts.tx
       WHERE receipts.world = ? AND receipts.tx <= ?
       ORDER BY receipts.tx DESC
       LIMIT 12`,
    )
    .all(world, selectedTx)
    .map((row) => ({
      ...(row as { accepted: number }),
      accepted: Boolean((row as { accepted: number }).accepted),
    }));
  const effects = db
    .prepare(
      `SELECT world, tx, kind, input, output, reused, reused_tx, role, created_at AS at
       FROM effects
       WHERE world = ? AND tx IS NOT NULL AND tx <= ?
       ORDER BY tx DESC, created_at DESC
       LIMIT 12`,
    )
    .all(world, selectedTx)
    .map((row) => ({
      world: (row as { world: string }).world,
      tx: (row as { tx: number }).tx,
      kind: (row as { kind: string }).kind,
      role: (row as { role: AgentRole | null }).role,
      input: JSON.parse((row as { input: string }).input),
      output: JSON.parse((row as { output: string }).output),
      reused: Boolean((row as { reused: number; reused_tx: number | null }).reused) &&
        ((row as { reused_tx: number | null }).reused_tx === null ||
          Number((row as { reused_tx: number | null }).reused_tx) <= selectedTx),
      at: (row as { at: string }).at,
    }));
  return {
    world,
    headTx,
    selectedTx,
    redis: {
      connected: redis.connected,
      memory: redis.memory.get(world) ?? {},
    },
    linkup: {
      configured: Boolean(linkup),
    },
    receipts,
    effects,
  };
}

function getHeadTx(world: WorldId): number {
  const row = db
    .prepare("SELECT COALESCE(MAX(id), 0) AS tx FROM txs WHERE world = ?")
    .get(world) as { tx: number };
  return row.tx;
}

function ensureColumn(table: "effects" | "receipts", column: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((item) => item.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function insertTx(world: WorldId, summary: string): number {
  const result = db
    .prepare("INSERT INTO txs (world, summary, created_at) VALUES (?, ?, ?)")
    .run(world, summary, new Date().toISOString());
  return Number(result.lastInsertRowid);
}

function insertFact(tx: number, world: WorldId, entity: string, attr: string, value: FactValue) {
  db.prepare("INSERT INTO facts (tx, world, entity, attr, value) VALUES (?, ?, ?, ?, ?)").run(
    tx,
    world,
    entity,
    attr,
    JSON.stringify(value),
  );
}

function insertReceipt(
  tx: number,
  world: WorldId,
  accepted: boolean,
  code: string,
  message: string,
  role?: AgentRole,
): Receipt {
  const at = new Date().toISOString();
  db.prepare(
    "INSERT INTO receipts (tx, world, accepted, code, message, created_at, role) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(tx, world, accepted ? 1 : 0, code, message, at, role ?? null);
  return { tx, accepted, code, message, at, role: role ?? null };
}

function insertBlob(hash: string, body: string) {
  db.prepare(
    "INSERT OR REPLACE INTO blobs (hash, kind, body, created_at) VALUES (?, ?, ?, ?)",
  ).run(hash, "component-code", body, new Date().toISOString());
}

function getBlob(hash: string): WorldState["componentModule"] {
  const row = db.prepare("SELECT hash, body FROM blobs WHERE hash = ?").get(hash) as
    | { hash: string; body: string }
    | undefined;
  return row ?? null;
}

function insertComponentBlob(variant: WorldPreferences["component"]) {
  const body = componentCode(variant);
  const hash = createHash("sha256").update(body).digest("hex").slice(0, 16);
  insertBlob(hash, body);
  return hash;
}

async function resolveSignal(world: WorldId, prompt: string, memoryContext?: MemoryContext): Promise<{
  signal: SignalPacket;
  provider: "gemini";
  model: string;
  reused: boolean;
  effect: EffectUse;
}> {
  if (!gemini) {
    throw new Error("GEMINI_API_KEY is not configured");
  }

  const signalCacheInput = {
    world,
    prompt,
    memory: memoryContext?.memories ?? [],
    model: geminiModel,
    vertexai: geminiVertexai,
  };
  const cached = await getCachedEffect<{ signal: SignalPacket }>("gemini-signal", signalCacheInput);
  if (cached) {
    const signal = normalizeGeminiSignal(cached.output.signal, prompt);
    return {
      signal,
      provider: "gemini",
      model: geminiModel,
      reused: true,
      effect: { key: cached.key, reused: cached.reused, role: "builder" },
    };
  }

  try {
    const response = await gemini.models.generateContent({
      model: geminiModel,
      contents: [
        {
          role: "user",
          parts: [
            {
              text:
                "Classify this request for Signal UI. Return JSON only. " +
                "Allowed render intents: revenue, competitors, research, pipeline, summary. " +
                "Allowed preferences: presentation=visual|table|brief, tone=calm|sharp, renderer=dom|fabric|voice, component=crystal|ledger|brief. " +
                (memoryContext?.memories.length
                  ? `Durable user memory: ${memoryContext.memories.join("; ")}. `
                  : "") +
                `Request: ${prompt}`,
            },
          ],
        },
      ],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["renderWidget", "setPreference"] },
            intent: { type: "string", enum: ["revenue", "competitors", "research", "pipeline", "summary"] },
            key: {
              type: "string",
              enum: ["presentation", "tone", "renderer", "component"],
            },
            value: { type: "string" },
          },
          required: ["type"],
        },
      },
    });
    const text = response.text ?? "{}";
    const parsed = JSON.parse(text) as Partial<SignalPacket>;
    const signal = normalizeGeminiSignal(parsed, prompt);
    const effect = await cacheEffect("gemini-signal", signalCacheInput, { signal }, false, {
      world,
      role: "builder",
    });
    return { signal, provider: "gemini", model: geminiModel, reused: false, effect };
  } catch (error) {
    await cacheEffect(
      "gemini-signal-error",
      signalCacheInput,
      { message: error instanceof Error ? error.message : String(error) },
      false,
      { world, role: "builder" },
    );
    throw error;
  }
}

async function resolveGrounding(
  world: WorldId,
  prompt: string,
): Promise<{ grounding: Grounding; effect: EffectUse } | undefined> {
  if (!linkup) return undefined;

  const input = { world, prompt };
  const cached = await getCachedEffect<Grounding>("linkup-grounding", input);
  if (cached) {
    return {
      grounding: cleanGrounding({ ...cached.output, reused: true }),
      effect: { key: cached.key, reused: cached.reused, role: "researcher" },
    };
  }

  try {
    const result = await linkup.search({
      query: prompt,
      depth: "fast",
      outputType: "sourcedAnswer",
    });
    const grounding: Grounding = {
      provider: "linkup",
      reused: false,
      answer: cleanLinkupText(result.answer),
      sources: result.sources.slice(0, 4).map((source) => ({
        title: cleanLinkupText(source.name),
        label: hostname(source.url),
        url: source.url,
        snippet: source.snippet ? cleanLinkupText(source.snippet) : undefined,
      })),
    };
    const effect = await cacheEffect("linkup-grounding", input, grounding, false, {
      world,
      role: "researcher",
    });
    return { grounding, effect };
  } catch (error) {
    await cacheEffect(
      "linkup-grounding-error",
      input,
      { message: error instanceof Error ? error.message : String(error) },
      false,
      { world, role: "researcher" },
    );
    throw error;
  }
}

async function synthesizeVoice(text: string, voiceName: string): Promise<Buffer> {
  if (!gemini) {
    throw new Error("GEMINI_API_KEY is not configured");
  }

  const input = { text, voiceName, model: geminiTtsModel, vertexai: geminiVertexai };
  const cached = await getCachedEffect<{
    wavBase64: string;
    mimeType: string;
    sourceMimeType: string;
  }>("gemini-tts", input);
  if (cached) {
    return Buffer.from(cached.output.wavBase64, "base64");
  }

  const response = await gemini.models.generateContent({
    model: geminiTtsModel,
    contents: [{ role: "user", parts: [{ text }] }],
    config: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName },
        },
      },
    },
  });
  const audioPart = response.candidates?.[0]?.content?.parts?.find(
    (part) => Boolean(part.inlineData?.data),
  );
  const encodedAudio = audioPart?.inlineData?.data;
  if (!encodedAudio) {
    throw new Error("Gemini TTS returned no audio data");
  }

  const sourceMimeType = audioPart.inlineData?.mimeType ?? "audio/l16; rate=24000; channels=1";
  const pcm = Buffer.from(encodedAudio, "base64");
  const wav = pcmToWav(pcm, parsePcmAudioMime(sourceMimeType));
  await cacheEffect(
    "gemini-tts",
    input,
    {
      mimeType: "audio/wav",
      sourceMimeType,
      wavBase64: wav.toString("base64"),
    },
    false,
  );
  return wav;
}

function parsePcmAudioMime(mimeType: string) {
  const rate = Number(/rate=(\d+)/i.exec(mimeType)?.[1] ?? 24000);
  const channels = Number(/channels=(\d+)/i.exec(mimeType)?.[1] ?? 1);
  return {
    sampleRate: Number.isFinite(rate) ? rate : 24000,
    channels: Number.isFinite(channels) ? channels : 1,
    sampleWidth: 2,
  };
}

function pcmToWav(
  pcm: Buffer,
  {
    sampleRate,
    channels,
    sampleWidth,
  }: { sampleRate: number; channels: number; sampleWidth: number },
) {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * sampleWidth;
  const blockAlign = channels * sampleWidth;

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(sampleWidth * 8, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

async function getCachedEffect<T>(kind: string, input: object) {
  const key = effectKey(kind, input);
  if (redis.client && redis.connected) {
    const cached = await redis.client.get(`signal:effect:${key}`);
    if (cached) {
      await markEffectReused(kind, key);
      return { key, output: JSON.parse(cached) as T, reused: true };
    }
  }
  const row = db.prepare("SELECT output FROM effects WHERE key = ?").get(key) as
    | { output: string }
    | undefined;
  if (!row) return null;
  await markEffectReused(kind, key);
  return { key, output: JSON.parse(row.output) as T, reused: true };
}

async function cacheEffect(
  kind: string,
  input: object,
  output: unknown,
  reused: boolean,
  meta: { world?: WorldId; tx?: number; role?: AgentRole } = {},
): Promise<EffectUse> {
  const key = effectKey(kind, input);
  const encodedOutput = JSON.stringify(output);
  db.prepare(
    `INSERT INTO effects (key, kind, input, output, reused, created_at, world, tx, reused_tx, role)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       kind = excluded.kind,
       input = excluded.input,
       output = excluded.output,
       reused = CASE WHEN effects.reused = 1 OR excluded.reused = 1 THEN 1 ELSE 0 END,
       world = COALESCE(excluded.world, effects.world),
       tx = COALESCE(effects.tx, excluded.tx),
       reused_tx = COALESCE(effects.reused_tx, excluded.reused_tx),
       role = COALESCE(excluded.role, effects.role)`,
  ).run(
    key,
    kind,
    JSON.stringify(input),
    encodedOutput,
    reused ? 1 : 0,
    new Date().toISOString(),
    meta.world ?? null,
    meta.tx ?? null,
    reused && meta.tx ? meta.tx : null,
    meta.role ?? null,
  );
  if (redis.client && redis.connected) {
    await redis.client.set(`signal:effect:${key}`, encodedOutput);
  }
  await writeRedisStream("effect", { kind, key, reused });
  return { key, reused, role: meta.role };
}

async function markEffectReused(kind: string, key: string) {
  db.prepare("UPDATE effects SET reused = 1 WHERE key = ?").run(key);
  await writeRedisStream("effect", { kind, key, reused: true });
}

async function annotateEffectUses(effects: EffectUse[], world: WorldId, tx: number) {
  if (!effects.length) return;
  const statement = db.prepare(
    `UPDATE effects
     SET world = COALESCE(world, ?),
         tx = COALESCE(tx, ?),
         role = COALESCE(role, ?),
         reused_tx = CASE
           WHEN ? = 1 THEN COALESCE(reused_tx, ?)
           ELSE reused_tx
         END
     WHERE key = ?`,
  );
  for (const effect of effects) {
    statement.run(world, tx, effect.role ?? null, effect.reused ? 1 : 0, tx, effect.key);
  }
}

function effectKey(kind: string, input: object) {
  return createHash("sha256").update(`${kind}:${JSON.stringify(input)}`).digest("hex");
}

function hostname(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function cleanLinkupText(text: string) {
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

function cleanGrounding(grounding: Grounding): Grounding {
  return {
    ...grounding,
    answer: cleanLinkupText(grounding.answer),
    sources: grounding.sources.map((source) => ({
      ...source,
      title: cleanLinkupText(source.title),
      snippet: source.snippet ? cleanLinkupText(source.snippet) : undefined,
    })),
  };
}

async function remember(world: WorldId, tx: number, key: string, value: string) {
  const memory = { ...(redis.memory.get(world) ?? {}), [key]: value };
  redis.memory.set(world, memory);
  await cacheEffect(
    "curator-memory",
    { world, key },
    {
      value,
      provider: "redis-hash",
    },
    false,
    { world, tx, role: "curator" },
  );
  if (!redis.client || !redis.connected) return;
  await redis.client.hSet(`signal:memory:${world}`, key, value);
  await writeRedisStream("memory", { world, key, value });
  await redis.client.publish("signal:events", JSON.stringify({ world, type: "memory", key, value }));
}

async function retrieveMemoryContext(world: WorldId, prompt: string): Promise<MemoryContext | undefined> {
  const localMemory = redis.memory.get(world) ?? {};
  const memories = Object.entries(localMemory).map(([key, value]) => `${key}=${value}`);
  if (!memories.length) return undefined;

  const effect = await cacheEffect(
    "builder-memory",
    { world, prompt, provider: "redis-hash" },
    { provider: "redis-hash", memories },
    false,
    { world, role: "builder" },
  );
  const context: MemoryContext = { provider: "redis-hash", memories, effects: [effect] };
  return context;
}

async function hydrateRedisMemory() {
  if (!redis.client || !redis.connected) return;
  for (const world of worlds) {
    const values = await redis.client.hGetAll(`signal:memory:${world}`);
    if (Object.keys(values).length) {
      redis.memory.set(world, values);
    }
  }
}

async function clearRedisNamespace() {
  if (!redis.client || !redis.connected) return;
  try {
    const effectKeys = await redis.client.keys("signal:effect:*");
    const keys = [
      "signal:memory:world-a",
      "signal:memory:world-b",
      "signal:stream",
      ...effectKeys,
    ];
    if (keys.length) await redis.client.del(keys);
  } catch (error) {
    console.warn("[redis] reset cleanup skipped:", error instanceof Error ? error.message : error);
  }
}

async function writeRedisStream(event: string, payload: object) {
  if (!redis.client || !redis.connected) return;
  try {
    await redis.client.xAdd("signal:stream", "*", {
      event,
      payload: JSON.stringify(payload),
      at: new Date().toISOString(),
    });
  } catch (error) {
    console.warn("[redis] stream write skipped:", error instanceof Error ? error.message : error);
  }
}

function broadcast(world: WorldId, state: WorldState) {
  const clients = sseClients.get(world);
  if (!clients) return;
  const dead: ReadableStreamDefaultController[] = [];
  for (const controller of clients) {
    try {
      writeSse(controller, "state", state);
    } catch {
      dead.push(controller);
    }
  }
  for (const controller of dead) {
    clients.delete(controller);
  }
}

function writeSse(controller: ReadableStreamDefaultController, event: string, data: unknown) {
  const encoded = new TextEncoder().encode(
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
  );
  controller.enqueue(encoded);
}

function parseWorld(value: string | undefined): WorldId {
  return value && isWorldId(value) ? value : "world-a";
}

function parseOptionalInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : undefined;
}

function summarize(prompt: string) {
  return prompt.length > 48 ? `${prompt.slice(0, 45)}...` : prompt;
}

function shouldGroundPrompt(
  prompt: string,
  intent: Extract<SignalPacket, { type: "renderWidget" }>["intent"],
) {
  if (intent === "competitors" || intent === "research") return true;
  const normalized = prompt.toLowerCase();
  return [
    "research",
    "source",
    "sources",
    "cite",
    "citation",
    "web",
    "search",
    "lookup",
    "look up",
    "latest",
    "current",
    "news",
    "market",
    "compare",
    "comparison",
    "vendor",
    "vendors",
    "alternative",
    "alternatives",
  ].some((term) => normalized.includes(term));
}

function preferenceHintsFromPrompt(prompt: string): Array<{ key: keyof WorldPreferences; value: string }> {
  const normalized = prompt.toLowerCase();
  const hints: Array<{ key: keyof WorldPreferences; value: string }> = [];

  if (normalized.includes("table") || normalized.includes("rows")) {
    hints.push({ key: "presentation", value: "table" });
  } else if (normalized.includes("brief") || normalized.includes("terse")) {
    hints.push({ key: "presentation", value: "brief" });
  } else if (normalized.includes("visual") || normalized.includes("chart")) {
    hints.push({ key: "presentation", value: "visual" });
  }

  if (normalized.includes("calm") || normalized.includes("calmer")) {
    hints.push({ key: "tone", value: "calm" });
  } else if (normalized.includes("sharp") || normalized.includes("bold")) {
    hints.push({ key: "tone", value: "sharp" });
  }

  if (normalized.includes("cloth") || normalized.includes("fabric")) {
    hints.push({ key: "renderer", value: "fabric" });
  } else if (normalized.includes("voice") || normalized.includes("narrate") || normalized.includes("speak")) {
    hints.push({ key: "renderer", value: "voice" });
  } else if (normalized.includes("dom") || normalized.includes("normal renderer")) {
    hints.push({ key: "renderer", value: "dom" });
  }

  if (normalized.includes("ledger component")) {
    hints.push({ key: "component", value: "ledger" });
  } else if (normalized.includes("brief component") || normalized.includes("custom")) {
    hints.push({ key: "component", value: "brief" });
  } else if (normalized.includes("crystal component")) {
    hints.push({ key: "component", value: "crystal" });
  }

  return hints;
}

function normalizeGeminiSignal(
  parsed: Partial<SignalPacket>,
  prompt: string,
): SignalPacket {
  if (parsed.type === "renderWidget" && isRenderIntent(parsed.intent)) {
    return { type: "renderWidget", intent: parsed.intent, prompt };
  }

  if (parsed.type !== "setPreference" || !parsed.key || typeof parsed.value !== "string") {
    throw new Error(`Gemini returned an invalid Signal packet: ${JSON.stringify(parsed)}`);
  }

  if (parsed.key === "presentation" && isPresentation(parsed.value)) {
    return { type: "setPreference", key: parsed.key, value: parsed.value, prompt };
  }
  if (parsed.key === "tone" && isTone(parsed.value)) {
    return { type: "setPreference", key: parsed.key, value: parsed.value, prompt };
  }
  if (parsed.key === "renderer" && isRenderer(parsed.value)) {
    return { type: "setPreference", key: parsed.key, value: parsed.value, prompt };
  }
  if (parsed.key === "component" && isComponent(parsed.value)) {
    return { type: "setPreference", key: parsed.key, value: parsed.value, prompt };
  }

  throw new Error(`Gemini returned an unsupported preference: ${JSON.stringify(parsed)}`);
}

function isRenderIntent(value: unknown): value is Extract<SignalPacket, { type: "renderWidget" }>["intent"] {
  return (
    value === "revenue" ||
    value === "competitors" ||
    value === "research" ||
    value === "pipeline" ||
    value === "summary"
  );
}

function isPresentation(value: string): value is WorldPreferences["presentation"] {
  return value === "visual" || value === "table" || value === "brief";
}

function isTone(value: string): value is WorldPreferences["tone"] {
  return value === "calm" || value === "sharp";
}

function isRenderer(value: string): value is WorldPreferences["renderer"] {
  return value === "dom" || value === "fabric" || value === "voice";
}

function isComponent(value: string): value is WorldPreferences["component"] {
  return value === "crystal" || value === "ledger" || value === "brief";
}

function componentCode(variant: string) {
  const tokens =
    variant === "ledger"
      ? {
          variant,
          accent: "#111114",
          radius: "8px",
          shadow: "0 22px 68px rgba(20,24,32,0.10)",
        }
      : variant === "brief"
        ? {
            variant,
            accent: "#1db36b",
            radius: "10px",
            shadow: "0 30px 76px rgba(20,24,32,0.08)",
          }
        : {
            variant,
            accent: "#1677ff",
            radius: "12px",
            shadow: "0 40px 90px rgba(20,24,32,0.12), 0 8px 24px rgba(20,24,32,0.05)",
          };
  return `export const component = ${JSON.stringify(tokens)};
export default function render(data) {
  return { ...component, title: data.title, subtitle: data.subtitle };
}`;
}
