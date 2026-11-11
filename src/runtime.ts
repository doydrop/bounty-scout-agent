import path from "node:path";
import { BudgetedPayer, BudgetLedger, runCapUsd } from "./kite/budget.js";
import { PassportHttpPayer } from "./kite/http.js";
import { KpassCliPayer, listActiveSessions } from "./kite/kpass.js";
import { FixturePayer, loadDryRunFixture } from "./kite/mock.js";
import { accountingFromSessionPayload } from "./kite/parse.js";
import { activateStoredSession } from "./kite/session-store.js";
import { usdToMicro } from "./money.js";
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

async function liveSessionNumbers(config: AppConfig, userBudgetUsd: number): Promise<{
  capUsd: number;
  sessionMaxUsd: number;
  sessionSpentUsd: number;
}> {
  let spent = 0;
  let max = config.kiteMaxTotal;
  if (config.mode === "live" && config.kiteSessionId && config.kitePayer === "kpass") {
    try {
      const listed = await listActiveSessions({ bin: config.kpassBin, cwd: config.kpassCwd });
      const accounting = accountingFromSessionPayload(listed, config.kiteSessionId);
      if (accounting.spentUsd !== undefined) spent = accounting.spentUsd;
      if (accounting.maxTotalUsd !== undefined) max = accounting.maxTotalUsd;
    } catch {
      // A list failure must not change the cap. Unpaid receipts are not a spend source.
    }
  }
  const ceiling = Math.min(userBudgetUsd, max);
  return { capUsd: ceiling, sessionMaxUsd: max, sessionSpentUsd: Math.min(spent, max) };
}

export function createRuntime(config: AppConfig): Runtime {
  const serv = makeServ(config);
  return {
    config,
    serv,
    async run(overrides, signal, onReceipt) {
      if (config.mode === "live") {
        const activated = await activateStoredSession({
          dataDir: config.dataDir,
          bin: config.kpassBin,
          cwd: config.kpassCwd,
          fallbackSessionId: config.kiteSessionId,
        });
        if (activated.sessionId) config.kiteSessionId = activated.sessionId;
        try {
          assertLiveRunReady(config);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(`${message} If approval already happened, run: pnpm scout session status`);
        }
      }
      const criteria = criteriaFrom(config, overrides);
      const numbers = await liveSessionNumbers(config, criteria.budgetUsd);
      if (numbers.capUsd - numbers.sessionSpentUsd <= 0) {
        throw new Error("The Passport session has no remaining budget. usage.spent_total has reached the session max.");
      }
      const perTxUsd = Math.min(config.kiteMaxPerTx, numbers.capUsd);
      const ledger = BudgetLedger.fromUsd(numbers.capUsd, perTxUsd, config.slackUsd);
      if (numbers.sessionSpentUsd > 0) ledger.spentMicro = usdToMicro(numbers.sessionSpentUsd);
      const sessionId = config.mode === "dry-run" ? config.kiteSessionId ?? "sess_dry_run" : config.kiteSessionId;
      const payer = new BudgetedPayer(makeInner(config, sessionId ?? "", numbers.capUsd), ledger, { sessionId });
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
        sessionMaxUsd: numbers.sessionMaxUsd,
        timeoutMs: config.runTimeoutMs,
        signal,
        onReceipt,
      });
      saveRun(config.dataDir, record);
      return record;
    },
  };
}
