import { randomUUID } from "node:crypto";
import type { PaidRequest } from "../kite/types.js";
import { toolById, type ToolDef } from "./catalog.js";

const SEARCH_TOOLS = new Set(["search", "search-lite", "search-news", "answer"]);
const PAGE_TOOLS = new Set(["extract", "render", "meta", "pdf"]);

export interface ToolCallInput {
  tool: string;
  query?: string;
  count?: number;
  freshness?: string;
  country?: string;
  url?: string;
}

export function assertPublicHttpUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("URL is not absolute.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Refusing non-http URL scheme ${parsed.protocol}`);
  }
  if (!parsed.hostname) throw new Error("URL is missing a host.");
  return parsed;
}

export function clampCount(tool: string, count: number | undefined): number {
  const fallback = tool === "search-lite" ? 5 : tool === "search-news" ? 5 : 8;
  const requested = count === undefined || count < 1 ? fallback : Math.floor(count);
  if (tool === "search-lite") return Math.min(5, requested);
  if (tool === "search-news") return Math.min(50, requested);
  if (tool === "search") return Math.min(20, requested);
  return requested;
}

export function buildToolRequest(baseUrl: string, input: ToolCallInput, sessionId?: string): PaidRequest {
  const tool = toolById(input.tool);
  if (!tool) throw new Error(`Unknown tool "${input.tool}".`);
  const origin = baseUrl.replace(/\/$/, "");
  if (SEARCH_TOOLS.has(tool.id)) {
    const query = (input.query ?? "").trim().slice(0, 400);
    if (!query) throw new Error(`${tool.id} requires a query.`);
    const url = new URL(tool.path, `${origin}/`);
    url.searchParams.set("q", query);
    if (tool.id !== "answer") {
      url.searchParams.set("count", String(clampCount(tool.id, input.count)));
    }
    if (input.freshness && ["pd", "pw", "pm", "py"].includes(input.freshness)) {
      url.searchParams.set("freshness", input.freshness);
    }
    if (input.country && (tool.id === "search-news" || tool.id === "answer")) {
      url.searchParams.set("country", input.country.slice(0, 8));
    }
    return {
      url: url.toString(),
      method: "GET",
      idempotencyKey: randomUUID(),
      sessionId,
    };
  }
  if (PAGE_TOOLS.has(tool.id)) {
    const page = assertPublicHttpUrl(input.url ?? "");
    if (tool.method === "GET") {
      const url = new URL(tool.path, `${origin}/`);
      url.searchParams.set("url", page.toString());
      return {
        url: url.toString(),
        method: "GET",
        idempotencyKey: randomUUID(),
        sessionId,
      };
    }
    return {
      url: new URL(tool.path, `${origin}/`).toString(),
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: { url: page.toString() },
      idempotencyKey: randomUUID(),
      sessionId,
    };
  }
  throw new Error(`No request builder for ${tool.id}.`);
}

export function pageToolForUrl(url: string): ToolDef {
  const path = assertPublicHttpUrl(url).pathname.toLowerCase();
  if (path.endsWith(".pdf")) return toolById("pdf")!;
  return toolById("extract")!;
}
