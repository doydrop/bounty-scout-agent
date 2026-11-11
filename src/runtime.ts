import path from "node:path";
import { BudgetedPayer, BudgetLedger } from "./kite/budget.js";
import { PassportHttpPayer } from "./kite/http.js";
import { KpassCliPayer } from "./kite/kpass.js";
import { FixturePayer, loadDryRunFixture } from "./kite/mock.js";
import type { KitePayer } from "./kite/types.js";
import { saveRun } from "./scout/digest.js";
import { runScout } from "./scout/runner.js";
import { FixtureServClient, createLiveServClient, type ServClient } from "./serv/client.js";
import { assertLiveRunReady, type AppConfig } from "./config.js";
import type { BountyCategory, EntryCost, RunRecord, ScoutCriteria, SpendReceipt } from "./types.js";

export interface RunOverrides {
  chains?: string[];
  entryCost?: EntryCost;
  categories?: BountyCategory[];
  maxEffortMinutes?: number;
  budgetUsd?: number;
  extraNotes?: string;
}

export interface Runtime {
  config: AppConfig;
  serv: ServClient;
  run(overrides?: RunOverrides, signal?: AbortSignal, onReceipt?: (receipt: SpendReceipt) => void): Promise<RunRecord>;
}

function criteriaFrom(config: AppConfig, overrides: RunOverrides = {}): ScoutCriteria {
  const budgetUsd = overrides.budgetUsd ?? config.criteria.budgetUsd;
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0 || budgetUsd > 100) {
    throw new Error("Budget must be greater than 0 and at most 100 USD.");
  }
  return {
    chains: overrides.chains?.length ? overrides.chains : config.criteria.chains,
    entryCost: overrides.entryCost ?? config.criteria.entryCost,
    categories: overrides.categories?.length ? overrides.categories : config.criteria.categories,
    maxEffortMinutes: overrides.maxEffortMinutes ?? config.criteria.maxEffortMinutes,
    budgetUsd,
    extraNotes: overrides.extraNotes ?? config.criteria.extraNotes,
  };
}

function makeInner(config: AppConfig, sessionId: string, capUsd: number): KitePayer {
  if (config.mode === "dry-run") {
    const fixture = loadDryRunFixture(path.join(config.fixturesDir, "dry-run", "scout.json"));
    return new FixturePayer(fixture.calls, {
      sessionId,
      capUsd,
      delayMs: config.dryRunDelayMs,
    });
  }
  if (config.kitePayer === "http") {
    console.error(
      "KITE_PAYER=http is experimental. Passport has no public buyer HTTP API; the request shape is unverified.",
    );
    return new PassportHttpPayer({
      baseUrl: config.kiteBaseUrl,
      token: config.kiteAgentToken ?? "",
      sessionId,
      capUsd,
    });
  }
  return new KpassCliPayer({
    bin: config.kpassBin,
    sessionId,
    capUsd,
    cwd: config.kpassCwd,
  });
}

function makeServ(config: AppConfig): ServClient {
  if (config.mode === "dry-run") {
    const fixture = loadDryRunFixture(path.join(config.fixturesDir, "dry-run", "scout.json"));
    return new FixtureServClient(fixture.responses);
  }
  return createLiveServClient(config);
}

export function createRuntime(config: AppConfig): Runtime {
  const serv = makeServ(config);
  return {
    config,
    serv,
    async run(overrides, signal, onReceipt) {
      if (config.mode === "live") assertLiveRunReady(config);
      const criteria = criteriaFrom(config, overrides);
      const capUsd = Math.min(criteria.budgetUsd, config.kiteMaxTotal);
      const perTxUsd = Math.min(config.kiteMaxPerTx, capUsd);
      const ledger = BudgetLedger.fromUsd(capUsd, perTxUsd, config.slackUsd);
      const sessionId = config.mode === "dry-run" ? config.kiteSessionId ?? "sess_dry_run" : config.kiteSessionId;
      const payer = new BudgetedPayer(makeInner(config, sessionId ?? "", capUsd), ledger, { sessionId });
      const record = await runScout({
        mode: config.mode,
        servModel: config.mode === "dry-run" ? `${config.servModel} (fixture)` : config.servModel,
        criteria,
        serv,
        payer,
        ledger,
        agent402BaseUrl: config.agent402BaseUrl,
        sessionId,
        maxSearches: config.maxSearches,
        maxExtracts: config.maxExtracts,
        maxMeta: config.maxMeta,
        maxRenders: config.maxRenders,
        allowAnswer: config.allowAnswer,
        slackUsd: config.slackUsd,
        perTxUsd,
        hostAllowlist: config.hostAllowlist,
        timeoutMs: config.runTimeoutMs,
        signal,
        onReceipt,
      });
      saveRun(config.dataDir, record);
      return record;
    },
  };
}
