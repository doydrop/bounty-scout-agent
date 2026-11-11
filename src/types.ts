export type EntryCost = "free_or_gas" | "any";

export type BountyCategory = "contest" | "creative" | "defi" | "gigs";

export interface ScoutCriteria {
  chains: string[];
  entryCost: EntryCost;
  categories: BountyCategory[];
  maxEffortMinutes: number;
  budgetUsd: number;
  extraNotes?: string;
}

export interface ScoreParts {
  /** 0-10, higher = easier / fits the effort cap. */
  effort: number;
  /** 0-10, higher = cheaper to enter. */
  cost: number;
  /** 0-10, higher = better reward for the effort. */
  reward: number;
  /** 0-10, higher = actionable soon and not expired. */
  deadline: number;
  /** 0-10, higher = more legitimate. */
  legitimacy: number;
  /** Weighted. Always recomputed by the app. */
  overall: number;
}

export interface Opportunity {
  id: string;
  title: string;
  url: string;
  sourceHost: string;
  summary: string;
  chain?: string;
  category?: string;
  rewardText?: string;
  /** Model estimate, not a quote. */
  rewardUsdEstimate?: number;
  entryCostText?: string;
  /** ISO if parsed, otherwise the raw published string. */
  deadline?: string;
  effortMinutesEstimate?: number;
  scores: ScoreParts;
  rationale: string;
  evidenceReceiptIds: string[];
}

export type SpendOutcome =
  | "paid"
  | "skipped_budget"
  | "session_exhausted"
  | "failed"
  | "replayed";

export interface SpendReceipt {
  id: string;
  ts: string;
  tool: string;
  url: string;
  method: string;
  idempotencyKey: string;
  listPriceUsd?: number;
  paidAmount?: string;
  paidAsset?: string;
  sessionId?: string;
  /** Agent ledger running total after this line, in USD, decimal string. */
  spentTotal?: string;
  maxTotal?: string;
  merchantStatus?: number;
  chainId?: number;
  txReference?: string;
  outcome: SpendOutcome;
  errorCode?: string;
  /** Short human reason. Not part of the payment envelope. */
  detail?: string;
  /**
   * kpass returned status:error before any payment or usage object.
   * The ledger does not debit these.
   */
  prePayment?: boolean;
}

export interface BudgetSnapshot {
  /** Effective cap for this run (user budget, possibly tightened by the plan). */
  capUsd: number;
  sessionCapUsd: number;
  spentUsd: number;
  remainingUsd: number;
  perTxCapUsd: number;
  slackUsd: number;
}

export interface DroppedOpportunity {
  url: string;
  title: string;
  reason: string;
  legitimacy?: number;
}

export interface Digest {
  generatedAt: string;
  mode: "dry-run" | "live";
  servModel: string;
  criteria: ScoutCriteria;
  summary: string;
  decisions: string[];
  warnings: string[];
  opportunities: Opportunity[];
  dropped: DroppedOpportunity[];
  budget: BudgetSnapshot;
  receiptIds: string[];
  stoppedReason?: string;
}

export interface RunRecord {
  digest: Digest;
  receipts: SpendReceipt[];
  stoppedReason?: string;
}
