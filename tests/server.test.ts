import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { PROJECT_ROOT, loadConfig } from "../src/config.js";
import { createApp } from "../src/server/app.js";

function app() {
  const dataDir = mkdtempSync(path.join(tmpdir(), "scout-http-"));
  const config = loadConfig(
    {
      SCOUT_MODE: "dry-run",
      SCOUT_DATA_DIR: dataDir,
      SCOUT_BUDGET_USD: "0.25",
      SCOUT_DRY_RUN_DELAY_MS: "0",
    },
    { kpassExists: false, loadEnvFile: false, root: PROJECT_ROOT },
  );
  return createApp(config);
}

async function waitForIdle(server: ReturnType<typeof createApp>): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const state = (await (await server.request("/api/state")).json()) as { running: boolean };
    if (!state.running) return state as Record<string, unknown>;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("run did not finish");
}

describe("dashboard API", () => {
  it("serves the page and a dry-run digest", async () => {
    const server = app();
    const page = await server.request("/");
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /Bounty Scout/);
    assert.match(html, /Receipts/);
    assert.equal(html.includes("src=\"http"), false);

    const health = await (await server.request("/api/health")).json();
    assert.equal(health.mode, "dry-run");

    const started = await server.request("/api/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chains: "solana",
        entryCost: "free_or_gas",
        categories: "contest,creative,defi,gigs",
        maxEffortMinutes: 30,
        budgetUsd: 0.25,
      }),
    });
    assert.equal(started.status, 202);
    const state = await waitForIdle(server);
    const digest = state.digest as { opportunities: unknown[]; mode: string; budget: { spentUsd: number } };
    assert.equal(digest.mode, "dry-run");
    assert.ok(digest.opportunities.length >= 3);
    assert.ok(digest.budget.spentUsd > 0);
    assert.ok(digest.budget.spentUsd <= 0.25);
    const receipts = state.receipts as Array<{ outcome: string; tool: string }>;
    assert.ok(receipts.some((receipt) => receipt.outcome === "paid"));
    assert.ok(receipts.some((receipt) => receipt.tool === "answer" && receipt.outcome === "skipped_budget"));

    const digestRoute = await (await server.request("/api/digest")).json();
    assert.equal((digestRoute.digest as { mode: string }).mode, "dry-run");
    const receiptRoute = await (await server.request("/api/receipts")).json();
    assert.ok(Array.isArray(receiptRoute.receipts));
  });
});
