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
  defineTool,
} from "@copilotkit/runtime/v2";
import { GoogleGenAI } from "@google/genai";
import { config as loadEnv } from "dotenv";
import { LinkupClient } from "linkup-sdk";
import { createClient, type RedisClientType } from "redis";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import {
  CATALOG_ID,
  CommandSchema,
  SURFACE_ID,
  composeSurface,
  composeScene,
  defaultPreferences,
  isWorldId,
  signalFromPrompt,
  worlds,
  type Grounding,
  type CommandInput,
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

type FactValue = string | number | boolean | object | null;

type ServerRedis = {
  configured: boolean;
  connected: boolean;
  client: RedisClientType | null;
  memory: Map<WorldId, Record<string, string>>;
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
  model: `google/${geminiModel}`,
  apiKey: geminiApiKey,
  maxSteps: 2,
  prompt:
    "You are the Signal UI builder. Convert user requests into one emit_signal tool call. Keep responses terse.",
  tools: [
    defineTool({
      name: "emit_signal",
      description: "Build or personalize the current Signal UI world.",
      parameters: z.object({
        world: z.enum(worlds),
        prompt: z.string(),
      }),
      execute: async ({ world, prompt }) => {
        const receipt = await applyAgentCommand({ world, prompt, source: "copilotkit" });
        return {
          receipt,
          state: getWorldState(world, receipt.tx),
        };
      },
    }),
  ],
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
    gemini: { configured: Boolean(gemini), model: geminiModel, vertexai: geminiVertexai },
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
  return c.json(getFlightRecorder(world));
});

app.post("/api/command", async (c) => {
  const raw = await c.req.json().catch(() => null);
  const parsed = CommandSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: "Invalid command", details: parsed.error.flatten() }, 400);
  }
  const receipt = await applyCommand(parsed.data);
  return c.json(getWorldState(parsed.data.world, receipt.tx));
});

app.post("/api/agent", async (c) => {
  const raw = await c.req.json().catch(() => null);
  const parsed = CommandSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: "Invalid command", details: parsed.error.flatten() }, 400);
  }
  try {
    const receipt = await applyAgentCommand({ ...parsed.data, source: "composer" });
    return c.json(getWorldState(parsed.data.world, receipt.tx));
  } catch (error) {
    return c.json(
      {
        error: "Gemini signal generation failed",
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
  const stream = new ReadableStream({
    start(controller) {
      if (!sseClients.has(world)) sseClients.set(world, new Set());
      sseClients.get(world)!.add(controller);
      writeSse(controller, "state", getWorldState(world));
    },
    cancel(controller) {
      sseClients.get(world)?.delete(controller);
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
  const count = db.prepare("SELECT COUNT(*) AS count FROM txs").get() as { count: number };
  if (count.count > 0) return;

  for (const world of worlds) {
    const prefs = defaultPreferences(world);
    const codeHash = insertComponentBlob(prefs.component);
    const tx = insertTx(world, "Created world");
    insertFact(tx, world, "world", "preferences", prefs);
    insertFact(tx, world, "world", "codePin", codeHash);
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

async function applyCommand(input: CommandInput): Promise<Receipt> {
  return applySignalCommand({
    input,
    signal: signalFromPrompt(input.prompt),
    agent: {
      provider: "heuristic",
      model: "local-signal",
      reused: false,
      grounded: false,
    },
  });
}

async function applyAgentCommand(input: CommandInput): Promise<Receipt> {
  const signalResult = await resolveSignal(input.prompt);
  const grounding =
    signalResult.signal.type === "renderWidget" && signalResult.signal.intent === "competitors"
      ? await resolveGrounding(input.prompt)
      : undefined;
  return applySignalCommand({
    input,
    signal: signalResult.signal,
    grounding,
    agent: {
      provider: signalResult.provider,
      model: signalResult.model,
      reused: signalResult.reused,
      grounded: Boolean(grounding),
    },
  });
}

async function applySignalCommand({
  input,
  signal,
  grounding,
  agent,
}: {
  input: CommandInput;
  signal: SignalPacket;
  grounding?: Grounding;
  agent: NonNullable<WorldState["agent"]>;
}): Promise<Receipt> {
  const current = getWorldState(input.world);
  const nextPrefs = { ...current.preferences };
  const tx = insertTx(input.world, summarize(input.prompt));
  const preferenceChanges: Array<{
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
      await remember(input.world, change.key, change.value);
    }
    if (change.key === "tone" && isTone(change.value)) {
      nextPrefs.tone = change.value;
      await remember(input.world, change.key, change.value);
    }
    if (change.key === "renderer" && isRenderer(change.value)) {
      nextPrefs.renderer = change.value;
      await remember(input.world, change.key, change.value);
    }
    if (change.key === "component" && isComponent(change.value)) {
      nextPrefs.component = change.value;
      const hash = insertComponentBlob(change.value);
      insertFact(tx, input.world, "world", "codePin", hash);
      await remember(input.world, change.key, change.value);
    }
  }

  if (preferenceChanges.length) {
    insertFact(tx, input.world, "world", "preferences", nextPrefs);
  }

  const surface = composeSurface(input.world, nextPrefs, signal, tx, grounding);
  insertFact(tx, input.world, "surface", "current", surface);
  insertFact(tx, input.world, "agent", "last", agent);
  const receipt = insertReceipt(
    tx,
    input.world,
    true,
    preferenceChanges.length ? "MEMORY_LEARNED" : "SURFACE_RENDERED",
    preferenceChanges.length
      ? `Curator learned ${preferenceChanges.map((change) => `${change.key}=${change.value}`).join(", ")}; Builder re-rendered.`
      : "Signal compiled through Loom into A2UI.",
  );
  await writeRedisStream("receipt", {
    world: input.world,
    tx,
    code: receipt.code,
    provider: agent.provider,
    reused: agent.reused,
    grounded: agent.grounded,
  });
  broadcast(input.world, getWorldState(input.world, tx));
  return receipt;
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
  let surface: SignalSurface | null = null;
  let codePin: string | null = null;
  let agent: WorldState["agent"] = null;

  for (const fact of facts) {
    const value = JSON.parse(fact.value) as FactValue;
    if (fact.entity === "world" && fact.attr === "preferences") {
      preferences = { ...preferences, ...(value as Partial<WorldPreferences>) };
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
    agent,
    redis: {
      configured: redis.configured,
      connected: redis.connected,
      memory: redis.memory.get(world) ?? {},
    },
  };
}

function getTimeline(world: WorldId): TimelineItem[] {
  return db
    .prepare("SELECT id AS tx, summary, created_at AS at FROM txs WHERE world = ? ORDER BY id ASC")
    .all(world) as TimelineItem[];
}

function getReceipts(world: WorldId, atTx: number): Receipt[] {
  return db
    .prepare(
      `SELECT tx, accepted, code, message, created_at AS at
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
      "SELECT tx, world, accepted, code, message, created_at AS at FROM receipts WHERE tx = ? ORDER BY rowid ASC",
    )
    .all(tx)
    .map((row) => ({
      ...(row as { accepted: number }),
      accepted: Boolean((row as { accepted: number }).accepted),
    }));
  return { tx: txRow ?? { tx }, facts, receipts };
}

function getFlightRecorder(world: WorldId) {
  const receipts = db
    .prepare(
      `SELECT receipts.tx, receipts.accepted, receipts.code, receipts.message, receipts.created_at AS at, txs.summary
       FROM receipts
       JOIN txs ON txs.id = receipts.tx
       WHERE receipts.world = ?
       ORDER BY receipts.tx DESC
       LIMIT 12`,
    )
    .all(world)
    .map((row) => ({
      ...(row as { accepted: number }),
      accepted: Boolean((row as { accepted: number }).accepted),
    }));
  const effects = db
    .prepare(
      "SELECT kind, input, output, reused, created_at AS at FROM effects ORDER BY created_at DESC LIMIT 12",
    )
    .all()
    .map((row) => ({
      kind: (row as { kind: string }).kind,
      input: JSON.parse((row as { input: string }).input),
      output: JSON.parse((row as { output: string }).output),
      reused: Boolean((row as { reused: number }).reused),
      at: (row as { at: string }).at,
    }));
  return {
    world,
    redis: { connected: redis.connected, memory: redis.memory.get(world) ?? {} },
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
): Receipt {
  const at = new Date().toISOString();
  db.prepare(
    "INSERT INTO receipts (tx, world, accepted, code, message, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(tx, world, accepted ? 1 : 0, code, message, at);
  return { tx, accepted, code, message, at };
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

async function resolveSignal(prompt: string): Promise<{
  signal: SignalPacket;
  provider: "gemini";
  model: string;
  reused: boolean;
}> {
  if (!gemini) {
    throw new Error("GEMINI_API_KEY is not configured");
  }

  const signalCacheInput = { prompt, model: geminiModel, vertexai: geminiVertexai };
  const cached = await getCachedEffect<{ signal: SignalPacket }>("gemini-signal", signalCacheInput);
  if (cached) {
    const signal = normalizeGeminiSignal(cached.output.signal, prompt);
    return {
      signal,
      provider: "gemini",
      model: geminiModel,
      reused: true,
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
                "Allowed render intents: revenue, competitors, pipeline, summary. " +
                "Allowed preferences: presentation=visual|table|brief, tone=calm|sharp, renderer=dom|fabric|voice, component=crystal|ledger|brief. " +
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
            intent: { type: "string", enum: ["revenue", "competitors", "pipeline", "summary"] },
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
    await cacheEffect("gemini-signal", signalCacheInput, { signal }, false);
    return { signal, provider: "gemini", model: geminiModel, reused: false };
  } catch (error) {
    await cacheEffect(
      "gemini-signal-error",
      signalCacheInput,
      { message: error instanceof Error ? error.message : String(error) },
      false,
    );
    throw error;
  }
}

async function resolveGrounding(prompt: string): Promise<Grounding> {
  const input = { prompt };
  const cached = await getCachedEffect<Grounding>("linkup-grounding", input);
  if (cached) return { ...cached.output, reused: true };

  if (!linkup) {
    const fallback: Grounding = fallbackGrounding();
    await cacheEffect("linkup-grounding", input, fallback, false);
    return fallback;
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
      answer: result.answer,
      sources: result.sources.slice(0, 4).map((source) => ({
        title: source.name,
        label: hostname(source.url),
        url: source.url,
        snippet: source.snippet,
      })),
    };
    await cacheEffect("linkup-grounding", input, grounding, false);
    return grounding;
  } catch (error) {
    const fallback: Grounding = {
      ...fallbackGrounding(),
      answer: `LinkUp fallback: ${error instanceof Error ? error.message : "grounding unavailable"}`,
    };
    await cacheEffect("linkup-grounding", input, fallback, false);
    return fallback;
  }
}

function fallbackGrounding(): Grounding {
  return {
    provider: "fallback",
    reused: false,
    answer: "Grounded snapshot from cached demo sources. Add LINKUP_API_KEY for live citations.",
    sources: [
      { title: "Adyen", label: "adyen.com", url: "https://www.adyen.com" },
      { title: "Checkout.com", label: "checkout.com", url: "https://www.checkout.com" },
      { title: "Paddle", label: "paddle.com", url: "https://www.paddle.com" },
    ],
  };
}

async function getCachedEffect<T>(kind: string, input: object) {
  const key = effectKey(kind, input);
  if (redis.client && redis.connected) {
    const cached = await redis.client.get(`signal:effect:${key}`);
    if (cached) return { key, output: JSON.parse(cached) as T };
  }
  const row = db.prepare("SELECT output FROM effects WHERE key = ?").get(key) as
    | { output: string }
    | undefined;
  return row ? { key, output: JSON.parse(row.output) as T } : null;
}

async function cacheEffect(kind: string, input: object, output: unknown, reused: boolean) {
  const key = effectKey(kind, input);
  const encodedOutput = JSON.stringify(output);
  db.prepare(
    "INSERT OR REPLACE INTO effects (key, kind, input, output, reused, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(key, kind, JSON.stringify(input), encodedOutput, reused ? 1 : 0, new Date().toISOString());
  if (redis.client && redis.connected) {
    await redis.client.set(`signal:effect:${key}`, encodedOutput);
  }
  await writeRedisStream("effect", { kind, key, reused });
  return key;
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

async function remember(world: WorldId, key: string, value: string) {
  const memory = { ...(redis.memory.get(world) ?? {}), [key]: value };
  redis.memory.set(world, memory);
  if (!redis.client || !redis.connected) return;
  await redis.client.hSet(`signal:memory:${world}`, key, value);
  await writeRedisStream("memory", { world, key, value });
  await redis.client.publish(
    "signal:events",
    JSON.stringify({ world, type: "memory", key, value }),
  );
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
  for (const controller of clients) {
    try {
      writeSse(controller, "state", state);
    } catch {
      clients.delete(controller);
    }
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
  return value === "revenue" || value === "competitors" || value === "pipeline" || value === "summary";
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
