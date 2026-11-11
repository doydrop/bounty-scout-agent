import { z } from "zod";

export const TOOL_IDS = [
  "search",
  "search-lite",
  "search-news",
  "answer",
  "extract",
  "render",
  "meta",
  "pdf",
] as const;

export const planCallSchema = z.object({
  tool: z.enum(TOOL_IDS),
  reason: z.string().min(1),
  query: z.string(),
  count: z.number().int().nonnegative(),
  freshness: z.enum(["", "pd", "pw", "pm", "py"]),
  country: z.string(),
  url: z.string(),
});

export const rejectedToolSchema = z.object({
  tool: z.string().min(1),
  reason: z.string().min(1),
  url: z.string(),
});

export const planSchema = z.object({
  rationale: z.string().min(1),
  maxPaidUsd: z.number().nonnegative(),
  calls: z.array(planCallSchema),
  rejected: z.array(rejectedToolSchema),
});

export const enrichItemSchema = z.object({
  url: z.string().min(1),
  reason: z.string().min(1),
  worthPaying: z.boolean(),
});

export const selectSchema = z.object({
  rationale: z.string().min(1),
  meta: z.array(enrichItemSchema),
  extract: z.array(enrichItemSchema),
  rejected: z.array(z.object({ url: z.string().min(1), reason: z.string().min(1) })),
});

const scoreNumber = z.number().min(0).max(10);

export const scoreItemSchema = z.object({
  url: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().min(1),
  chain: z.string(),
  category: z.enum(["contest", "creative", "defi", "gigs", "other"]),
  rewardText: z.string(),
  rewardUsdEstimate: z.number().nullable(),
  entryCostText: z.string(),
  deadline: z.string(),
  effortMinutesEstimate: z.number().nonnegative(),
  scores: z.object({
    effort: scoreNumber,
    cost: scoreNumber,
    reward: scoreNumber,
    deadline: scoreNumber,
    legitimacy: scoreNumber,
  }),
  rationale: z.string().min(1),
});

export const scoreSchema = z.object({
  summary: z.string().min(1),
  items: z.array(scoreItemSchema),
});

export type Plan = z.infer<typeof planSchema>;
export type PlanCall = z.infer<typeof planCallSchema>;
export type Selection = z.infer<typeof selectSchema>;
export type ScoreReport = z.infer<typeof scoreSchema>;
export type ScoreItem = z.infer<typeof scoreItemSchema>;

const strictObject = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});

const callJson = strictObject(
  {
    tool: { type: "string", enum: [...TOOL_IDS] },
    reason: { type: "string" },
    query: { type: "string" },
    count: { type: "integer", minimum: 0 },
    freshness: { type: "string", enum: ["", "pd", "pw", "pm", "py"] },
    country: { type: "string" },
    url: { type: "string" },
  },
  ["tool", "reason", "query", "count", "freshness", "country", "url"],
);

export const JSON_SCHEMAS: Record<string, Record<string, unknown>> = {
  scout_plan: strictObject(
    {
      rationale: { type: "string" },
      maxPaidUsd: { type: "number", minimum: 0 },
      calls: { type: "array", items: callJson },
      rejected: {
        type: "array",
        items: strictObject(
          { tool: { type: "string" }, reason: { type: "string" }, url: { type: "string" } },
          ["tool", "reason", "url"],
        ),
      },
    },
    ["rationale", "maxPaidUsd", "calls", "rejected"],
  ),
  scout_select: strictObject(
    {
      rationale: { type: "string" },
      meta: {
        type: "array",
        items: strictObject(
          { url: { type: "string" }, reason: { type: "string" }, worthPaying: { type: "boolean" } },
          ["url", "reason", "worthPaying"],
        ),
      },
      extract: {
        type: "array",
        items: strictObject(
          { url: { type: "string" }, reason: { type: "string" }, worthPaying: { type: "boolean" } },
          ["url", "reason", "worthPaying"],
        ),
      },
      rejected: {
        type: "array",
        items: strictObject(
          { url: { type: "string" }, reason: { type: "string" } },
          ["url", "reason"],
        ),
      },
    },
    ["rationale", "meta", "extract", "rejected"],
  ),
  scout_score: strictObject(
    {
      summary: { type: "string" },
      items: {
        type: "array",
        items: strictObject(
          {
            url: { type: "string" },
            title: { type: "string" },
            summary: { type: "string" },
            chain: { type: "string" },
            category: { type: "string", enum: ["contest", "creative", "defi", "gigs", "other"] },
            rewardText: { type: "string" },
            rewardUsdEstimate: { type: ["number", "null"] },
            entryCostText: { type: "string" },
            deadline: { type: "string" },
            effortMinutesEstimate: { type: "number", minimum: 0 },
            scores: strictObject(
              {
                effort: { type: "number", minimum: 0, maximum: 10 },
                cost: { type: "number", minimum: 0, maximum: 10 },
                reward: { type: "number", minimum: 0, maximum: 10 },
                deadline: { type: "number", minimum: 0, maximum: 10 },
                legitimacy: { type: "number", minimum: 0, maximum: 10 },
              },
              ["effort", "cost", "reward", "deadline", "legitimacy"],
            ),
            rationale: { type: "string" },
          },
          [
            "url",
            "title",
            "summary",
            "chain",
            "category",
            "rewardText",
            "rewardUsdEstimate",
            "entryCostText",
            "deadline",
            "effortMinutesEstimate",
            "scores",
            "rationale",
          ],
        ),
      },
    },
    ["summary", "items"],
  ),
};
