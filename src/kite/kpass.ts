import { spawn } from "node:child_process";
import { errorMessage } from "../secrets.js";
import type { CommandResult, CommandRunner, KitePayer, PaidRequest, PaidResult } from "./types.js";
import { PayerError } from "./types.js";
import { extractJson, parseExecuteEnvelope, parseSessionPayload, type SessionCreateInfo } from "./parse.js";

export function spawnCommand(bin: string): CommandRunner {
  return (args, opts) =>
    new Promise((resolve, reject) => {
      const child = spawn(bin, args, {
        cwd: opts.cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env: process.env,
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (result: CommandResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const fail = (err: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        reject(err);
      };
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        fail(new PayerError(`kpass timed out after ${opts.timeoutMs}ms`));
      }, opts.timeoutMs);
      const onAbort = () => {
        child.kill("SIGTERM");
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (stdout.length > 5_000_000) child.kill("SIGTERM");
      });
      child.stderr.on("data", (chunk: string) => {
        if (stderr.length < 20_000) stderr += chunk;
      });
      child.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") {
          fail(new PayerError(`kpass binary "${bin}" was not found. Install it or run with --dry-run.`, false));
          return;
        }
        fail(new PayerError(errorMessage(err)));
      });
      child.on("close", (code) => {
        finish({ stdout, stderr, code: code ?? 1 });
      });
    });
}

const EXECUTE_TIMEOUT_MS = 6 * 60 * 1000;

export class KpassCliPayer implements KitePayer {
  constructor(
    private readonly opts: {
      bin?: string;
      sessionId: string;
      runner?: CommandRunner;
      capUsd?: number;
      /** Directory that holds `.kite-passport/` for this session. */
      cwd?: string;
    },
  ) {}

  private runner(): CommandRunner {
    return this.opts.runner ?? spawnCommand(this.opts.bin ?? "kpass");
  }

  async remainingBudgetUsd(): Promise<number> {
    return this.opts.capUsd ?? Number.NaN;
  }

  async execute(req: PaidRequest): Promise<PaidResult> {
    const sessionId = req.sessionId ?? this.opts.sessionId;
    if (!sessionId) {
      throw new PayerError("KITE_SESSION_ID is required before a paid call.", false);
    }
    const args = [
      "session",
      "execute",
      "--session-id",
      sessionId,
      "--url",
      req.url,
      "--method",
      req.method,
      "--idempotency-key",
      req.idempotencyKey,
      "--output",
      "json",
      "--no-interactive",
      "--no-browser",
    ];
    if (req.headers && Object.keys(req.headers).length) {
      args.push("--headers", JSON.stringify(req.headers));
    }
    if (req.body !== undefined && req.method !== "GET") {
      args.push("--body", JSON.stringify(req.body));
    }
    const result = await this.runner()(args, { timeoutMs: EXECUTE_TIMEOUT_MS, cwd: this.opts.cwd });
    let parsed: unknown;
    try {
      parsed = extractJson(result.stdout);
    } catch (err) {
      const stderr = errorMessage(new Error(result.stderr)).slice(0, 500);
      throw new PayerError(
        `kpass session execute failed (exit ${result.code}): ${errorMessage(err)}${stderr ? ` ${stderr}` : ""}`,
      );
    }
    const paid = parseExecuteEnvelope(parsed, { ...req, sessionId });
    if (result.code !== 0 && paid.receipt.outcome === "paid") {
      paid.receipt.outcome = "failed";
      paid.receipt.errorCode ??= "kpass_exit";
      paid.ok = false;
    }
    return paid;
  }
}

export interface SessionCreateOptions {
  taskSummary: string;
  maxPerTx: number;
  maxTotal: number;
  ttl: string;
  assets: string;
  bin?: string;
  runner?: CommandRunner;
  cwd?: string;
  wait: boolean;
}

export async function createKiteSession(opts: SessionCreateOptions): Promise<SessionCreateInfo> {
  const runner = opts.runner ?? spawnCommand(opts.bin ?? "kpass");
  const args = [
    "session",
    "create",
    "--separate",
    "--task-summary",
    opts.taskSummary,
    "--max-amount-per-tx",
    String(opts.maxPerTx),
    "--max-total-amount",
    String(opts.maxTotal),
    "--ttl",
    opts.ttl,
    "--assets",
    opts.assets,
    "--no-browser",
    "--no-interactive",
    "--output",
    "json",
  ];
  const created = await runner(args, { timeoutMs: 120_000, cwd: opts.cwd });
  let info: SessionCreateInfo = {};
  try {
    info = parseSessionPayload(extractJson(created.stdout));
  } catch (err) {
    throw new Error(
      `kpass session create did not return JSON (exit ${created.code}): ${errorMessage(err)} ${errorMessage(new Error(created.stderr)).slice(0, 400)}`,
    );
  }
  if (!opts.wait) return info;
  if (!info.requestId && !info.sessionId) return info;
  if (info.sessionId && !info.requestId) return info;
  const requestId = info.requestId;
  if (!requestId) return info;
  const status = await runner(
    [
      "session",
      "status",
      "--request-id",
      requestId,
      "--wait",
      "--output",
      "json",
      "--no-interactive",
      "--no-browser",
    ],
    { timeoutMs: 15 * 60 * 1000, cwd: opts.cwd },
  );
  try {
    const polled = parseSessionPayload(extractJson(status.stdout));
    return {
      sessionId: polled.sessionId ?? info.sessionId,
      requestId: polled.requestId ?? info.requestId,
      approvalUrl: polled.approvalUrl ?? info.approvalUrl,
    };
  } catch {
    return info;
  }
}

export async function listActiveSessions(opts: {
  bin?: string;
  runner?: CommandRunner;
  cwd?: string;
}): Promise<unknown> {
  const runner = opts.runner ?? spawnCommand(opts.bin ?? "kpass");
  const result = await runner(
    ["session", "list", "--status", "active", "--output", "json", "--no-interactive", "--no-browser"],
    { timeoutMs: 60_000, cwd: opts.cwd },
  );
  try {
    return extractJson(result.stdout);
  } catch (err) {
    throw new Error(`kpass session list failed: ${errorMessage(err)}`);
  }
}
