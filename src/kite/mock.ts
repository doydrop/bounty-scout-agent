import { readFileSync } from "node:fs";
import { z } from "zod";
import { formatAmount, usdToMicro } from "../money.js";
import { planSchema, scoreSchema, selectSchema } from "../serv/schemas.js";
import { toolIdFromUrl } from "./parse.js";
import { parseExecuteEnvelope } from "./parse.js";
import type { KitePayer, PaidRequest, PaidResult } from "./types.js";
import { PayerError } from "./types.js";

const fixtureCallSchema = z.object({
  tool: z.string(),
  queryIncludes: z.string().optional(),
  urlIncludes: z.string().optional(),
  outcome: z.enum(["paid", "skipped_budget", "session_exhausted", "failed", "replayed"]),
  errorCode: z.string().optional(),
  merchantStatus: z.number().int(),
  paidAmount: z.string().optional(),
  paidAsset: z.string().optional(),
  chainId: z.number().int().optional(),
  txReference: z.string().optional(),
  hint: z.string().optional(),
  body: z.unknown(),
});

const fixtureFileSchema = z.object({
  scout_plan: planSchema,
  scout_select: selectSchema,
  scout_score: scoreSchema,
  calls: z.array(fixtureCallSchema),
});

export type FixtureCall = z.infer<typeof fixtureCallSchema>;

export interface DryRunFixture {
  responses: Record<string, unknown>;
  calls: FixtureCall[];
}

export function loadDryRunFixture(file: string): DryRunFixture {
  const parsed = fixtureFileSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  return {
    responses: {
      scout_plan: parsed.scout_plan,
      scout_select: parsed.scout_select,
      scout_score: parsed.scout_score,
    },
    calls: parsed.calls,
  };
}

function haystack(req: PaidRequest): string {
  const parts = [req.url];
  try {
    const url = new URL(req.url);
    parts.push(url.pathname, url.search);
    const query = url.searchParams.get("q");
    const page = url.searchParams.get("url");
    if (query) parts.push(query);
    if (page) parts.push(page);
  } catch {
    // keep the raw URL
  }
  if (req.body && typeof req.body === "object" && !Array.isArray(req.body) && "url" in req.body) {
    parts.push(String((req.body as { url: unknown }).url));
  }
  return parts.join("\n");
}

function envelope(fx: FixtureCall, sessionId: string, capUsd: number, spentMicro: number): unknown {
  const stop = fx.outcome === "session_exhausted";
  const failed = fx.outcome === "failed";
  const success = fx.outcome === "paid" || fx.outcome === "replayed" || (failed && fx.merchantStatus >= 400 && fx.paidAmount);
  return {
    session_id: sessionId,
    session_status: stop ? "exhausted" : "active",
    delegation: {
      task: { summary: "Bounty Scout dry-run" },
      payment_policy: {
        max_amount_per_tx: "0.05",
        max_total_amount: formatAmount(usdToMicro(capUsd)),
      },
    },
    usage: { spent_total: formatAmount(spentMicro), reserved_total: "0.00" },
    payment_requirement: fx.paidAmount ? { asset: fx.paidAsset ?? "USDC", amount: fx.paidAmount } : undefined,
    x402: {
      status_code: fx.merchantStatus,
      parsed_response_body: fx.body,
      response_body: JSON.stringify(fx.body ?? null),
      wallet_address: "0xDRYRUN",
      chain_id: fx.chainId ?? 2366,
    },
    payment: fx.txReference ? { payment_response: { reference: fx.txReference } } : undefined,
    status: success && !stop ? "success" : "error",
    error_code: fx.errorCode,
    replayed: fx.outcome === "replayed" ? true : undefined,
    hint: fx.hint ?? "dry-run fixture",
    _version: "1",
  };
}

export class FixturePayer implements KitePayer {
  private readonly used: boolean[];
  spentMicro = 0;

  constructor(
    private readonly calls: FixtureCall[],
    private readonly opts: { sessionId: string; capUsd: number; delayMs?: number },
  ) {
    this.used = calls.map(() => false);
  }

  async remainingBudgetUsd(): Promise<number> {
    return this.opts.capUsd - this.spentMicro / 1_000_000;
  }

  async execute(req: PaidRequest): Promise<PaidResult> {
    if (this.opts.delayMs && this.opts.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.opts.delayMs));
    }
    const tool = toolIdFromUrl(req.url);
    const text = haystack(req);
    const index = this.calls.findIndex((call, i) => {
      if (this.used[i]) return false;
      if (call.tool !== tool) return false;
      if (call.queryIncludes && !text.toLowerCase().includes(call.queryIncludes.toLowerCase())) return false;
      if (call.urlIncludes && !text.includes(call.urlIncludes)) return false;
      return true;
    });
    const fixture = index >= 0 ? this.calls[index] : undefined;
    if (!fixture || index < 0) {
      throw new PayerError(`No dry-run fixture for ${req.method} ${req.url}`, false);
    }
    this.used[index] = true;
    if (fixture.paidAmount && (fixture.outcome === "paid" || fixture.outcome === "failed")) {
      this.spentMicro += usdToMicro(Number(fixture.paidAmount));
    }
    return parseExecuteEnvelope(
      envelope(fixture, req.sessionId ?? this.opts.sessionId, this.opts.capUsd, this.spentMicro),
      req,
    );
  }
}
