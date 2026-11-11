/** Integer micro-dollars (1e-6 USD) so $0.002 prices do not drift. */
export const MICRO = 1_000_000;

export function usdToMicro(usd: number): number {
  if (!Number.isFinite(usd)) {
    throw new Error("Invalid USD amount");
  }
  return Math.round(usd * MICRO);
}

export function microToUsd(micro: number): number {
  return micro / MICRO;
}

export function parseUsd(amount: string | undefined): number | null {
  if (amount === undefined || amount.trim() === "") return null;
  const n = Number(amount);
  if (!Number.isFinite(n) || n < 0) return null;
  return microToUsd(usdToMicro(n));
}

/** Decimal string without binary noise. $0.008 stays "0.008"; $0.25 stays "0.25". */
export function formatAmount(micro: number): string {
  const negative = micro < 0;
  const abs = Math.abs(micro);
  const text = (abs / MICRO).toFixed(6).replace(/0+$/, "").replace(/\.$/, ".00");
  return negative ? `-${text}` : text;
}

export function formatUsd(usd: number): string {
  return `$${formatAmount(usdToMicro(usd))}`;
}

/**
 * Weights documented in the hackathon write-up.
 * overall = 0.20*effort + 0.15*cost + 0.25*reward + 0.15*deadline + 0.25*legitimacy
 */
export const SCORE_WEIGHTS = {
  effort: 0.2,
  cost: 0.15,
  reward: 0.25,
  deadline: 0.15,
  legitimacy: 0.25,
} as const;

export const LEGITIMACY_DROP_BELOW = 4;

export function overallScore(parts: {
  effort: number;
  cost: number;
  reward: number;
  deadline: number;
  legitimacy: number;
}): number {
  const raw =
    SCORE_WEIGHTS.effort * parts.effort +
    SCORE_WEIGHTS.cost * parts.cost +
    SCORE_WEIGHTS.reward * parts.reward +
    SCORE_WEIGHTS.deadline * parts.deadline +
    SCORE_WEIGHTS.legitimacy * parts.legitimacy;
  return Math.round(raw * 100) / 100;
}
