import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { formatReceiptLine } from "../src/cli.js";
import { BudgetedPayer, BudgetLedger, debitMicroForReceipt } from "../src/kite/budget.js";
import type { KitePayer, PaidRequest } from "../src/kite/types.js";
import { extractJson, parseExecuteEnvelope, parseSessionPayload } from "../src/kite/parse.js";
import { saveRun } from "../src/scout/digest.js";
import { stripSecrets } from "../src/secrets.js";
import type { Digest } from "../src/types.js";

const req = {
  url: "https://agent402.tools/api/search?q=solana",
  method: "GET" as const,
  idempotencyKey: "99999999-9999-4999-8999-999999999999",
};

describe("kpass envelopes", () => {
  it("reads the documentary success envelope and strips secrets", () => {
    const raw = JSON.parse(readFileSync(new URL("../fixtures/kpass/success.json", import.meta.url), "utf8"));
    const parsed = parseExecuteEnvelope(raw, req);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.merchantStatus, 200);
    assert.equal(parsed.receipt.outcome, "paid");
    assert.equal(parsed.receipt.paidAmount, "1.00");
    assert.equal(parsed.receipt.paidAsset, "USDC");
    assert.equal(parsed.receipt.chainId, 8453);
    assert.equal(parsed.receipt.txReference, "0xdocumentary");
    assert.deepEqual((parsed.body as { ok: boolean }).ok, true);
    assert.equal((parsed.raw as { agent_token: string }).agent_token, "[redacted]");
    assert.equal(JSON.stringify(parsed.raw).includes("REDACT_ME_FIXTURE"), false);
  });

  it("maps session_total_exceeded to a stop", () => {
    const raw = JSON.parse(
      readFileSync(new URL("../fixtures/kpass/session-total-exceeded.json", import.meta.url), "utf8"),
    );
    const parsed = parseExecuteEnvelope(raw, req);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.receipt.outcome, "session_exhausted");
    assert.equal(parsed.receipt.errorCode, "session_total_exceeded");
    assert.equal((parsed.raw as { agent_token: string }).agent_token, "[redacted]");
  });

  it("keeps a settled merchant failure as failed without treating it as a session stop", () => {
    const raw = JSON.parse(readFileSync(new URL("../fixtures/kpass/merchant-failed.json", import.meta.url), "utf8"));
    const parsed = parseExecuteEnvelope(raw, req);
    assert.equal(parsed.receipt.outcome, "failed");
    assert.equal(parsed.receipt.errorCode, "merchant_failed_held");
    assert.equal(parsed.receipt.paidAmount, "0.01");
    assert.equal(parsed.receipt.chainId, 2366);
    assert.deepEqual(parsed.body, { error: "bad gateway" });
  });

  it("parses a response body string when parsed_response_body is absent", () => {
    const parsed = parseExecuteEnvelope(
      {
        status: "success",
        x402: { status_code: 200, response_body: "{\"results\":[]}" },
      },
      req,
    );
    assert.deepEqual(parsed.body, { results: [] });
    assert.equal(parsed.receipt.outcome, "paid");
  });

  it("extracts JSON from a prefixed log line and classifies approval ids", () => {
    const parsed = extractJson('waiting\n{"request_id":"asr_123","approval_url":"https://agentpassport.ai/agent-session/approve?token=asr_123"}');
    const info = parseSessionPayload(parsed);
    assert.equal(info.requestId, "asr_123");
    assert.equal(info.sessionId, undefined);
    assert.match(info.approvalUrl ?? "", /agent-session\/approve/);
  });

  it("maps a pre-payment session miss and does not debit it", async () => {
    const raw = JSON.parse(readFileSync(new URL("../fixtures/kpass/session-not-found.json", import.meta.url), "utf8"));
    const parsed = parseExecuteEnvelope(raw, req);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.merchantStatus, 0);
    assert.equal(parsed.receipt.outcome, "failed");
    assert.equal(parsed.receipt.errorCode, "session_not_found");
    assert.match(parsed.receipt.detail ?? "", /No active session found for the given session ID/);
    assert.equal(parsed.receipt.prePayment, true);
    assert.equal(debitMicroForReceipt(0.01, parsed.receipt), 0);

    const calls: string[] = [];
    const inner: KitePayer = {
      async remainingBudgetUsd() {
        return 1;
      },
      async execute(next: PaidRequest) {
        calls.push(next.url);
        return parseExecuteEnvelope(raw, next);
      },
    };
    const ledger = BudgetLedger.fromUsd(0.25, 0.05, 0.01);
    const gate = new BudgetedPayer(inner, ledger);
    const first = await gate.execute({ ...req, url: "https://agent402.tools/api/search-lite?q=one" });
    const second = await gate.execute({
      ...req,
      url: "https://agent402.tools/api/search?q=two",
      idempotencyKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    assert.equal(first.receipt.outcome, "failed");
    assert.equal(first.receipt.errorCode, "session_not_found");
    assert.equal(ledger.spentMicro, 0);
    assert.equal(ledger.stopped, true);
    assert.equal(second.receipt.outcome, "skipped_budget");
    assert.deepEqual(calls, ["https://agent402.tools/api/search-lite?q=one"]);

    const line = formatReceiptLine(first.receipt);
    assert.match(line, /session_not_found/);
    assert.match(line, /No active session found/);
    const dir = mkdtempSync(path.join(tmpdir(), "scout-rct-"));
    const digest: Digest = {
      generatedAt: first.receipt.ts,
      mode: "live",
      servModel: "gpt-5.4-mini",
      criteria: {
        chains: ["solana"],
        entryCost: "free_or_gas",
        categories: ["contest"],
        maxEffortMinutes: 30,
        budgetUsd: 0.25,
      },
      summary: "stopped",
      decisions: [],
      warnings: [],
      opportunities: [],
      dropped: [],
      budget: {
        capUsd: 0.25,
        sessionCapUsd: 0.25,
        spentUsd: 0,
        remainingUsd: 0.25,
        perTxCapUsd: 0.05,
        slackUsd: 0.01,
      },
      receiptIds: [first.receipt.id],
      stoppedReason: "session_not_found",
    };
    saveRun(dir, { digest, receipts: [first.receipt], stoppedReason: "session_not_found" });
    const jsonl = readFileSync(path.join(dir, "receipts.jsonl"), "utf8");
    assert.match(jsonl, /"errorCode":"session_not_found"/);
    assert.match(jsonl, /No active session found for the given session ID/);
  });

  it("reads the live success envelope, including payment.transaction_hash and x402.chain_id", () => {
    const raw = JSON.parse(readFileSync(new URL("../fixtures/kpass/live-success.json", import.meta.url), "utf8"));
    const parsed = parseExecuteEnvelope(raw, req);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.receipt.outcome, "paid");
    assert.equal(parsed.receipt.merchantStatus, 200);
    assert.equal(parsed.receipt.paidAmount, "0.008");
    assert.equal(parsed.receipt.paidAsset, "USDC");
    assert.equal(parsed.receipt.spentTotal, "0.008");
    assert.equal(parsed.receipt.maxTotal, "0.25");
    assert.equal(parsed.receipt.sessionId, "sess_live_fixture");
    assert.equal(parsed.receipt.chainId, 2366);
    assert.equal(parsed.receipt.txReference, "0xlivefixturetx");
    assert.equal(parsed.receipt.prePayment, undefined);
    assert.equal((parsed.body as { untrustedContent?: boolean }).untrustedContent, true);
    assert.equal(debitMicroForReceipt(0.008, parsed.receipt), 8000);
  });

  it("labels a generic pre-payment kpass error and does not debit it", () => {
    const parsed = parseExecuteEnvelope({ status: "error", error: "merchant rejected the quote" }, req);
    assert.equal(parsed.receipt.outcome, "failed");
    assert.equal(parsed.receipt.errorCode, "kpass_error");
    assert.equal(parsed.receipt.detail, "merchant rejected the quote");
    assert.equal(parsed.receipt.prePayment, true);
    assert.equal(debitMicroForReceipt(0.01, parsed.receipt), 0);
    assert.match(formatReceiptLine(parsed.receipt), /kpass_error merchant rejected the quote/);
  });

  it("redacts bearer tokens and jwt-shaped strings", () => {
    const cleaned = stripSecrets({
      authorization: "Bearer kite_live_secret",
      note: "Authorization: Bearer abc.def.ghi",
      nested: { jwt: "eyJaaaaaaaaaa.bbbbbbbbbbbb.cccccccccccc" },
    });
    assert.equal(JSON.stringify(cleaned).includes("kite_live_secret"), false);
    assert.match(JSON.stringify(cleaned), /redacted/);
  });
});
