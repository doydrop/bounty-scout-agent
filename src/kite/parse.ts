import { randomUUID } from "node:crypto";
import { stripSecrets } from "../secrets.js";
import type { SpendOutcome, SpendReceipt } from "../types.js";
import type { PaidRequest, PaidResult } from "./types.js";
import { SESSION_STOP_CODES } from "./types.js";

export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("kpass returned an empty response.");
  try {
    return JSON.parse(trimmed);
  } catch {
    // kpass sometimes prefixes a log line. Take the outermost object.
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("kpass did not return JSON.");
    return JSON.parse(trimmed.slice(start, end + 1));
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function dig(root: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = root;
  for (const key of path) {
    const record = asRecord(current);
    if (!record) return undefined;
    current = record[key];
  }
  return current;
}

export function toolIdFromUrl(url: string): string {
  let pathname = "";
  try {
    pathname = new URL(url).pathname.replace(/\/$/, "");
  } catch {
    return "unknown";
  }
  const known = [
    "search-lite",
    "search-news",
    "multi-search",
    "search",
    "answer",
    "extract",
    "render",
    "meta",
    "pdf",
    "screenshot",
  ];
  for (const id of known) {
    if (pathname === `/api/${id}` || pathname.endsWith(`/api/${id}`)) return id;
  }
  return pathname.split("/").filter(Boolean).pop() ?? "unknown";
}

export function txReferenceFrom(raw: Record<string, unknown>): string | undefined {
  const candidates = [
    dig(raw, ["payment", "payment_response", "reference"]),
    dig(raw, ["payment", "reference"]),
    dig(raw, ["txReference"]),
    dig(raw, ["x402", "tx_hash"]),
    dig(raw, ["x402", "transaction_hash"]),
  ];
  for (const candidate of candidates) {
    const text = asString(candidate);
    if (text) return text;
  }
  return undefined;
}

export function outcomeFromEnvelope(raw: Record<string, unknown>, merchantStatus: number): SpendOutcome {
  const status = asString(raw.status)?.toLowerCase();
  const errorCode = asString(raw.error_code) ?? asString(raw.errorCode);
  const hint = asString(raw.hint)?.toLowerCase() ?? "";
  const replayed =
    raw.replayed === true ||
    errorCode === "replayed" ||
    errorCode === "idempotent_replay" ||
    hint.includes("replay");
  if (replayed && (status === "success" || status === undefined)) return "replayed";
  if (errorCode && SESSION_STOP_CODES.has(errorCode)) return "session_exhausted";
  if (status && status !== "success") return "failed";
  if (merchantStatus >= 400) return "failed";
  return "paid";
}

export function merchantBody(raw: Record<string, unknown>): { status: number; body: unknown } {
  const x402 = asRecord(raw.x402);
  const status = asNumber(x402?.status_code) ?? asNumber(x402?.statusCode) ?? 0;
  if (!x402) return { status, body: null };
  if ("parsed_response_body" in x402 && x402.parsed_response_body !== undefined) {
    return { status, body: x402.parsed_response_body };
  }
  const text = asString(x402.response_body);
  if (!text) return { status, body: null };
  try {
    return { status, body: JSON.parse(text) };
  } catch {
    return { status, body: text };
  }
}

export function parseExecuteEnvelope(rawUnknown: unknown, req: PaidRequest, now = new Date()): PaidResult {
  const rawRecord = asRecord(rawUnknown);
  if (!rawRecord) throw new Error("kpass envelope was not a JSON object.");
  const { status, body } = merchantBody(rawRecord);
  const payment = asRecord(rawRecord.payment_requirement);
  const usage = asRecord(rawRecord.usage);
  const policy = asRecord(dig(rawRecord, ["delegation", "payment_policy"]) as unknown);
  const x402 = asRecord(rawRecord.x402);
  const outcome = outcomeFromEnvelope(rawRecord, status);
  const errorCode = asString(rawRecord.error_code) ?? asString(rawRecord.errorCode);
  const receipt: SpendReceipt = {
    id: `rct_${randomUUID()}`,
    ts: now.toISOString(),
    tool: toolIdFromUrl(req.url),
    url: req.url,
    method: req.method,
    idempotencyKey: req.idempotencyKey,
    paidAmount: asString(payment?.amount),
    paidAsset: asString(payment?.asset),
    sessionId: asString(rawRecord.session_id) ?? asString(rawRecord.sessionId) ?? req.sessionId,
    spentTotal: asString(usage?.spent_total) ?? asString(usage?.spentTotal),
    maxTotal: asString(policy?.max_total_amount) ?? asString(policy?.maxTotalAmount),
    merchantStatus: status,
    chainId: asNumber(x402?.chain_id) ?? asNumber(x402?.chainId),
    txReference: txReferenceFrom(rawRecord),
    outcome,
    errorCode,
    detail: asString(rawRecord.hint) ?? asString(rawRecord.user_message),
  };
  return {
    ok: outcome === "paid" || outcome === "replayed",
    merchantStatus: status,
    body,
    receipt,
    raw: stripSecrets(rawRecord),
  };
}

export interface SessionCreateInfo {
  sessionId?: string;
  requestId?: string;
  approvalUrl?: string;
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = asString(record[key]);
    if (value) return value;
  }
  return undefined;
}

export function parseSessionPayload(value: unknown): SessionCreateInfo {
  const root = asRecord(value) ?? {};
  const nested = asRecord(root.data) ?? asRecord(root.session) ?? asRecord(root.result) ?? {};
  const sources = [root, nested];
  let sessionId: string | undefined;
  let requestId: string | undefined;
  let approvalUrl: string | undefined;
  for (const source of sources) {
    sessionId ??= firstString(source, ["session_id", "sessionId", "id"]);
    requestId ??= firstString(source, ["request_id", "requestId"]);
    approvalUrl ??= firstString(source, ["approval_url", "approvalUrl", "url", "approve_url"]);
  }
  if (sessionId && sessionId.startsWith("asr_")) {
    requestId ??= sessionId;
    sessionId = undefined;
  }
  return { sessionId, requestId, approvalUrl };
}
