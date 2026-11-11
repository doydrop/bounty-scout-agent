#!/usr/bin/env bash
# End-to-end dry-run. Does not call SERV or Kite and does not spend.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ ! -d node_modules ]]; then
  pnpm install
fi

export SCOUT_MODE=dry-run
export SCOUT_DRY_RUN_DELAY_MS=0
unset OPENSERV_API_KEY SERV_API_KEY KITE_AGENT_TOKEN || true

rm -f data/last-digest.json data/last-digest.md data/last-run.json data/receipts.jsonl

pnpm exec tsx src/cli.ts run \
  --dry-run \
  --chains solana \
  --budget 0.25 \
  --entry free_or_gas \
  --categories contest,creative,defi,gigs \
  --max-effort 30

pnpm exec tsx src/cli.ts digest > data/demo-digest.txt

node --input-type=module <<'NODE'
import fs from "node:fs";

const digest = JSON.parse(fs.readFileSync("data/last-digest.json", "utf8"));
const receipts = fs.readFileSync("data/receipts.jsonl", "utf8").trim().split("\n").map((line) => JSON.parse(line));
if (digest.mode !== "dry-run") {
  console.error("expected dry-run digest");
  process.exit(1);
}
if (!Array.isArray(digest.opportunities) || digest.opportunities.length < 3) {
  console.error("expected at least 3 ranked opportunities");
  process.exit(1);
}
const urls = digest.opportunities.map((item) => item.url);
if (new Set(urls).size !== urls.length) {
  console.error("duplicate opportunity urls");
  process.exit(1);
}
for (let i = 1; i < digest.opportunities.length; i += 1) {
  if (digest.opportunities[i].scores.overall > digest.opportunities[i - 1].scores.overall) {
    console.error("opportunities are not ranked");
    process.exit(1);
  }
}
const paid = receipts.filter((receipt) => receipt.outcome === "paid");
const skipped = receipts.filter((receipt) => receipt.outcome === "skipped_budget");
if (paid.length < 5) {
  console.error("expected several paid receipts");
  process.exit(1);
}
if (!skipped.some((receipt) => receipt.tool === "answer")) {
  console.error("expected the answer tool to be skipped");
  process.exit(1);
}
if (!(digest.budget.spentUsd > 0) || digest.budget.spentUsd > digest.budget.capUsd) {
  console.error("spent outside the cap", digest.budget);
  process.exit(1);
}
if (digest.dropped.some((item) => (item.legitimacy ?? 10) >= 4 && item.url.includes("claim-sol-bonus"))) {
  console.error("scam listing should be dropped");
  process.exit(1);
}
const blob = JSON.stringify({ digest, receipts });
if (blob.includes("OPENSERV_API_KEY") || /sk-[A-Za-z0-9]{8,}/.test(blob)) {
  console.error("digest leaked a secret-like value");
  process.exit(1);
}
console.log(
  `demo ok: ${digest.opportunities.length} ranked, ${digest.dropped.length} dropped, ${paid.length} paid, ${skipped.length} skipped, spent $${digest.budget.spentUsd}`,
);
NODE

echo "Dry-run artifacts: data/last-digest.md data/last-digest.json data/receipts.jsonl"
echo "Dashboard: pnpm scout serve   then open http://127.0.0.1:8787"
