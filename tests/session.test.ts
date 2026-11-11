import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { BudgetedPayer, BudgetLedger } from "../src/kite/budget.js";
import type { CommandRunner, KitePayer } from "../src/kite/types.js";
import { accountingFromSessionPayload, parseExecuteEnvelope, parseSessionPayload } from "../src/kite/parse.js";
import { activateStoredSession, readStoredSession, writeStoredSession } from "../src/kite/session-store.js";
import { runScout } from "../src/scout/runner.js";
import { FixtureServClient } from "../src/serv/client.js";

const sessionNotFound = {
  status: "error",
  error: "No active session found for the given session ID. Re-create and approve a session with 'kpass session create'.",
};

describe("session activation", () => {
  it("reads current_session_id and does not treat a request id as a session", () => {
    const pending = parseSessionPayload({
      status: "success",
      id: "agent_session_req_abc",
      approval_url: "https://agentpassport.ai/agent-session/approve?token=agent_session_req_abc",
    });
    assert.equal(pending.sessionId, undefined);
    assert.equal(pending.requestId, "agent_session_req_abc");

    const approved = parseSessionPayload({
      status: "success",
      request_id: "agent_session_req_abc",
      session_id: "sess_from_status",
      current_session_id: "sess_current",
    });
    assert.equal(approved.sessionId, "sess_current");
    assert.equal(approved.requestId, "agent_session_req_abc");
  });

  it("stores the session id after status and leaves the request id if status has not finished", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "scout-session-"));
    writeStoredSession(dataDir, {
      sessionId: null,
      requestId: "agent_session_req_abc",
      approvalUrl: "https://agentpassport.ai/agent-session/approve?token=agent_session_req_abc",
      createdAt: "2026-11-11T00:00:00.000Z",
    });
    const missing: CommandRunner = async () => {
      throw new Error("timed out");
    };
    const pending = await activateStoredSession({ dataDir, runner: missing });
    assert.equal(pending.activated, false);
    assert.equal(readStoredSession(dataDir)?.sessionId, null);
    assert.equal(readStoredSession(dataDir)?.requestId, "agent_session_req_abc");

    const runner: CommandRunner = async (args) => {
      assert.equal(args[1], "status");
      assert.equal(args.includes("--wait"), false);
      assert.equal(args[args.indexOf("--request-id") + 1], "agent_session_req_abc");
      return {
        stdout: JSON.stringify({
          status: "success",
          request_id: "agent_session_req_abc",
          session_id: "sess_approved_fixture",
          current_session_id: "sess_approved_fixture",
          private_key: "REDACT_ME_FIXTURE",
        }),
        stderr: "",
        code: 0,
      };
    };
    const activated = await activateStoredSession({ dataDir, runner });
    assert.equal(activated.activated, true);
    assert.equal(activated.sessionId, "sess_approved_fixture");
    const saved = readFileSync(path.join(dataDir, "session.json"), "utf8");
    assert.match(saved, /sess_approved_fixture/);
    assert.equal(saved.includes("REDACT_ME_FIXTURE"), false);
    assert.equal(saved.includes("private_key"), false);
  });

  it("reads settled spend from a session list, not from old receipts", () => {
    const listed = {
      sessions: [
        {
          session_id: "sess_live",
          usage: { spent_total: "0.058" },
          delegation: { payment_policy: { max_total_amount: "0.25" } },
        },
      ],
    };
    const accounting = accountingFromSessionPayload(listed, "sess_live");
    assert.equal(accounting.spentUsd, 0.058);
    assert.equal(accounting.maxTotalUsd, 0.25);
  });

  it("keeps a $0.25 cap when the planner suggests $0.016 and kpass has not paid", async () => {
    const calls: string[] = [];
    const inner: KitePayer = {
      async remainingBudgetUsd() {
        return 1;
      },
      async execute(req) {
        calls.push(req.url);
        return parseExecuteEnvelope(sessionNotFound, req);
      },
    };
    const ledger = BudgetLedger.fromUsd(0.25, 0.05, 0.01);
    const record = await runScout({
      mode: "live",
      servModel: "gpt-5.4-mini",
      criteria: {
        chains: ["solana"],
        entryCost: "free_or_gas",
        categories: ["contest"],
        maxEffortMinutes: 30,
        budgetUsd: 0.25,
      },
      serv: new FixtureServClient({
        scout_plan: {
          rationale: "Only a cheap search.",
          maxPaidUsd: 0.016,
          calls: [
            {
              tool: "search-lite",
              reason: "first look",
              query: "solana bounty",
              count: 5,
              freshness: "pw",
              country: "",
              url: "",
            },
          ],
          rejected: [
            {
              tool: "answer",
              reason: "too expensive",
              url: "https://agent402.tools/api/answer",
            },
          ],
        },
      }),
      payer: new BudgetedPayer(inner, ledger),
      ledger,
      agent402BaseUrl: "https://agent402.tools",
      sessionMaxUsd: 0.25,
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
    assert.equal(calls.length, 1);
    assert.equal(record.digest.budget.capUsd, 0.25);
    assert.equal(record.digest.budget.sessionCapUsd, 0.25);
    assert.equal(record.digest.budget.spentUsd, 0);
    assert.equal(ledger.capUsd(), 0.25);
    assert.ok(record.receipts.some((receipt) => receipt.errorCode === "session_not_found" && receipt.prePayment === true));
    assert.ok(record.receipts.some((receipt) => receipt.errorCode === "planner_rejected"));
    assert.match(record.digest.decisions.join(" "), /cap stays/);
  });
});
