import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildToolRequest } from "../src/tools/agent402.js";
import { TOOL_CATALOG, resolveTool } from "../src/tools/catalog.js";
import { canonicalUrl, candidatesFromSearch } from "../src/scout/candidates.js";

describe("agent402 catalog", () => {
  it("pins the list prices used for preflight checks", () => {
    const prices = Object.fromEntries(TOOL_CATALOG.map((tool) => [tool.id, tool.listPriceUsd]));
    assert.deepEqual(prices, {
      search: 0.01,
      "search-lite": 0.008,
      "search-news": 0.01,
      answer: 0.08,
      extract: 0.01,
      render: 0.01,
      meta: 0.002,
      pdf: 0.01,
    });
  });

  it("builds an explicit GET for search and a JSON POST for extract", () => {
    const search = buildToolRequest("https://agent402.tools", {
      tool: "search",
      query: "Solana bounty",
      count: 50,
      freshness: "pw",
    });
    assert.equal(search.method, "GET");
    assert.equal(search.body, undefined);
    const url = new URL(search.url);
    assert.equal(url.pathname, "/api/search");
    assert.equal(url.searchParams.get("q"), "Solana bounty");
    assert.equal(url.searchParams.get("count"), "20");
    assert.equal(url.searchParams.get("freshness"), "pw");
    assert.equal(resolveTool(search.url)?.id, "search");

    const extract = buildToolRequest("https://agent402.tools/", {
      tool: "extract",
      url: "https://earn.superteam.fun/listings/demo",
    });
    assert.equal(extract.method, "POST");
    assert.equal(new URL(extract.url).pathname, "/api/extract");
    assert.deepEqual(extract.body, { url: "https://earn.superteam.fun/listings/demo" });
    assert.equal(extract.headers?.["Content-Type"], "application/json");
  });

  it("refuses non-http page targets", () => {
    assert.throws(() => buildToolRequest("https://agent402.tools", { tool: "meta", url: "javascript:alert(1)" }));
    assert.throws(() => buildToolRequest("https://agent402.tools", { tool: "pdf", url: "file:///tmp/brief.pdf" }));
  });

  it("canonicalizes and drops unsafe search hits", () => {
    assert.equal(
      canonicalUrl("https://Earn.Superteam.fun/listings/solana-blinks-design-sprint/"),
      "https://earn.superteam.fun/listings/solana-blinks-design-sprint",
    );
    assert.equal(canonicalUrl("javascript:alert(1)"), null);
    const found = candidatesFromSearch(
      "search",
      {
        results: [
          { title: "ok", url: "https://Example.com/a/", description: "one" },
          { title: "bad", url: "javascript:alert(1)", description: "two" },
          { title: "ok", url: "https://example.com/a", description: "dup" },
        ],
      },
      "rct_1",
    );
    assert.equal(found.length, 2);
    assert.equal(found[0]?.url, "https://example.com/a");
    assert.equal(found[1]?.url, "https://example.com/a");
  });
});
