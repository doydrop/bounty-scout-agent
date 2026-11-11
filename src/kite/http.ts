import { errorMessage } from "../secrets.js";
import type { KitePayer, PaidRequest, PaidResult } from "./types.js";
import { PayerError } from "./types.js";
import { parseExecuteEnvelope } from "./parse.js";

/**
 * Experimental Passport HTTP payer.
 *
 * docs.gokite.ai/api-reference says agents pay through the kpass CLI and that
 * there is no public HTTP API reference yet. Path fragments such as
 * /v1/agent/session/execute appear in kpass 6.13.1, but the method, auth
 * header, and body are unverified. This adapter is behind KITE_PAYER=http
 * and is not used by the demo or the default dry-run.
 */
export class PassportHttpPayer implements KitePayer {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly opts: {
      baseUrl: string;
      token: string;
      sessionId?: string;
      fetchImpl?: typeof fetch;
      capUsd?: number;
    },
  ) {
    if (!opts.token) {
      throw new PayerError("KITE_AGENT_TOKEN is required for KITE_PAYER=http.", false);
    }
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async remainingBudgetUsd(): Promise<number> {
    return this.opts.capUsd ?? Number.NaN;
  }

  async execute(req: PaidRequest): Promise<PaidResult> {
    const sessionId = req.sessionId ?? this.opts.sessionId;
    if (!sessionId) throw new PayerError("A Passport session id is required.", false);
    const endpoint = `${this.opts.baseUrl.replace(/\/$/, "")}/v1/agent/session/execute`;
    let response: Response;
    try {
      response = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.opts.token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          session_id: sessionId,
          url: req.url,
          method: req.method,
          headers: req.headers ?? {},
          body: req.body ?? null,
          idempotency_key: req.idempotencyKey,
        }),
      });
    } catch (err) {
      throw new PayerError(`Passport HTTP execute failed: ${errorMessage(err, [this.opts.token])}`);
    }
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      throw new PayerError(
        `Passport HTTP returned non-JSON (HTTP ${response.status}).`,
      );
    }
    if (!response.ok) {
      const paid = parseExecuteEnvelope(
        {
          ...(parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {}),
          status: "error",
          error_code:
            (parsed &&
              typeof parsed === "object" &&
              typeof (parsed as { error_code?: unknown }).error_code === "string" &&
              (parsed as { error_code: string }).error_code) ||
            "http_error",
          hint: `Passport HTTP ${response.status}`,
        },
        { ...req, sessionId },
      );
      return paid;
    }
    return parseExecuteEnvelope(parsed, { ...req, sessionId });
  }
}
