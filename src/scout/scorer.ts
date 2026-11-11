import { LEGITIMACY_DROP_BELOW, overallScore } from "../money.js";
import type { ServClient } from "../serv/client.js";
import { SCORER_SYSTEM, scoreUserPrompt } from "../serv/prompts.js";
import { scoreSchema, type ScoreReport } from "../serv/schemas.js";
import type { DroppedOpportunity, Opportunity, ScoutCriteria } from "../types.js";
import { evidenceForScore, opportunityId, type Candidate } from "./candidates.js";

export async function scoreCandidates(
  serv: ServClient,
  input: { criteria: ScoutCriteria; candidates: Candidate[] },
): Promise<ScoreReport> {
  const result = await serv.completeJson({
    schemaName: "scout_score",
    schema: scoreSchema,
    system: SCORER_SYSTEM,
    user: scoreUserPrompt({
      criteria: input.criteria,
      evidence: input.candidates.map(evidenceForScore),
    }),
    maxTokens: 3000,
  });
  return result.data;
}

export function applyScores(
  candidates: Candidate[],
  report: ScoreReport,
): { opportunities: Opportunity[]; dropped: DroppedOpportunity[] } {
  const byUrl = new Map(candidates.map((candidate) => [candidate.url, candidate]));
  const opportunities: Opportunity[] = [];
  const dropped: DroppedOpportunity[] = [];
  const seen = new Set<string>();

  for (const item of report.items) {
    const candidate = byUrl.get(item.url);
    if (!candidate || seen.has(item.url)) continue;
    seen.add(item.url);
    const scores = {
      ...item.scores,
      overall: overallScore(item.scores),
    };
    if (scores.legitimacy < LEGITIMACY_DROP_BELOW) {
      dropped.push({
        url: candidate.url,
        title: item.title || candidate.title,
        reason: item.rationale || "Legitimacy is below 4.",
        legitimacy: scores.legitimacy,
      });
      continue;
    }
    opportunities.push({
      id: opportunityId(candidate.url),
      title: item.title || candidate.title,
      url: candidate.url,
      sourceHost: candidate.sourceHost,
      summary: item.summary,
      chain: item.chain || undefined,
      category: item.category,
      rewardText: item.rewardText || undefined,
      rewardUsdEstimate: item.rewardUsdEstimate ?? undefined,
      entryCostText: item.entryCostText || undefined,
      deadline: item.deadline || candidate.publishedAt,
      effortMinutesEstimate: item.effortMinutesEstimate,
      scores,
      rationale: item.rationale,
      evidenceReceiptIds: candidate.receiptIds,
    });
  }

  for (const candidate of candidates) {
    if (seen.has(candidate.url)) continue;
    dropped.push({
      url: candidate.url,
      title: candidate.title,
      reason: "SERV did not return a score for this URL.",
    });
  }

  opportunities.sort((a, b) => {
    if (b.scores.overall !== a.scores.overall) return b.scores.overall - a.scores.overall;
    if (b.scores.legitimacy !== a.scores.legitimacy) return b.scores.legitimacy - a.scores.legitimacy;
    return a.title.localeCompare(b.title);
  });
  return { opportunities, dropped };
}
