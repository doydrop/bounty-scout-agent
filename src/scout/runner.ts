import { randomUUID } from "node:crypto";
import { BudgetLedger, blankReceipt } from "../kite/budget.js";
import type { KitePayer, PaidRequest, PaidResult } from "../kite/types.js";
import { formatAmount } from "../money.js";
import { errorMessage } from "../secrets.js";
import type { ServClient } from "../serv/client.js";
import type { PlanCall, Selection } from "../serv/schemas.js";
import { buildToolRequest } from "../tools/agent402.js";
import { toolById } from "../tools/catalog.js";
import type { Digest, RunRecord, ScoutCriteria, SpendReceipt } from "../types.js";
import {
  applyPage,
  candidatesFromSearch,
  canonicalUrl,
  mergeCandidate,
  pageIsThin,
  type Candidate,
} from "./candidates.js";
import { fallbackSelection, planDiscovery, selectEnrichment } from "./planner.js";
import { applyScores, scoreCandidates } from "./scorer.js";

const DISCOVERY = new Set(["search", "search-lite", "search-news", "answer"]);

export interface RunScoutInput {
  mode: "dry-run" | "live";
  servModel: string;
  criteria: ScoutCriteria;
  serv: ServClient;
  payer: KitePayer;
  ledger: BudgetLedger;
  agent402BaseUrl: string;
  sessionId?: string;
  maxSearches: number;
  maxExtracts: number;
  maxMeta: number;
  maxRenders: number;
  allowAnswer: boolean;
  slackUsd: number;
  perTxUsd: number;
  hostAllowlist: string[];
  timeoutMs: number;
  signal?: AbortSignal;
  now?: () => Date;
  onReceipt?: (receipt: SpendReceipt) => void;
}

function hostAllowed(url: string, allowlist: string[]): boolean {
  if (!allowlist.length) return true;
  try {
    return allowlist.includes(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

export async function runScout(input: RunScoutInput): Promise<RunRecord> {
  const now = input.now ?? (() => new Date());
  const started = Date.now();
  const openedCapUsd = input.ledger.capUsd();
  const receipts: SpendReceipt[] = [];
  const decisions: string[] = [];
  const warnings: string[] = [];
  const candidates = new Map<string, Candidate>();
  let searches = 0;
  let extracts = 0;
  let metas = 0;
  let renders = 0;
  let halt: "aborted" | "timeout" | undefined;

  const record = (receipt: SpendReceipt) => {
    receipts.push(receipt);
    input.onReceipt?.(receipt);
  };

  const skip = (fields: {
    tool: string;
    url: string;
    method: string;
    errorCode: string;
    detail: string;
    listPriceUsd?: number;
  }) => {
    const receipt = blankReceipt({
      ...fields,
      outcome: "skipped_budget",
      idempotencyKey: randomUUID(),
      sessionId: input.sessionId,
      now: now(),
    });
    receipt.spentTotal = formatAmount(input.ledger.spentMicro);
    receipt.maxTotal = formatAmount(input.ledger.capMicro);
    record(receipt);
  };

  const checkHalt = (): boolean => {
    if (halt) return true;
    if (input.signal?.aborted) {
      halt = "aborted";
      return true;
    }
    if (Date.now() - started > input.timeoutMs) {
      halt = "timeout";
      return true;
    }
    return false;
  };

  const remember = (tool: string, body: unknown, receiptId: string, pageUrl?: string) => {
    if (DISCOVERY.has(tool) && tool !== "answer") {
      for (const candidate of candidatesFromSearch(tool, body, receiptId)) {
        mergeCandidate(candidates, candidate);
      }
    }
    if (!pageUrl) return;
    const canonical = canonicalUrl(pageUrl);
    const existing = canonical ? candidates.get(canonical) : undefined;
    if (existing) applyPage(existing, tool, body, receiptId);
  };

  const pay = async (req: PaidRequest, pageUrl?: string): Promise<PaidResult> => {
    const result = await input.payer.execute(req);
    record(result.receipt);
    if (result.ok && result.body != null) remember(result.receipt.tool, result.body, result.receipt.id, pageUrl);
    return result;
  };

  if (input.mode === "dry-run") {
    warnings.push(
      "Dry-run: SERV responses and Kite receipts are local fixtures. No network payment was made.",
    );
  }

  const plan = await planDiscovery(input.serv, {
    criteria: input.criteria,
    remainingUsd: input.ledger.remainingUsd(),
    slackUsd: input.slackUsd,
    perTxUsd: input.perTxUsd,
    maxSearches: input.maxSearches,
    allowAnswer: input.allowAnswer,
  });
  if (plan.maxPaidUsd > 0) input.ledger.tightenCapUsd(plan.maxPaidUsd);
  decisions.push(plan.rationale);

  for (const rejected of plan.rejected) {
    const tool = toolById(rejected.tool);
    skip({
      tool: rejected.tool,
      url: rejected.url || `${input.agent402BaseUrl}${tool?.path ?? ""}`,
      method: tool?.method ?? "GET",
      errorCode: "planner_rejected",
      detail: rejected.reason,
      listPriceUsd: tool?.listPriceUsd,
    });
    decisions.push(`Skipped ${rejected.tool}: ${rejected.reason}`);
  }

  for (const call of plan.calls) {
    if (checkHalt() || input.ledger.stopped) {
      const tool = toolById(call.tool);
      skip({
        tool: call.tool,
        url: call.url || `${input.agent402BaseUrl}${tool?.path ?? ""}`,
        method: tool?.method ?? "GET",
        errorCode: input.ledger.stopped ? "session_stopped" : halt === "aborted" ? "aborted" : "timeout",
        detail: input.ledger.stopped
          ? `Not sent. Spending stopped (${input.ledger.stopReason ?? "budget"}).`
          : `Not sent. Run ${halt}.`,
        listPriceUsd: tool?.listPriceUsd,
      });
      continue;
    }
    await executePlannedCall(call);
  }

  async function executePlannedCall(call: PlanCall): Promise<void> {
    const tool = toolById(call.tool);
    if (call.tool === "answer" && !input.allowAnswer) {
      skip({
        tool: "answer",
        url: `${input.agent402BaseUrl}/api/answer`,
        method: "GET",
        errorCode: "answer_disabled",
        detail: "Answer stays off unless SCOUT_ALLOW_ANSWER=true. One call is $0.08.",
        listPriceUsd: tool?.listPriceUsd,
      });
      return;
    }
    if (DISCOVERY.has(call.tool) && call.tool !== "answer" && searches >= input.maxSearches) {
      skip({
        tool: call.tool,
        url: `${input.agent402BaseUrl}${tool?.path ?? ""}`,
        method: "GET",
        errorCode: "max_searches",
        detail: `Search cap is ${input.maxSearches}.`,
        listPriceUsd: tool?.listPriceUsd,
      });
      return;
    }
    if (call.url && !DISCOVERY.has(call.tool) && !hostAllowed(call.url, input.hostAllowlist)) {
      skip({
        tool: call.tool,
        url: call.url,
        method: tool?.method ?? "GET",
        errorCode: "host_not_allowlisted",
        detail: "Host is outside SCOUT_HOST_ALLOWLIST.",
        listPriceUsd: tool?.listPriceUsd,
      });
      return;
    }
    const toolName =
      call.tool === "extract" && call.url.toLowerCase().split("?")[0]?.endsWith(".pdf") ? "pdf" : call.tool;
    let req: PaidRequest;
    try {
      req = buildToolRequest(
        input.agent402BaseUrl,
        {
          tool: toolName,
          query: call.query,
          count: call.count,
          freshness: call.freshness,
          country: call.country,
          url: call.url,
        },
        input.sessionId,
      );
    } catch (err) {
      skip({
        tool: call.tool,
        url: call.url || input.agent402BaseUrl,
        method: tool?.method ?? "GET",
        errorCode: "bad_request",
        detail: errorMessage(err),
        listPriceUsd: tool?.listPriceUsd,
      });
      return;
    }
    if (DISCOVERY.has(call.tool) && call.tool !== "answer") searches += 1;
    if (call.tool === "meta") metas += 1;
    if (call.tool === "extract" || call.tool === "pdf" || call.tool === "render") extracts += 1;
    await pay(req, DISCOVERY.has(call.tool) ? undefined : call.url);
  }

  let selection: Selection | undefined;
  const metaFloor = (toolById("meta")?.listPriceUsd ?? 0.002) + input.slackUsd;
  const canEnrich =
    !halt && !input.ledger.stopped && candidates.size > 0 && input.ledger.remainingUsd() + 1e-9 >= metaFloor;

  if (canEnrich) {
    try {
      selection = await selectEnrichment(input.serv, {
        criteria: input.criteria,
        remainingUsd: input.ledger.remainingUsd(),
        slackUsd: input.slackUsd,
        maxMeta: Math.max(0, input.maxMeta - metas),
        maxExtracts: Math.max(0, input.maxExtracts - extracts),
        candidates: [...candidates.values()],
      });
    } catch (err) {
      warnings.push(`SERV selection failed (${errorMessage(err)}). Used discovery order instead.`);
      selection = fallbackSelection(
        [...candidates.values()],
        Math.max(0, input.maxExtracts - extracts),
        Math.max(0, input.maxMeta - metas),
      );
    }
    decisions.push(selection.rationale);
    for (const item of selection.rejected) decisions.push(`Did not read ${item.url}: ${item.reason}`);
    for (const item of selection.meta) await enrich(item.url, "meta", item.worthPaying, item.reason);
    for (const item of selection.extract) {
      const toolName = item.url.toLowerCase().split("?")[0]?.endsWith(".pdf") ? "pdf" : "extract";
      await enrich(item.url, toolName, item.worthPaying, item.reason);
    }
  } else if (candidates.size > 0 && !halt && !input.ledger.stopped) {
    decisions.push("Skipped paid enrichment because the remaining budget cannot cover a meta call plus slack.");
  }

  async function enrich(pageUrl: string, toolName: string, worthPaying: boolean, reason: string): Promise<void> {
    const tool = toolById(toolName);
    const canonical = canonicalUrl(pageUrl);
    if (!worthPaying) {
      skip({
        tool: toolName,
        url: pageUrl,
        method: tool?.method ?? "GET",
        errorCode: "planner_rejected",
        detail: reason,
        listPriceUsd: tool?.listPriceUsd,
      });
      return;
    }
    if (!canonical || !candidates.has(canonical)) {
      skip({
        tool: toolName,
        url: pageUrl,
        method: tool?.method ?? "GET",
        errorCode: "not_in_results",
        detail: "Refused a URL that was not in paid search results.",
        listPriceUsd: tool?.listPriceUsd,
      });
      return;
    }
    if (!hostAllowed(canonical, input.hostAllowlist)) {
      skip({
        tool: toolName,
        url: canonical,
        method: tool?.method ?? "GET",
        errorCode: "host_not_allowlisted",
        detail: "Host is outside SCOUT_HOST_ALLOWLIST.",
        listPriceUsd: tool?.listPriceUsd,
      });
      return;
    }
    if (checkHalt() || input.ledger.stopped) {
      skip({
        tool: toolName,
        url: canonical,
        method: tool?.method ?? "GET",
        errorCode: input.ledger.stopped ? "session_stopped" : halt === "aborted" ? "aborted" : "timeout",
        detail: "Not sent.",
        listPriceUsd: tool?.listPriceUsd,
      });
      return;
    }
    if (toolName === "meta" && metas >= input.maxMeta) {
      skip({
        tool: "meta",
        url: canonical,
        method: "GET",
        errorCode: "max_meta",
        detail: `Meta cap is ${input.maxMeta}.`,
        listPriceUsd: tool?.listPriceUsd,
      });
      return;
    }
    if (toolName !== "meta" && extracts >= input.maxExtracts) {
      skip({
        tool: toolName,
        url: canonical,
        method: "POST",
        errorCode: "max_extracts",
        detail: `Extract cap is ${input.maxExtracts}.`,
        listPriceUsd: tool?.listPriceUsd,
      });
      return;
    }
    let req: PaidRequest;
    try {
      req = buildToolRequest(input.agent402BaseUrl, { tool: toolName, url: canonical }, input.sessionId);
    } catch (err) {
      skip({
        tool: toolName,
        url: canonical,
        method: tool?.method ?? "GET",
        errorCode: "bad_request",
        detail: errorMessage(err),
        listPriceUsd: tool?.listPriceUsd,
      });
      return;
    }
    if (toolName === "meta") metas += 1;
    else extracts += 1;
    const result = await pay(req, canonical);
    if (
      toolName === "extract" &&
      result.receipt.outcome === "paid" &&
      pageIsThin(result.body) &&
      renders < input.maxRenders &&
      !checkHalt() &&
      !input.ledger.stopped
    ) {
      renders += 1;
      const renderReq = buildToolRequest(
        input.agent402BaseUrl,
        { tool: "render", url: canonical },
        input.sessionId,
      );
      await pay(renderReq, canonical);
    }
  }

  let summary = "No opportunities discovered within the budget.";
  let opportunities: Digest["opportunities"] = [];
  let dropped: Digest["dropped"] = [];
  const list = [...candidates.values()];
  if (halt === "aborted") {
    dropped = list.map((candidate) => ({
      url: candidate.url,
      title: candidate.title,
      reason: "Run aborted before scoring.",
    }));
    summary = "Run aborted. Paid calls were stopped. Nothing was scored after the abort.";
  } else if (list.length) {
    try {
      const report = await scoreCandidates(input.serv, { criteria: input.criteria, candidates: list });
      const applied = applyScores(list, report);
      opportunities = applied.opportunities;
      dropped = applied.dropped;
      summary = report.summary;
    } catch (err) {
      warnings.push(`Scoring failed: ${errorMessage(err)}`);
      summary = "Scoring did not finish. Receipts are still recorded.";
      dropped = list.map((candidate) => ({
        url: candidate.url,
        title: candidate.title,
        reason: "Unscored because SERV scoring failed.",
      }));
    }
  }

  const digest: Digest = {
    generatedAt: now().toISOString(),
    mode: input.mode,
    servModel: input.servModel,
    criteria: input.criteria,
    summary,
    decisions,
    warnings,
    opportunities,
    dropped,
    budget: {
      capUsd: input.ledger.capUsd(),
      sessionCapUsd: openedCapUsd,
      spentUsd: input.ledger.spentUsd(),
      remainingUsd: input.ledger.remainingUsd(),
      perTxCapUsd: input.perTxUsd,
      slackUsd: input.slackUsd,
    },
    receiptIds: receipts.map((receipt) => receipt.id),
    stoppedReason: halt ?? input.ledger.stopReason,
  };
  return { digest, receipts, stoppedReason: digest.stoppedReason };
}
