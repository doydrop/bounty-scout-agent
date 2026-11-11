import { createHash } from "node:crypto";

export interface Candidate {
  url: string;
  sourceHost: string;
  title: string;
  snippet: string;
  publishedAt?: string;
  fromTools: string[];
  receiptIds: string[];
  metaTitle?: string;
  metaDescription?: string;
  pageExcerpt?: string;
  pageSample?: string;
}

export function clip(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(0, max - 1))}…`;
}

export function canonicalUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname) return null;
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
      url.pathname = url.pathname.slice(0, -1);
    }
    return url.toString();
  } catch {
    return null;
  }
}

export function opportunityId(url: string): string {
  const hash = createHash("sha256").update(url).digest("hex").slice(0, 12);
  return `opp_${hash}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function candidatesFromSearch(tool: string, body: unknown, receiptId: string): Candidate[] {
  const record = asRecord(body);
  if (!record || !Array.isArray(record.results)) return [];
  const out: Candidate[] = [];
  for (const item of record.results) {
    const row = asRecord(item);
    if (!row) continue;
    const url = canonicalUrl(typeof row.url === "string" ? row.url : "");
    if (!url) continue;
    out.push({
      url,
      sourceHost: new URL(url).hostname,
      title: clip(row.title, 180) || url,
      snippet: clip(row.description, 500),
      publishedAt: typeof row.publishedAt === "string" ? row.publishedAt : undefined,
      fromTools: [tool],
      receiptIds: [receiptId],
    });
  }
  return out;
}

export function mergeCandidate(into: Map<string, Candidate>, next: Candidate): void {
  const existing = into.get(next.url);
  if (!existing) {
    into.set(next.url, next);
    return;
  }
  if (!existing.snippet && next.snippet) existing.snippet = next.snippet;
  if (existing.title === existing.url && next.title) existing.title = next.title;
  if (!existing.publishedAt && next.publishedAt) existing.publishedAt = next.publishedAt;
  for (const tool of next.fromTools) {
    if (!existing.fromTools.includes(tool)) existing.fromTools.push(tool);
  }
  for (const id of next.receiptIds) {
    if (!existing.receiptIds.includes(id)) existing.receiptIds.push(id);
  }
}

export function applyPage(candidate: Candidate, tool: string, body: unknown, receiptId: string): void {
  if (!candidate.receiptIds.includes(receiptId)) candidate.receiptIds.push(receiptId);
  if (!candidate.fromTools.includes(tool)) candidate.fromTools.push(tool);
  const record = asRecord(body);
  if (!record) return;
  if (tool === "meta") {
    candidate.metaTitle = clip(record.title, 180) || candidate.metaTitle;
    candidate.metaDescription = clip(record.description, 500) || candidate.metaDescription;
    if (candidate.metaTitle && (candidate.title === candidate.url || candidate.title.length < 3)) {
      candidate.title = candidate.metaTitle;
    }
    return;
  }
  const excerpt = clip(record.excerpt, 600);
  const markdown = clip(record.markdown ?? record.text, 1500);
  candidate.pageExcerpt = excerpt || candidate.pageExcerpt;
  candidate.pageSample = markdown || candidate.pageSample;
  const title = clip(record.title, 180);
  if (title) candidate.title = title;
}

export function pageIsThin(body: unknown): boolean {
  const record = asRecord(body);
  if (!record) return true;
  const markdown = typeof record.markdown === "string" ? record.markdown : "";
  const text = typeof record.text === "string" ? record.text : "";
  return markdown.trim().length < 40 && text.trim().length < 40;
}

export function evidenceForScore(candidate: Candidate): Record<string, string> {
  return {
    url: candidate.url,
    host: candidate.sourceHost,
    title: candidate.title,
    snippet: candidate.snippet,
    metaDescription: candidate.metaDescription ?? "",
    excerpt: candidate.pageExcerpt ?? "",
    pageSample: candidate.pageSample ?? "",
    publishedAt: candidate.publishedAt ?? "",
  };
}
