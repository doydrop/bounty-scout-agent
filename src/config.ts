import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BountyCategory, EntryCost, ScoutCriteria } from "./types.js";

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const CATEGORIES: readonly BountyCategory[] = ["contest", "creative", "defi", "gigs"];
const EFFORTS = ["none", "low", "medium", "high"] as const;

export type ReasoningEffort = (typeof EFFORTS)[number];
export type RunMode = "dry-run" | "live";

export interface AppConfig {
  mode: RunMode;
  servApiKey?: string;
  servBaseUrl: string;
  servModel: string;
  reasoningEffort: ReasoningEffort;
  kpassBin: string;
  kpassExists: boolean;
  /** Working directory for every kpass spawn. Holds `.kite-passport/`. */
  kpassCwd: string;
  kiteBaseUrl: string;
  kiteSessionId?: string;
  kiteMaxPerTx: number;
  kiteMaxTotal: number;
  kiteTtl: string;
  kiteAssets: string;
  kitePayer: "kpass" | "http";
  kiteAgentToken?: string;
  agent402BaseUrl: string;
  criteria: ScoutCriteria;
  maxSearches: number;
  maxExtracts: number;
  maxMeta: number;
  maxRenders: number;
  allowAnswer: boolean;
  slackUsd: number;
  hostAllowlist: string[];
  runTimeoutMs: number;
  port: number;
  host: string;
  dataDir: string;
  fixturesDir: string;
  dryRunDelayMs: number;
  root: string;
}

export function applyEnvFile(text: string, into: NodeJS.ProcessEnv): void {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (into[key] !== undefined && into[key] !== "") continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    into[key] = value;
  }
}

export function commandExists(bin: string): boolean {
  try {
    const result = spawnSync(bin, ["--version"], {
      stdio: "ignore",
      shell: false,
      timeout: 5000,
      windowsHide: true,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

export function resolveMode(env: NodeJS.ProcessEnv, kpassExists: boolean): RunMode {
  const requested = (env.SCOUT_MODE ?? "auto").trim().toLowerCase();
  const hasKey = Boolean(env.OPENSERV_API_KEY?.trim() || env.SERV_API_KEY?.trim());
  const httpPayer = (env.KITE_PAYER ?? "kpass").trim().toLowerCase() === "http";
  const hasHttpToken = Boolean(env.KITE_AGENT_TOKEN?.trim());

  if (requested === "dry-run" || requested === "dryrun") return "dry-run";
  if (requested === "live") {
    const missing: string[] = [];
    if (!hasKey) missing.push("OPENSERV_API_KEY or SERV_API_KEY");
    if (httpPayer) {
      if (!hasHttpToken) missing.push("KITE_AGENT_TOKEN");
    } else if (!kpassExists) {
      missing.push("kpass on PATH");
    }
    if (missing.length) {
      throw new Error(`SCOUT_MODE=live but missing ${missing.join(" and ")}.`);
    }
    return "live";
  }
  if (requested !== "auto" && requested !== "") {
    throw new Error(`Unknown SCOUT_MODE "${requested}". Use auto, dry-run, or live.`);
  }
  if (hasKey && kpassExists) return "live";
  return "dry-run";
}

function resolveKpassCwd(value: string | undefined, root: string): string {
  const trimmed = value?.trim();
  if (!trimmed) return root;
  return path.resolve(root, trimmed);
}

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`Expected a number, received "${value}"`);
  return n;
}

function int(value: string | undefined, fallback: number): number {
  const n = num(value, fallback);
  if (!Number.isInteger(n)) throw new Error(`Expected an integer, received "${value}"`);
  return n;
}

export function parseCategories(value: string | undefined): BountyCategory[] {
  const raw = (value ?? "contest,creative,defi,gigs")
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  if (!raw.length) return ["contest", "creative", "defi", "gigs"];
  const out: BountyCategory[] = [];
  for (const part of raw) {
    if (!CATEGORIES.includes(part as BountyCategory)) {
      throw new Error(`Unknown category "${part}". Use ${CATEGORIES.join(", ")}.`);
    }
    if (!out.includes(part as BountyCategory)) out.push(part as BountyCategory);
  }
  return out;
}

export function parseChains(value: string | undefined): string[] {
  const chains = (value ?? "solana")
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  return chains.length ? chains : ["solana"];
}

export function parseEntryCost(value: string | undefined): EntryCost {
  const raw = (value ?? "free_or_gas").trim().toLowerCase().replace(/-/g, "_");
  if (raw === "free_or_gas" || raw === "free" || raw === "gas") return "free_or_gas";
  if (raw === "any" || raw === "paid") return "any";
  throw new Error(`Unknown entry cost "${value}". Use free_or_gas or any.`);
}

function readSessionId(dataDir: string, env: NodeJS.ProcessEnv): string | undefined {
  const fromEnv = env.KITE_SESSION_ID?.trim();
  if (fromEnv) return fromEnv;
  const file = path.join(dataDir, "session.json");
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { sessionId?: unknown };
    return typeof parsed.sessionId === "string" && parsed.sessionId.trim()
      ? parsed.sessionId.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

export interface LoadConfigOptions {
  kpassExists?: boolean;
  root?: string;
  loadEnvFile?: boolean;
}

export function loadConfig(
  source: NodeJS.ProcessEnv = process.env,
  options: LoadConfigOptions = {},
): AppConfig {
  const root = options.root ?? PROJECT_ROOT;
  const merged: NodeJS.ProcessEnv = { ...source };
  const loadEnvFile = options.loadEnvFile ?? source === process.env;
  if (loadEnvFile) {
    const envPath = path.join(root, ".env");
    if (existsSync(envPath)) applyEnvFile(readFileSync(envPath, "utf8"), merged);
  }

  const kpassBin = (merged.KPASS_BIN ?? "kpass").trim() || "kpass";
  const kpassExists = options.kpassExists ?? commandExists(kpassBin);
  const mode = resolveMode(merged, kpassExists);
  const dataDir = path.resolve(root, merged.SCOUT_DATA_DIR ?? "data");
  const fixturesDir = path.resolve(root, merged.SCOUT_FIXTURES_DIR ?? "fixtures");
  const budgetUsd = num(merged.SCOUT_BUDGET_USD, 0.25);
  const perTx = num(merged.KITE_MAX_AMOUNT_PER_TX, 0.05);
  const sessionTotal = num(merged.KITE_MAX_TOTAL_AMOUNT, 0.25);
  const slackUsd = num(merged.SCOUT_SLACK_USD, 0.01);
  if (budgetUsd <= 0) throw new Error("SCOUT_BUDGET_USD must be greater than 0.");
  if (budgetUsd > 100) throw new Error("SCOUT_BUDGET_USD above 100 is refused. Set a smaller cap.");
  if (perTx <= 0 || perTx > budgetUsd) {
    throw new Error("KITE_MAX_AMOUNT_PER_TX must be > 0 and not above the run budget.");
  }
  if (slackUsd < 0) throw new Error("SCOUT_SLACK_USD cannot be negative.");

  const effort = (merged.SERV_REASONING_EFFORT ?? "low").trim().toLowerCase();
  if (!EFFORTS.includes(effort as ReasoningEffort)) {
    throw new Error(`SERV_REASONING_EFFORT must be one of ${EFFORTS.join(", ")}.`);
  }

  const payerRaw = (merged.KITE_PAYER ?? "kpass").trim().toLowerCase();
  if (payerRaw !== "kpass" && payerRaw !== "http") {
    throw new Error('KITE_PAYER must be "kpass" or "http".');
  }

  const openserv = merged.OPENSERV_API_KEY?.trim();
  const serv = merged.SERV_API_KEY?.trim();
  const allowlist = (merged.SCOUT_HOST_ALLOWLIST ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);

  return {
    mode,
    servApiKey: openserv || serv || undefined,
    servBaseUrl: (merged.SERV_BASE_URL ?? "https://inference-api.openserv.ai/v1").replace(/\/$/, ""),
    servModel: (merged.SERV_MODEL ?? "gpt-5.4-mini").trim(),
    reasoningEffort: effort as ReasoningEffort,
    kpassBin,
    kpassExists,
    kpassCwd: resolveKpassCwd(merged.KPASS_CWD, root),
    kiteBaseUrl: (merged.KITE_PASSPORT_BASE_URL ?? "https://passport.prod.gokite.ai").replace(/\/$/, ""),
    kiteSessionId: readSessionId(dataDir, merged),
    kiteMaxPerTx: perTx,
    kiteMaxTotal: sessionTotal,
    kiteTtl: (merged.KITE_SESSION_TTL ?? "1h").trim(),
    kiteAssets: (merged.KITE_ASSETS ?? "USDC").trim(),
    kitePayer: payerRaw,
    kiteAgentToken: merged.KITE_AGENT_TOKEN?.trim() || undefined,
    agent402BaseUrl: (merged.AGENT402_BASE_URL ?? "https://agent402.tools").replace(/\/$/, ""),
    criteria: {
      chains: parseChains(merged.SCOUT_CHAINS),
      entryCost: parseEntryCost(merged.SCOUT_ENTRY_COST),
      categories: parseCategories(merged.SCOUT_CATEGORIES),
      maxEffortMinutes: int(merged.SCOUT_MAX_EFFORT_MIN, 30),
      budgetUsd,
      extraNotes: merged.SCOUT_NOTES?.trim() || undefined,
    },
    maxSearches: int(merged.SCOUT_MAX_SEARCHES, 8),
    maxExtracts: int(merged.SCOUT_MAX_EXTRACTS, 8),
    maxMeta: int(merged.SCOUT_MAX_META, 8),
    maxRenders: int(merged.SCOUT_MAX_RENDERS, 1),
    allowAnswer: (merged.SCOUT_ALLOW_ANSWER ?? "false").trim().toLowerCase() === "true",
    slackUsd,
    hostAllowlist: allowlist,
    runTimeoutMs: int(merged.SCOUT_RUN_TIMEOUT_MS, 480_000),
    port: int(merged.PORT, 8787),
    host: (merged.HOST ?? "127.0.0.1").trim(),
    dataDir,
    fixturesDir,
    dryRunDelayMs: int(merged.SCOUT_DRY_RUN_DELAY_MS, 0),
    root,
  };
}

export function assertLiveRunReady(config: AppConfig): void {
  if (config.mode !== "live") return;
  if (!config.servApiKey) {
    throw new Error("Live mode needs OPENSERV_API_KEY or SERV_API_KEY.");
  }
  if (!config.kiteSessionId || config.kiteSessionId === "sess_dry_run") {
    throw new Error(
      "Live mode needs an approved Kite session. Set KITE_SESSION_ID or run: pnpm scout session create",
    );
  }
  if (config.kitePayer === "http" && !config.kiteAgentToken) {
    throw new Error("KITE_PAYER=http needs KITE_AGENT_TOKEN. The HTTP API is experimental.");
  }
  if (config.kitePayer === "kpass" && !config.kpassExists) {
    throw new Error(`Live mode needs the kpass binary ("${config.kpassBin}") on PATH.`);
  }
}
