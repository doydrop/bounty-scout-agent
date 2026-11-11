import { toolIdFromUrl } from "../kite/parse.js";

export interface ToolDef {
  id: string;
  method: "GET" | "POST";
  path: string;
  /** List price in USD from Agent402 OpenAPI /api/pricing (11 Nov 2026). */
  listPriceUsd: number;
  description: string;
  /** Included in the default planner allowlist. */
  defaultAllow: boolean;
}

export const TOOL_CATALOG: readonly ToolDef[] = [
  {
    id: "search",
    method: "GET",
    path: "/api/search",
    listPriceUsd: 0.01,
    description: "Web search. Query q (max 400), count 1-20, freshness pd|pw|pm|py.",
    defaultAllow: true,
  },
  {
    id: "search-lite",
    method: "GET",
    path: "/api/search-lite",
    listPriceUsd: 0.008,
    description: "Cheaper web search, smaller result set. Same query family as search.",
    defaultAllow: true,
  },
  {
    id: "search-news",
    method: "GET",
    path: "/api/search-news",
    listPriceUsd: 0.01,
    description: "News search. q, count 1-50, freshness, country.",
    defaultAllow: true,
  },
  {
    id: "answer",
    method: "GET",
    path: "/api/answer",
    listPriceUsd: 0.08,
    description: "Synthesized web answer. One call is a large share of a $0.25 budget. Off by default.",
    defaultAllow: false,
  },
  {
    id: "extract",
    method: "POST",
    path: "/api/extract",
    listPriceUsd: 0.01,
    description: "Extract a known URL to markdown.",
    defaultAllow: true,
  },
  {
    id: "render",
    method: "POST",
    path: "/api/render",
    listPriceUsd: 0.01,
    description: "Browser-render a page when extract returns an empty JS shell.",
    defaultAllow: true,
  },
  {
    id: "meta",
    method: "GET",
    path: "/api/meta",
    listPriceUsd: 0.002,
    description: "Cheap title, description, and social metadata.",
    defaultAllow: true,
  },
  {
    id: "pdf",
    method: "POST",
    path: "/api/pdf",
    listPriceUsd: 0.01,
    description: "PDF URL to text.",
    defaultAllow: true,
  },
] as const;

const BY_ID = new Map(TOOL_CATALOG.map((tool) => [tool.id, tool]));

export function toolById(id: string): ToolDef | undefined {
  return BY_ID.get(id);
}

export function resolveTool(url: string): ToolDef | undefined {
  return toolById(toolIdFromUrl(url));
}

export function catalogForPrompt(allowAnswer: boolean): Array<{
  id: string;
  method: string;
  path: string;
  listPriceUsd: number;
  description: string;
}> {
  return TOOL_CATALOG.filter((tool) => tool.defaultAllow || (tool.id === "answer" && allowAnswer)).map(
    (tool) => ({
      id: tool.id,
      method: tool.method,
      path: tool.path,
      listPriceUsd: tool.listPriceUsd,
      description: tool.description,
    }),
  );
}
