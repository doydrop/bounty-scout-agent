import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { extractJson, parseExecuteEnvelope, parseSessionPayload } from "../src/kite/parse.js";
import { stripSecrets } from "../src/secrets.js";

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
