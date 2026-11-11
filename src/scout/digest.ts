import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import path from "node:path";
import { formatUsd } from "../money.js";
import type { Digest, RunRecord, SpendReceipt } from "../types.js";

function mdCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function linkTitle(title: string): string {
  return title.replace(/[\[\]]/g, "");
}

export function renderDigestMarkdown(digest: Digest, receipts: SpendReceipt[]): string {
  const lines: string[] = [
    "# Bounty Scout digest",
    "",
    `Generated: ${digest.generatedAt}`,
    `Mode: ${digest.mode}`,
    `Model: ${digest.servModel}`,
    `Spent: ${formatUsd(digest.budget.spentUsd)} of ${formatUsd(digest.budget.capUsd)} (session opened at ${formatUsd(digest.budget.sessionCapUsd)})`,
    `Per-transaction cap: ${formatUsd(digest.budget.perTxCapUsd)}. Slack reserved before each call: ${formatUsd(digest.budget.slackUsd)}.`,
    "",
    "## Summary",
    "",
    digest.summary,
    "",
    "## Spend decisions",
    "",
    ...digest.decisions.map((line) => `- ${line}`),
    "",
  ];
  if (digest.warnings.length) {
    lines.push("## Warnings", "", ...digest.warnings.map((line) => `- ${line}`), "");
  }
  lines.push("## Opportunities", "");
  if (!digest.opportunities.length) lines.push("_None ranked._", "");
  digest.opportunities.forEach((item, index) => {
    lines.push(
      `### ${index + 1}. ${linkTitle(item.title)} (${item.scores.overall.toFixed(2)})`,
      "",
      `- URL: ${item.url}`,
      `- Host: ${item.sourceHost}`,
      `- Chain: ${item.chain ?? "unspecified"}`,
      `- Category: ${item.category ?? "unspecified"}`,
      `- Reward: ${item.rewardText ?? "unspecified"}${item.rewardUsdEstimate !== undefined ? ` (model estimate ${formatUsd(item.rewardUsdEstimate)})` : ""}`,
      `- Entry: ${item.entryCostText ?? "unspecified"}`,
      `- Deadline: ${item.deadline ?? "unspecified"}`,
      `- Effort estimate: ${item.effortMinutesEstimate ?? "unspecified"} min`,
      `- Scores: effort ${item.scores.effort}, cost ${item.scores.cost}, reward ${item.scores.reward}, deadline ${item.scores.deadline}, legitimacy ${item.scores.legitimacy}`,
      `- Why: ${item.rationale}`,
      "",
    );
  });
  lines.push("## Dropped", "");
  if (!digest.dropped.length) lines.push("_None._", "");
  for (const item of digest.dropped) {
    const legitimacy = item.legitimacy === undefined ? "" : ` (legitimacy ${item.legitimacy})`;
    lines.push(`- ${linkTitle(item.title)} — ${item.url}${legitimacy}: ${item.reason}`);
  }
  lines.push("", "## Receipts", "", "| Time | Tool | Outcome | List | Paid | Running total | Status | Tx |", "| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const receipt of receipts) {
    lines.push(
      `| ${mdCell(receipt.ts)} | ${mdCell(receipt.tool)} | ${receipt.outcome} | ${receipt.listPriceUsd ?? ""} | ${receipt.paidAmount ?? ""} | ${receipt.spentTotal ?? ""} | ${receipt.merchantStatus ?? ""} | ${mdCell(receipt.txReference ?? receipt.errorCode ?? "")} |`,
    );
  }
  lines.push(
    "",
    "Opportunities can be scams. Scores are assistive. This agent does not apply to bounties and does not send funds to a listing.",
    "",
  );
  return lines.join("\n");
}

export interface SavedRun {
  record: RunRecord;
  jsonPath: string;
  markdownPath: string;
  receiptsPath: string;
}

export function saveRun(dataDir: string, record: RunRecord): SavedRun {
  mkdirSync(dataDir, { recursive: true });
  const jsonPath = path.join(dataDir, "last-digest.json");
  const markdownPath = path.join(dataDir, "last-digest.md");
  const receiptsPath = path.join(dataDir, "receipts.jsonl");
  const runPath = path.join(dataDir, "last-run.json");
  const markdown = renderDigestMarkdown(record.digest, record.receipts);
  writeFileSync(jsonPath, `${JSON.stringify(record.digest, null, 2)}\n`);
  writeFileSync(markdownPath, markdown);
  writeFileSync(runPath, `${JSON.stringify(record, null, 2)}\n`);
  const lines = record.receipts.map((receipt) => JSON.stringify(receipt)).join("\n");
  appendFileSync(receiptsPath, `${lines}\n`);
  return { record, jsonPath, markdownPath, receiptsPath };
}

export function loadLastRun(dataDir: string): RunRecord | null {
  const runPath = path.join(dataDir, "last-run.json");
  if (!existsSync(runPath)) return null;
  try {
    return JSON.parse(readFileSync(runPath, "utf8")) as RunRecord;
  } catch {
    return null;
  }
}
