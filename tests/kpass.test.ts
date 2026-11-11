import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { KpassCliPayer, createKiteSession, listActiveSessions, spawnCommand } from "../src/kite/kpass.js";
import type { CommandRunner } from "../src/kite/types.js";
import { PassportHttpPayer } from "../src/kite/http.js";

const success = readFileSync(new URL("../fixtures/kpass/success.json", import.meta.url), "utf8");

describe("kpass CLI payer", () => {
  it("passes execute flags as argv and never through a shell string", async () => {
    const seen: string[][] = [];
    const runner: CommandRunner = async (args) => {
      seen.push(args);
      return { stdout: success, stderr: "", code: 0 };
    };
    let seenCwd: string | undefined;
    const wrapped: CommandRunner = async (args, opts) => {
      seenCwd = opts.cwd;
      return runner(args, opts);
    };
    const paying = new KpassCliPayer({ sessionId: "sess_live", runner: wrapped, cwd: "/repo" });
    const result = await paying.execute({
      url: "https://agent402.tools/api/search?q=Solana%20bounty",
      method: "GET",
      idempotencyKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    const args = seen[0] ?? [];
    assert.deepEqual(args.slice(0, 2), ["session", "execute"]);
    assert.ok(args.includes("--method"));
    assert.equal(args[args.indexOf("--method") + 1], "GET");
    assert.equal(args[args.indexOf("--idempotency-key") + 1], "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    assert.equal(args[args.indexOf("--session-id") + 1], "sess_live");
    assert.ok(args.includes("--output") && args.includes("json"));
    assert.ok(args.includes("--no-interactive"));
    assert.ok(args.includes("--no-browser"));
    assert.equal(args.includes("--body"), false);
    assert.equal(args.join(" ").includes("OPENSERV_API_KEY"), false);
    assert.equal(result.receipt.outcome, "paid");
    assert.equal(result.receipt.chainId, 8453);
    assert.equal(seenCwd, "/repo");
  });

  it("sends POST body and headers as JSON argv values", async () => {
    let args: string[] = [];
    const runner: CommandRunner = async (next) => {
      args = next;
      return { stdout: success, stderr: "", code: 0 };
    };
    const payer = new KpassCliPayer({ sessionId: "sess_live", runner });
    await payer.execute({
      url: "https://agent402.tools/api/extract",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: { url: "https://example.com/bounty" },
      idempotencyKey: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });
    assert.equal(args[args.indexOf("--method") + 1], "POST");
    assert.equal(args[args.indexOf("--body") + 1], JSON.stringify({ url: "https://example.com/bounty" }));
    assert.match(args[args.indexOf("--headers") + 1] ?? "", /Content-Type/);
  });

  it("builds a separate spending session with the demo caps", async () => {
    const seen: string[][] = [];
    const runner: CommandRunner = async (args) => {
      seen.push(args);
      if (args[1] === "create") {
        return {
          stdout: JSON.stringify({
            request_id: "asr_demo",
            approval_url: "https://agentpassport.ai/agent-session/approve?token=asr_demo",
          }),
          stderr: "",
          code: 0,
        };
      }
      return {
        stdout: JSON.stringify({ session_id: "sess_approved", request_id: "asr_demo" }),
        stderr: "",
        code: 0,
      };
    };
    const cwds: Array<string | undefined> = [];
    const recording: CommandRunner = async (args, opts) => {
      cwds.push(opts.cwd);
      return runner(args, opts);
    };
    const info = await createKiteSession({
      taskSummary: "Bounty Scout",
      maxPerTx: 0.05,
      maxTotal: 0.25,
      ttl: "1h",
      assets: "USDC",
      runner: recording,
      cwd: "/repo",
      wait: true,
    });
    const create = seen[0] ?? [];
    assert.ok(create.includes("--separate"));
    assert.equal(create[create.indexOf("--max-amount-per-tx") + 1], "0.05");
    assert.equal(create[create.indexOf("--max-total-amount") + 1], "0.25");
    assert.equal(create[create.indexOf("--ttl") + 1], "1h");
    assert.equal(create.includes("--no-browser"), true);
    const status = seen[1] ?? [];
    assert.ok(status.includes("--wait"));
    assert.equal(status[status.indexOf("--timeout") + 1], "300");
    assert.equal(status[status.indexOf("--request-id") + 1], "asr_demo");
    assert.equal(info.sessionId, "sess_approved");
    assert.match(info.approvalUrl ?? "", /approve\?token=/);
    assert.deepEqual(cwds, ["/repo", "/repo"]);
  });

  it("lists sessions from the same cwd", async () => {
    let cwd: string | undefined;
    const runner: CommandRunner = async (args, opts) => {
      cwd = opts.cwd;
      assert.equal(args[1], "list");
      return { stdout: "{\"sessions\":[]}", stderr: "", code: 0 };
    };
    await listActiveSessions({ runner, cwd: "/repo" });
    assert.equal(cwd, "/repo");
  });

  it("spawns the child with cwd so .kite-passport is shared", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kpass-cwd-"));
    const runner = spawnCommand(process.execPath);
    const result = await runner(["-e", "process.stdout.write(process.cwd())"], { timeoutMs: 5000, cwd: dir });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, dir);
  });
});

describe("experimental HTTP payer", () => {
  it("refuses to construct without a token and does not echo the token", async () => {
    assert.throws(() => new PassportHttpPayer({ baseUrl: "https://passport.prod.gokite.ai", token: "" }), /KITE_AGENT_TOKEN/);
    let auth = "";
    const payer = new PassportHttpPayer({
      baseUrl: "https://passport.prod.gokite.ai",
      token: "kite_test_token_not_real",
      sessionId: "sess_http",
      fetchImpl: async (_url, init) => {
        auth = new Headers(init?.headers).get("authorization") ?? "";
        return new Response(
          JSON.stringify({
            status: "success",
            session_id: "sess_http",
            payment_requirement: { asset: "USDC", amount: "0.01" },
            x402: { status_code: 200, parsed_response_body: { ok: true }, chain_id: 2366 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    const result = await payer.execute({
      url: "https://agent402.tools/api/meta?url=https%3A%2F%2Fexample.com",
      method: "GET",
      idempotencyKey: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    });
    assert.equal(auth, "Bearer kite_test_token_not_real");
    assert.equal(JSON.stringify(result.raw).includes("kite_test_token_not_real"), false);
    assert.equal(result.receipt.outcome, "paid");
    assert.equal(result.receipt.chainId, 2366);
  });
});
