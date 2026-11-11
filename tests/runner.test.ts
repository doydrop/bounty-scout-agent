import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { PROJECT_ROOT, loadConfig } from "../src/config.js";
import { BudgetedPayer, BudgetLedger } from "../src/kite/budget.js";
import type { KitePayer, PaidRequest, PaidResult } from "../src/kite/types.js";
import { usdToMicro } from "../src/money.js";
import { createRuntime } from "../src/runtime.js";
import { runScout } from "../src/scout/runner.js";
import { FixtureServClient } from "../src/serv/client.js";
import { applyScores } from "../src/scout/scorer.js";
import { scoreSchema, type Plan, type ScoreReport, type Selection } from "../src/serv/schemas.js";
import type { Candidate } from "../src/scout/candidates.js";

function tempConfig(extra: NodeJS.ProcessEnv = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), "scout-run-"));
  return loadConfig(
    { SCOUT_MODE: "dry-run", SCOUT_DATA_DIR: dataDir, SCOUT_BUDGET_USD: "0.25", ...extra },
    { kpassExists: false, loadEnvFile: false, root: PROJECT_ROOT },
  );
}

describe("dry-run scout", () => {
  it("ranks the fixture bounties inside the default $0.25 cap", async () => {
    const config = tempConfig({
      OPENSERV_API_KEY: "sk-test-openserv-not-a-real-key",
    });
    const record = await createRuntime(config).run();
    assert.equal(record.digest.mode, "dry-run");
    assert.equal(usdToMicro(record.digest.budget.spentUsd), 76_000);
    assert.equal(usdToMicro(record.digest.budget.capUsd), 250_000);
    assert.ok(record.digest.budget.spentUsd < record.digest.budget.capUsd);
    assert.equal(record.digest.opportunities.length, 4);
    assert.equal(record.digest.opportunities[0]?.title, "Solana Blinks design sprint");
    assert.equal(record.digest.opportunities[0]?.scores.overall, 8.3);
    assert.deepEqual(
      record.digest.opportunities.map((item) => item.scores.overall),
      [8.3, 7.8, 7.65, 7.1],
    );
    assert.equal(record.digest.dropped.length, 1);
    assert.match(record.digest.dropped[0]?.url ?? "", /claim-sol-bonus/);
    assert.equal(record.digest.dropped[0]?.legitimacy, 2);
    const paid = record.receipts.filter((receipt) => receipt.outcome === "paid");
    const skipped = record.receipts.filter((receipt) => receipt.outcome === "skipped_budget");
    assert.equal(paid.length, 11);
    assert.ok(skipped.some((receipt) => receipt.tool === "answer" && receipt.errorCode === "planner_rejected"));
    assert.equal(paid.some((receipt) => receipt.tool === "answer"), false);
    assert.equal(new Set(record.receipts.map((receipt) => receipt.idempotencyKey)).size, record.receipts.length);
    assert.equal(paid.some((receipt) => receipt.url.includes("javascript:")), false);
    assert.ok(paid.some((receipt) => receipt.txReference === "dryrun:search-lite"));
    assert.equal(record.receipts.at(-1)?.spentTotal, "0.076");
    const saved = JSON.parse(readFileSync(path.join(config.dataDir, "last-digest.json"), "utf8"));
    assert.equal(JSON.stringify(saved).includes("sk-test-openserv-not-a-real-key"), false);
    const urls = record.digest.opportunities.map((item) => item.url);
    assert.equal(new Set(urls).size, urls.length);
  });

  it("spends nothing when the first estimate would break a tiny cap", async () => {
    const config = tempConfig({ SCOUT_BUDGET_USD: "0.25", KITE_MAX_AMOUNT_PER_TX: "0.05" });
    const calls: string[] = [];
    const ledger = BudgetLedger.fromUsd(0.015, 0.05, 0.01);
    const inner: KitePayer = {
      async remainingBudgetUsd() {
        return ledger.remainingUsd();
      },
      async execute(req) {
        calls.push(req.url);
        throw new Error("inner payer should not be called");
      },
    };
    const runtime = createRuntime(config);
    const record = await runScout({
      mode: "dry-run",
      servModel: "fixture",
      criteria: { ...config.criteria, budgetUsd: 0.015 },
      serv: runtime.serv,
      payer: new BudgetedPayer(inner, ledger),
      ledger,
      agent402BaseUrl: config.agent402BaseUrl,
      maxSearches: config.maxSearches,
      maxExtracts: config.maxExtracts,
      maxMeta: config.maxMeta,
      maxRenders: config.maxRenders,
      allowAnswer: false,
      slackUsd: 0.01,
      perTxUsd: 0.05,
      hostAllowlist: [],
      timeoutMs: 30_000,
    });
    assert.deepEqual(calls, []);
    assert.equal(record.digest.budget.spentUsd, 0);
    assert.equal(record.digest.opportunities.length, 0);
    assert.ok(record.receipts.every((receipt) => receipt.outcome === "skipped_budget"));
  });
});

function searchBody(url: string) {
  return {
    results: [{ title: "Example bounty", url, description: "Free Solana bounty. 30 minutes. $40." }],
    untrustedContent: true,
  };
}

function scripted(handler: (req: PaidRequest) => { body: unknown; thin?: boolean }): KitePayer & { urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    async remainingBudgetUsd() {
      return 1;
    },
    async execute(req): Promise<PaidResult> {
      urls.push(req.url);
      const produced = handler(req);
      return {
        ok: true,
        merchantStatus: 200,
        body: produced.body,
        raw: null,
        receipt: {
          id: `rct_${urls.length}`,
          ts: new Date().toISOString(),
          tool: "pending",
          url: req.url,
          method: req.method,
          idempotencyKey: req.idempotencyKey,
          outcome: "paid",
          paidAmount: "0.01",
          merchantStatus: 200,
        },
      };
    },
  };
}

describe("runner guards", () => {
  it("does not pay for an invented URL, disables answer, and renders a thin extract once", async () => {
    const page = "https://example.com/bounty";
    const plan: Plan = {
      rationale: "Search once.",
      maxPaidUsd: 0.25,
      calls: [
        {
          tool: "answer",
          reason: "tempting",
          query: "what bounties are open",
          count: 1,
          freshness: "",
          country: "",
          url: "",
        },
        {
          tool: "search",
          reason: "discover",
          query: "solana bounty",
          count: 5,
          freshness: "pw",
          country: "",
          url: "",
        },
      ],
      rejected: [],
    };
    const selection: Selection = {
      rationale: "Read the real URL only.",
      meta: [{ url: page, reason: "check", worthPaying: true }],
      extract: [
        { url: "https://evil.example/phish", reason: "model invented this", worthPaying: true },
        { url: page, reason: "read", worthPaying: true },
      ],
      rejected: [],
    };
    const score: ScoreReport = scoreSchema.parse({
      summary: "One listing.",
      items: [
        {
          url: page,
          title: "Example bounty",
          summary: "A short free bounty.",
          chain: "solana",
          category: "gigs",
          rewardText: "$40",
          rewardUsdEstimate: 40,
          entryCostText: "free",
          deadline: "2026-11-20",
          effortMinutesEstimate: 20,
          scores: { effort: 8, cost: 10, reward: 5, deadline: 7, legitimacy: 8 },
          rationale: "Fits the cap.",
        },
      ],
    });
    const payer = scripted((req) => {
      if (req.url.includes("/api/search?")) return { body: searchBody(page) };
      if (req.url.includes("/api/meta")) return { body: { title: "Example bounty", description: "Free." } };
      if (req.url.includes("/api/extract")) return { body: { title: "Example bounty", markdown: "   " } };
      if (req.url.includes("/api/render")) {
        return {
          body: {
            title: "Example bounty",
            markdown: "A real bounty worth forty dollars with a deadline next week and free entry.",
          },
        };
      }
      throw new Error(`unexpected ${req.url}`);
    });
    const ledger = BudgetLedger.fromUsd(0.25, 0.05, 0.01);
    const record = await runScout({
      mode: "dry-run",
      servModel: "fixture",
      criteria: {
        chains: ["solana"],
        entryCost: "free_or_gas",
        categories: ["gigs"],
        maxEffortMinutes: 30,
        budgetUsd: 0.25,
      },
      serv: new FixtureServClient({ scout_plan: plan, scout_select: selection, scout_score: score }),
      payer: new BudgetedPayer(payer, ledger),
      ledger,
      agent402BaseUrl: "https://agent402.tools",
      maxSearches: 8,
      maxExtracts: 8,
      maxMeta: 8,
      maxRenders: 1,
      allowAnswer: false,
      slackUsd: 0.01,
      perTxUsd: 0.05,
      hostAllowlist: [],
      timeoutMs: 30_000,
    });
    assert.equal(payer.urls.some((url) => url.includes("/api/answer")), false);
    assert.equal(payer.urls.some((url) => url.includes("evil.example")), false);
    assert.equal(payer.urls.filter((url) => url.includes("/api/render")).length, 1);
    assert.ok(record.receipts.some((receipt) => receipt.errorCode === "answer_disabled"));
    assert.ok(record.receipts.some((receipt) => receipt.errorCode === "not_in_results"));
    assert.equal(record.digest.opportunities.length, 1);
    assert.equal(record.digest.opportunities[0]?.scores.overall, 7.4);
  });

  it("drops legitimacy below 4 even when the other scores are high", () => {
    const candidate: Candidate = {
      url: "https://example.com/scam",
      sourceHost: "example.com",
      title: "Scam",
      snippet: "send sol",
      fromTools: ["search"],
      receiptIds: ["rct_1"],
    };
    const report = scoreSchema.parse({
      summary: "Dropped.",
      items: [
        {
          url: candidate.url,
          title: "Scam",
          summary: "Upfront payment.",
          chain: "solana",
          category: "other",
          rewardText: "50 SOL",
          rewardUsdEstimate: null,
          entryCostText: "send 0.5 SOL",
          deadline: "",
          effortMinutesEstimate: 1,
          scores: { effort: 10, cost: 1, reward: 10, deadline: 10, legitimacy: 3 },
          rationale: "Scam pattern.",
        },
      ],
    });
    const applied = applyScores([candidate], report);
    assert.equal(applied.opportunities.length, 0);
    assert.equal(applied.dropped[0]?.legitimacy, 3);
  });
});
