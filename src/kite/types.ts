import type { SpendReceipt } from "../types.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface PaidRequest {
  url: string;
  method: HttpMethod;
  headers?: Record<string, string>;
  /** JSON-serializable. Omit for GET. */
  body?: unknown;
  idempotencyKey: string;
  sessionId?: string;
}

export interface PaidResult {
  ok: boolean;
  merchantStatus: number;
  body: unknown;
  receipt: SpendReceipt;
  /** Full envelope with secrets stripped. Never log the unstripped payload. */
  raw: unknown;
}

export interface KitePayer {
  execute(req: PaidRequest): Promise<PaidResult>;
  remainingBudgetUsd(): Promise<number>;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface CommandRunner {
  (args: string[], opts: { timeoutMs: number; signal?: AbortSignal; cwd?: string }): Promise<CommandResult>;
}

/**
 * Passport error codes that mean "stop spending".
 * `session_not_found` stops the run but stays outcome `failed`: kpass never paid.
 */
export const SESSION_STOP_CODES = new Set([
  "session_total_exceeded",
  "separate_session_used_up",
  "insufficient_balance",
  "wallet_empty",
  "payment_cap_exceeded",
  "session_expired",
  "session_not_found",
]);

export class PayerError extends Error {
  readonly debit: boolean;
  constructor(message: string, debit = true) {
    super(message);
    this.name = "PayerError";
    this.debit = debit;
  }
}
