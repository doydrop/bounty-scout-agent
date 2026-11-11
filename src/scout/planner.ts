import { catalogForPrompt } from "../tools/catalog.js";
import type { ServClient } from "../serv/client.js";
import { PLANNER_SYSTEM, SELECT_SYSTEM, plannerUserPrompt, selectUserPrompt } from "../serv/prompts.js";
import { planSchema, selectSchema, type Plan, type Selection } from "../serv/schemas.js";
import type { ScoutCriteria } from "../types.js";
import type { Candidate } from "./candidates.js";

export async function planDiscovery(
  serv: ServClient,
  input: {
    criteria: ScoutCriteria;
    remainingUsd: number;
    slackUsd: number;
    perTxUsd: number;
    maxSearches: number;
    allowAnswer: boolean;
  },
): Promise<Plan> {
  const result = await serv.completeJson({
    schemaName: "scout_plan",
    schema: planSchema,
    system: PLANNER_SYSTEM,
    user: plannerUserPrompt({
      ...input,
      catalog: catalogForPrompt(input.allowAnswer),
    }),
    maxTokens: 2048,
  });
  return result.data;
}

export async function selectEnrichment(
  serv: ServClient,
  input: {
    criteria: ScoutCriteria;
    remainingUsd: number;
    slackUsd: number;
    maxMeta: number;
    maxExtracts: number;
    candidates: Candidate[];
  },
): Promise<Selection> {
  const result = await serv.completeJson({
    schemaName: "scout_select",
    schema: selectSchema,
    system: SELECT_SYSTEM,
    user: selectUserPrompt(input),
    maxTokens: 1500,
  });
  return result.data;
}

export function fallbackSelection(candidates: Candidate[], maxExtract: number, maxMeta: number): Selection {
  const top = candidates.slice(0, maxExtract);
  return {
    rationale: "Deterministic fallback: SERV selection was unavailable, so URLs are taken in discovery order.",
    meta: top.slice(0, maxMeta).map((candidate) => ({
      url: candidate.url,
      reason: "fallback meta",
      worthPaying: true,
    })),
    extract: top.map((candidate) => ({
      url: candidate.url,
      reason: "fallback extract",
      worthPaying: true,
    })),
    rejected: candidates.slice(maxExtract).map((candidate) => ({
      url: candidate.url,
      reason: "over the extract cap",
    })),
  };
}
