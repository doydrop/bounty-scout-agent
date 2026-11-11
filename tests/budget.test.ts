import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BudgetedPayer, BudgetLedger, debitMicroForReceipt } from "../src/kite/budget.js";
import type { KitePayer, PaidRequest, PaidResult } from "../src/kite/types.js";
import { PayerError } from "../src/kite/types.js";
import { formatAmount, overallScore, usdToMicro, SCORE_WEIGHTS } from "../src/money.js";
import { blankReceipt } from "../src/kite/budget.js";

function paidResult(req: PaidRequest, outcome: PaidResult["receipt"]["outcome"], amount?: string): PaidResult {
  return {
    ok: outcome === "paid" || outcome === "replayed",
    merchantStatus: outcome === "paid" ? 200 : 500,
    body: { ok: true },
    raw: null,
    receipt: {
      ...blankReceipt({
        tool: "search",
        url: req.url,
        method: req.method,
        outcome,
        idempotencyKey: req.idempotencyKey,
        listPriceUsd: 0.01,
      }),
      paidAmount: amount,
    },
  };
}

function countingPayer(handler: (req: PaidRequest) => PaidResult | Promise<PaidResult>): KitePayer & { calls: PaidRequest[] } {
  const calls: PaidRequest[] = [];
  return {
    calls,
    async remainingBudgetUsd() {
      return 0;
    },
    async execute(req) {
      calls.push(req);
      return handler(req);
    },
  };
}

describe("budget ledger", () => {
  it("refuses a call when list price plus slack exceeds remaining", async () => {
    const ledger = BudgetLedger.fromUsd(0.025, 0.05, 0.01);
    const inner = countingPayer((req) => paidResult(req, "failed"));
    const gate = new BudgetedPayer(inner, ledger);
    const first = await gate.execute({
      url: "https://agent402.tools/api/search?q=one",
      method: "GET",
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
    });
    assert.equal(first.receipt.outcome, "failed");
    assert.equal(inner.calls.length, 1);
    assert.equal(ledger.spentMicro, usdToMicro(0.01));

    const second = await gate.execute({
      url: "https://agent402.tools/api/search?q=two",
      method: "GET",
      idempotencyKey: "22222222-2222-4222-8222-222222222222",
    });
    assert.equal(second.receipt.outcome, "skipped_budget");
    assert.equal(second.receipt.errorCode, "over_budget");
    assert.equal(inner.calls.length, 1);
    assert.equal(ledger.spentMicro, usdToMicro(0.01));
  });

  it("allows a call when the estimate exactly equals remaining", () => {
    const ledger = BudgetLedger.fromUsd(0.02, 0.05, 0.01);
    assert.equal(ledger.wouldExceed(0.01), "ok");
    ledger.debit(1);
    assert.equal(ledger.wouldExceed(0.01), "budget");
  });

  it("counts a thrown payer error as spent and blocks the next call", async () => {
    const ledger = BudgetLedger.fromUsd(0.025, 0.05, 0.01);
    const inner = countingPayer(() => {
      throw new Error("kpass crashed");
    });
    const gate = new BudgetedPayer(inner, ledger);
    const failed = await gate.execute({
      url: "https://agent402.tools/api/search?q=boom",
      method: "GET",
      idempotencyKey: "33333333-3333-4333-8333-333333333333",
    });
    assert.equal(failed.receipt.outcome, "failed");
    assert.equal(failed.receipt.paidAmount, formatAmount(usdToMicro(0.01)));
    const skipped = await gate.execute({
      url: "https://agent402.tools/api/search-news?q=next",
      method: "GET",
      idempotencyKey: "44444444-4444-4444-8444-444444444444",
    });
    assert.equal(skipped.receipt.outcome, "skipped_budget");
    assert.equal(inner.calls.length, 1);
  });

  it("does not debit a programming error that opts out", async () => {
    const ledger = BudgetLedger.fromUsd(0.25, 0.05, 0.01);
    const inner = countingPayer(() => {
      throw new PayerError("No dry-run fixture", false);
    });
    const gate = new BudgetedPayer(inner, ledger);
    await assert.rejects(() =>
      gate.execute({
        url: "https://agent402.tools/api/search?q=missing",
        method: "GET",
        idempotencyKey: "55555555-5555-4555-8555-555555555555",
      }),
    );
    assert.equal(ledger.spentMicro, 0);
  });

  it("refuses prices above the per-transaction cap", async () => {
    const ledger = BudgetLedger.fromUsd(0.25, 0.05, 0.01);
    const inner = countingPayer((req) => paidResult(req, "paid", "0.08"));
    const gate = new BudgetedPayer(inner, ledger);
    const result = await gate.execute({
      url: "https://agent402.tools/api/answer?q=bounties",
      method: "GET",
      idempotencyKey: "66666666-6666-4666-8666-666666666666",
    });
    assert.equal(result.receipt.outcome, "skipped_budget");
    assert.equal(result.receipt.errorCode, "exceeds_per_tx_cap");
    assert.equal(inner.calls.length, 0);
    assert.equal(ledger.spentMicro, 0);
  });

  it("stops after a session-exhausted receipt and does not send the next call", async () => {
    const ledger = BudgetLedger.fromUsd(0.25, 0.05, 0.01);
    const inner = countingPayer((req) => paidResult(req, "session_exhausted"));
    const gate = new BudgetedPayer(inner, ledger);
    const first = await gate.execute({
      url: "https://agent402.tools/api/search?q=stop",
      method: "GET",
      idempotencyKey: "77777777-7777-4777-8777-777777777777",
    });
    assert.equal(first.receipt.outcome, "session_exhausted");
    assert.equal(ledger.stopped, true);
    const second = await gate.execute({
      url: "https://agent402.tools/api/extract",
      method: "POST",
      body: { url: "https://example.com/bounty" },
      idempotencyKey: "88888888-8888-4888-8888-888888888888",
    });
    assert.equal(second.receipt.outcome, "skipped_budget");
    assert.equal(inner.calls.length, 1);
  });

  it("debits the receipt amount for a settled merchant failure", () => {
    const receipt = blankReceipt({
      tool: "extract",
      url: "https://agent402.tools/api/extract",
      method: "POST",
      outcome: "failed",
      listPriceUsd: 0.01,
    });
    receipt.paidAmount = "0.01";
    receipt.errorCode = "merchant_failed_held";
    assert.equal(debitMicroForReceipt(0.01, receipt), usdToMicro(0.01));
    receipt.outcome = "replayed";
    assert.equal(debitMicroForReceipt(0.01, receipt), 0);
  });

  it("keeps sub-cent prices exact", () => {
    const ledger = BudgetLedger.fromUsd(0.25, 0.05, 0.01);
    ledger.debit(usdToMicro(0.008));
    ledger.debit(usdToMicro(0.002));
    ledger.debit(usdToMicro(0.01));
    assert.equal(ledger.spentMicro, 20_000);
    assert.equal(formatAmount(ledger.spentMicro), "0.02");
  });
});

describe("score weights", () => {
  it("uses the documented weights and rounds to cents of a point", () => {
    const sum = Object.values(SCORE_WEIGHTS).reduce((total, weight) => total + weight, 0);
    assert.equal(Math.round(sum * 100), 100);
    assert.equal(overallScore({ effort: 8, cost: 10, reward: 7, deadline: 8, legitimacy: 9 }), 8.3);
    assert.equal(overallScore({ effort: 8, cost: 9, reward: 6, deadline: 8, legitimacy: 8 }), 7.65);
  });
});
