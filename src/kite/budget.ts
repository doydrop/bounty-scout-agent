import { randomUUID } from "node:crypto";
import { formatAmount, microToUsd, parseUsd, usdToMicro } from "../money.js";
import type { SpendOutcome, SpendReceipt } from "../types.js";
import { resolveTool } from "../tools/catalog.js";
import type { KitePayer, PaidRequest, PaidResult } from "./types.js";
import { PayerError, SESSION_STOP_CODES } from "./types.js";

/**
 * Hard spend cap for Agent402 calls.
 * A call is refused when listPrice + slack is greater than remaining,
 * or when listPrice is above the per-transaction cap.
 * Failed calls still debit (receipt amount, else the list price).
 */
export class BudgetLedger {
  spentMicro = 0;
  stopped = false;
  stopReason?: string;

  constructor(
    public capMicro: number,
    readonly perTxMicro: number,
    readonly slackMicro: number,
  ) {}

  static fromUsd(capUsd: number, perTxUsd: number, slackUsd: number): BudgetLedger {
    return new BudgetLedger(usdToMicro(capUsd), usdToMicro(perTxUsd), usdToMicro(slackUsd));
  }

  remainingMicro(): number {
    return Math.max(0, this.capMicro - this.spentMicro);
  }

  remainingUsd(): number {
    return microToUsd(this.remainingMicro());
  }

  spentUsd(): number {
    return microToUsd(this.spentMicro);
  }

  capUsd(): number {
    return microToUsd(this.capMicro);
  }

  /**
   * Lower the cap to a planner limit. Never raises it and never drops it below spent.
   */
  tightenCapUsd(usd: number): void {
    if (!Number.isFinite(usd) || usd <= 0) return;
    const next = usdToMicro(usd);
    if (next >= this.capMicro) return;
    if (next < this.spentMicro) {
      this.capMicro = this.spentMicro;
      this.stopped = true;
      this.stopReason = "plan_cap";
      return;
    }
    this.capMicro = next;
  }

  wouldExceed(listPriceUsd: number): "ok" | "per_tx" | "budget" | "stopped" {
    if (this.stopped) return "stopped";
    const list = usdToMicro(listPriceUsd);
    if (list > this.perTxMicro) return "per_tx";
    if (list + this.slackMicro > this.remainingMicro()) return "budget";
    return "ok";
  }

  debit(micro: number): void {
    if (!Number.isFinite(micro) || micro < 0) throw new Error("Invalid debit");
    this.spentMicro += micro;
  }
}

export function debitMicroForReceipt(listPriceUsd: number, receipt: SpendReceipt): number {
  if (receipt.outcome === "skipped_budget" || receipt.outcome === "replayed") return 0;
  if (receipt.outcome === "session_exhausted") {
    const paid = parseUsd(receipt.paidAmount);
    return paid === null ? 0 : usdToMicro(paid);
  }
  const paid = parseUsd(receipt.paidAmount);
  if (paid !== null) return usdToMicro(paid);
  return usdToMicro(listPriceUsd);
}

export function blankReceipt(partial: {
  tool: string;
  url: string;
  method: string;
  outcome: SpendOutcome;
  idempotencyKey?: string;
  listPriceUsd?: number;
  errorCode?: string;
  detail?: string;
  sessionId?: string;
  now?: Date;
}): SpendReceipt {
  return {
    id: `rct_${randomUUID()}`,
    ts: (partial.now ?? new Date()).toISOString(),
    tool: partial.tool,
    url: partial.url,
    method: partial.method,
    idempotencyKey: partial.idempotencyKey ?? randomUUID(),
    listPriceUsd: partial.listPriceUsd,
    sessionId: partial.sessionId,
    outcome: partial.outcome,
    errorCode: partial.errorCode,
    detail: partial.detail,
    merchantStatus: 0,
  };
}

function stamp(receipt: SpendReceipt, ledger: BudgetLedger): SpendReceipt {
  receipt.spentTotal = formatAmount(ledger.spentMicro);
  receipt.maxTotal = formatAmount(ledger.capMicro);
  return receipt;
}

/**
 * Wraps any payer and refuses a call before it is sent when the estimate
 * would break the remaining cap. Thrown payer errors debit the list price
 * (the call was attempted) unless the error opts out.
 */
export class BudgetedPayer implements KitePayer {
  constructor(
    private readonly inner: KitePayer,
    readonly ledger: BudgetLedger,
    private readonly opts: { sessionId?: string; now?: () => Date } = {},
  ) {}

  async remainingBudgetUsd(): Promise<number> {
    return this.ledger.remainingUsd();
  }

  async execute(req: PaidRequest): Promise<PaidResult> {
    const tool = resolveTool(req.url);
    const now = this.opts.now ?? (() => new Date());
    if (!tool) {
      const receipt = stamp(
        blankReceipt({
          tool: "unknown",
          url: req.url,
          method: req.method,
          outcome: "skipped_budget",
          idempotencyKey: req.idempotencyKey,
          errorCode: "tool_not_allowlisted",
          detail: "URL is not an allowlisted Agent402 tool.",
          sessionId: req.sessionId ?? this.opts.sessionId,
          now: now(),
        }),
        this.ledger,
      );
      return { ok: false, merchantStatus: 0, body: null, receipt, raw: null };
    }

    const gate = this.ledger.wouldExceed(tool.listPriceUsd);
    if (gate !== "ok") {
      const errorCode =
        gate === "per_tx" ? "exceeds_per_tx_cap" : gate === "stopped" ? "session_stopped" : "over_budget";
      const detail =
        gate === "per_tx"
          ? `List price ${tool.listPriceUsd} is above the per-transaction cap.`
          : gate === "stopped"
            ? `Not sent. Spending is stopped (${this.ledger.stopReason ?? "budget"}).`
            : `Not sent. List price ${tool.listPriceUsd} plus slack would exceed the remaining cap.`;
      const receipt = stamp(
        blankReceipt({
          tool: tool.id,
          url: req.url,
          method: req.method,
          outcome: "skipped_budget",
          idempotencyKey: req.idempotencyKey,
          listPriceUsd: tool.listPriceUsd,
          errorCode,
          detail,
          sessionId: req.sessionId ?? this.opts.sessionId,
          now: now(),
        }),
        this.ledger,
      );
      return { ok: false, merchantStatus: 0, body: null, receipt, raw: null };
    }

    try {
      const result = await this.inner.execute(req);
      const debit = debitMicroForReceipt(tool.listPriceUsd, result.receipt);
      this.ledger.debit(debit);
      result.receipt.tool = tool.id;
      result.receipt.listPriceUsd ??= tool.listPriceUsd;
      result.receipt.sessionId ??= req.sessionId ?? this.opts.sessionId;
      if (
        result.receipt.outcome === "session_exhausted" ||
        (result.receipt.errorCode && SESSION_STOP_CODES.has(result.receipt.errorCode))
      ) {
        this.ledger.stopped = true;
        this.ledger.stopReason = result.receipt.errorCode ?? "session_exhausted";
        if (result.receipt.outcome !== "session_exhausted") {
          result.receipt.outcome = "session_exhausted";
        }
      }
      stamp(result.receipt, this.ledger);
      return result;
    } catch (err) {
      if (err instanceof PayerError && !err.debit) throw err;
      this.ledger.debit(usdToMicro(tool.listPriceUsd));
      const receipt = stamp(
        blankReceipt({
          tool: tool.id,
          url: req.url,
          method: req.method,
          outcome: "failed",
          idempotencyKey: req.idempotencyKey,
          listPriceUsd: tool.listPriceUsd,
          errorCode: "payer_error",
          detail: err instanceof Error ? err.message : "Payer failed before a receipt.",
          sessionId: req.sessionId ?? this.opts.sessionId,
          now: now(),
        }),
        this.ledger,
      );
      receipt.paidAmount = formatAmount(usdToMicro(tool.listPriceUsd));
      return { ok: false, merchantStatus: 0, body: null, receipt, raw: null };
    }
  }
}
