import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { AppConfig } from "../config.js";
import { parseCategories, parseChains, parseEntryCost } from "../config.js";
import { createRuntime, type RunOverrides } from "../runtime.js";
import { loadLastRun } from "../scout/digest.js";
import { errorMessage } from "../secrets.js";
import { TOOL_CATALOG } from "../tools/catalog.js";
import type { Digest, SpendReceipt } from "../types.js";

interface ServerState {
  running: boolean;
  error?: string;
  digest?: Digest;
  receipts: SpendReceipt[];
  stoppedReason?: string;
}

function overridesFrom(body: unknown): RunOverrides {
  if (!body || typeof body !== "object") return {};
  const record = body as Record<string, unknown>;
  const overrides: RunOverrides = {};
  if (typeof record.chains === "string") overrides.chains = parseChains(record.chains);
  else if (Array.isArray(record.chains)) overrides.chains = parseChains(record.chains.join(","));
  if (typeof record.entryCost === "string") overrides.entryCost = parseEntryCost(record.entryCost);
  if (typeof record.categories === "string") overrides.categories = parseCategories(record.categories);
  else if (Array.isArray(record.categories)) overrides.categories = parseCategories(record.categories.join(","));
  if (record.maxEffortMinutes !== undefined && record.maxEffortMinutes !== "") {
    const n = Number(record.maxEffortMinutes);
    if (!Number.isInteger(n) || n <= 0 || n > 24 * 60) throw new Error("maxEffortMinutes must be a positive integer.");
    overrides.maxEffortMinutes = n;
  }
  if (record.budgetUsd !== undefined && record.budgetUsd !== "") {
    overrides.budgetUsd = Number(record.budgetUsd);
  }
  if (typeof record.extraNotes === "string" && record.extraNotes.trim()) {
    overrides.extraNotes = record.extraNotes.trim().slice(0, 500);
  }
  return overrides;
}

export function createApp(config: AppConfig): Hono {
  const runtime = createRuntime(config);
  const html = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
  const saved = loadLastRun(config.dataDir);
  const state: ServerState = {
    running: false,
    digest: saved?.digest,
    receipts: saved?.receipts ?? [],
    stoppedReason: saved?.stoppedReason,
  };
  let abort: AbortController | null = null;
  const secrets = [config.servApiKey, config.kiteAgentToken].filter((value): value is string => Boolean(value));

  const snapshot = () => ({
    mode: config.mode,
    running: state.running,
    error: state.error ?? null,
    digest: state.digest ?? null,
    receipts: state.receipts,
    stoppedReason: state.stoppedReason ?? state.digest?.stoppedReason ?? null,
    criteria: state.digest?.criteria ?? config.criteria,
    budget: state.digest?.budget ?? {
      capUsd: Math.min(config.criteria.budgetUsd, config.kiteMaxTotal),
      sessionCapUsd: Math.min(config.criteria.budgetUsd, config.kiteMaxTotal),
      spentUsd: 0,
      remainingUsd: Math.min(config.criteria.budgetUsd, config.kiteMaxTotal),
      perTxCapUsd: Math.min(config.kiteMaxPerTx, config.criteria.budgetUsd),
      slackUsd: config.slackUsd,
    },
    catalog: TOOL_CATALOG.map((tool) => ({
      id: tool.id,
      method: tool.method,
      path: tool.path,
      listPriceUsd: tool.listPriceUsd,
      description: tool.description,
      defaultAllow: tool.defaultAllow,
    })),
    servModel: config.servModel,
  });

  const app = new Hono();
  app.use("*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });
  app.get("/api/health", (c) => c.json({ ok: true, mode: config.mode }));
  app.get("/api/state", (c) => c.json(snapshot()));
  app.get("/api/digest", (c) => c.json({ digest: state.digest ?? null }));
  app.get("/api/receipts", (c) => c.json({ receipts: state.receipts }));
  app.post("/api/run", async (c) => {
    if (state.running) return c.json({ error: "A run is already in progress." }, 409);
    let overrides: RunOverrides;
    try {
      overrides = overridesFrom(await c.req.json().catch(() => ({})));
    } catch (err) {
      return c.json({ error: errorMessage(err, secrets) }, 400);
    }
    state.running = true;
    state.error = undefined;
    state.receipts = [];
    abort = new AbortController();
    const controller = abort;
    void runtime
      .run(overrides, controller.signal, (receipt) => {
        state.receipts.push(receipt);
      })
      .then((record) => {
        state.digest = record.digest;
        state.receipts = record.receipts;
        state.stoppedReason = record.stoppedReason;
      })
      .catch((err: unknown) => {
        state.error = errorMessage(err, secrets);
      })
      .finally(() => {
        state.running = false;
        if (abort === controller) abort = null;
      });
    return c.json({ started: true, mode: config.mode }, 202);
  });
  app.post("/api/stop", (c) => {
    abort?.abort();
    return c.json({ stopping: Boolean(abort) });
  });
  app.get("/", (c) => c.html(html));
  return app;
}

export function startServer(config: AppConfig): ReturnType<typeof serve> {
  const app = createApp(config);
  return serve({ fetch: app.fetch, port: config.port, hostname: config.host });
}
