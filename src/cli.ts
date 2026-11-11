import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { loadConfig, parseCategories, parseChains, parseEntryCost } from "./config.js";
import { createKiteSession, listActiveSessions } from "./kite/kpass.js";
import { formatUsd } from "./money.js";
import { createRuntime } from "./runtime.js";
import { loadLastRun, renderDigestMarkdown } from "./scout/digest.js";
import { errorMessage } from "./secrets.js";
import { startServer } from "./server/app.js";
import type { RunOverrides } from "./runtime.js";

const HELP = `Bounty Scout Agent — rank crypto bounties inside a Kite Passport budget.

Usage:
  bounty-scout run [--chains solana] [--budget 0.25] [--entry free_or_gas]
                   [--categories contest,creative,defi,gigs] [--max-effort 30]
                   [--notes text] [--dry-run | --live]
  bounty-scout digest
  bounty-scout serve [--port 8787] [--host 127.0.0.1]
  bounty-scout session create [--dry-run] [--no-wait]
  bounty-scout session status

Dry-run is the default until OPENSERV_API_KEY (or SERV_API_KEY) is set and kpass is on PATH.
Dry-run uses fixtures/dry-run/scout.json and does not spend. Live mode pays Agent402 through
kpass session execute under the session cap (default $0.05 per call, $0.25 total).
`;

function flagString(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function takeRunOverrides(argv: string[]): { overrides: RunOverrides; dryRun: boolean; live: boolean } {
  const { values } = parseArgs({
    args: argv,
    options: {
      chains: { type: "string" },
      budget: { type: "string" },
      entry: { type: "string" },
      categories: { type: "string" },
      "max-effort": { type: "string" },
      notes: { type: "string" },
      "dry-run": { type: "boolean" },
      live: { type: "boolean" },
    },
    strict: true,
  });
  const overrides: RunOverrides = {};
  if (values.chains) overrides.chains = parseChains(flagString(values.chains));
  if (values.entry) overrides.entryCost = parseEntryCost(flagString(values.entry));
  if (values.categories) overrides.categories = parseCategories(flagString(values.categories));
  if (values["max-effort"]) {
    const n = Number(values["max-effort"]);
    if (!Number.isInteger(n) || n <= 0) throw new Error("--max-effort must be a positive integer.");
    overrides.maxEffortMinutes = n;
  }
  if (values.budget) overrides.budgetUsd = Number(values.budget);
  if (values.notes) overrides.extraNotes = flagString(values.notes);
  return { overrides, dryRun: values["dry-run"] === true, live: values.live === true };
}

function applyModeFlags(env: NodeJS.ProcessEnv, flags: { dryRun: boolean; live: boolean }): void {
  if (flags.dryRun && flags.live) throw new Error("Pass only one of --dry-run or --live.");
  if (flags.dryRun) env.SCOUT_MODE = "dry-run";
  if (flags.live) env.SCOUT_MODE = "live";
}

export function formatReceiptLine(receipt: {
  outcome: string;
  tool: string;
  listPriceUsd?: number;
  paidAmount?: string;
  spentTotal?: string;
  errorCode?: string;
  detail?: string;
}): string {
  const paid = receipt.paidAmount ? `paid ${receipt.paidAmount}` : "paid -";
  const list = receipt.listPriceUsd === undefined ? "list -" : `list ${receipt.listPriceUsd}`;
  const total = receipt.spentTotal ? `total ${receipt.spentTotal}` : "total -";
  const code = receipt.errorCode ? ` ${receipt.errorCode}` : "";
  const detail = receipt.detail ? ` ${receipt.detail}` : "";
  return `  ${receipt.outcome.padEnd(18)} ${receipt.tool.padEnd(12)} ${list.padEnd(12)} ${paid.padEnd(14)} ${total}${code}${detail}`;
}

function printReceiptLine(receipt: Parameters<typeof formatReceiptLine>[0]): void {
  console.log(formatReceiptLine(receipt));
}

async function cmdRun(argv: string[]): Promise<void> {
  const parsed = takeRunOverrides(argv);
  applyModeFlags(process.env, parsed);
  const config = loadConfig();
  const runtime = createRuntime(config);
  console.log(`Bounty Scout (${config.mode})`);
  console.log(
    `Budget ${formatUsd(parsed.overrides.budgetUsd ?? config.criteria.budgetUsd)} · per-tx ${formatUsd(config.kiteMaxPerTx)} · slack ${formatUsd(config.slackUsd)}`,
  );
  const record = await runtime.run(parsed.overrides, undefined, printReceiptLine);
  console.log("");
  console.log(record.digest.summary);
  console.log(
    `Spent ${formatUsd(record.digest.budget.spentUsd)} of ${formatUsd(record.digest.budget.capUsd)}.`,
  );
  record.digest.opportunities.slice(0, 5).forEach((item, index) => {
    console.log(`${index + 1}. ${item.scores.overall.toFixed(2)}  ${item.title}`);
    console.log(`   ${item.url}`);
  });
  if (record.digest.dropped.length) {
    console.log(`Dropped ${record.digest.dropped.length} (legitimacy or unscored).`);
  }
  console.log(`Wrote ${path.join(config.dataDir, "last-digest.md")}`);
}

function cmdDigest(): void {
  const config = loadConfig();
  const last = loadLastRun(config.dataDir);
  if (!last) {
    console.error("No digest yet. Run: pnpm scout run");
    process.exitCode = 1;
    return;
  }
  console.log(renderDigestMarkdown(last.digest, last.receipts));
}

async function cmdServe(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { port: { type: "string" }, host: { type: "string" }, "dry-run": { type: "boolean" }, live: { type: "boolean" } },
    strict: true,
  });
  applyModeFlags(process.env, { dryRun: values["dry-run"] === true, live: values.live === true });
  if (values.port) process.env.PORT = values.port;
  if (values.host) process.env.HOST = values.host;
  const config = loadConfig();
  startServer(config);
  console.log(`Bounty Scout dashboard (${config.mode}) at http://${config.host}:${config.port}`);
}

async function cmdSession(argv: string[]): Promise<void> {
  const sub = argv[0] ?? "status";
  const rest = argv.slice(1);
  if (sub === "create") {
    const { values } = parseArgs({
      args: rest,
      options: { "dry-run": { type: "boolean" }, "no-wait": { type: "boolean" } },
      strict: true,
    });
    const config = loadConfig();
    const file = path.join(config.dataDir, "session.json");
    mkdirSync(config.dataDir, { recursive: true });
    if (values["dry-run"] || !config.kpassExists) {
      const payload = {
        sessionId: "sess_dry_run",
        createdAt: new Date().toISOString(),
        dryRun: true,
        note: "Placeholder only. No Passport session was created.",
      };
      writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
      console.log("Dry-run session placeholder written to data/session.json (session id sess_dry_run).");
      console.log("No passkey prompt and no spend. For a real session, install kpass, log in, fund the wallet, then run:");
      console.log("  pnpm scout session create");
      console.log("The live command is: kpass session create --separate --max-amount-per-tx 0.05 --max-total-amount 0.25 --ttl 1h --assets USDC --no-browser --output json");
      return;
    }
    const info = await createKiteSession({
      taskSummary: "Bounty Scout Agent: find and score crypto bounties within a $0.25 session budget",
      maxPerTx: config.kiteMaxPerTx,
      maxTotal: config.kiteMaxTotal,
      ttl: config.kiteTtl,
      assets: config.kiteAssets,
      bin: config.kpassBin,
      cwd: config.kpassCwd,
      wait: values["no-wait"] !== true,
    });
    const payload = {
      sessionId: info.sessionId ?? null,
      requestId: info.requestId ?? null,
      approvalUrl: info.approvalUrl ?? null,
      createdAt: new Date().toISOString(),
    };
    writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
    if (info.approvalUrl) console.log(`Approve this session: ${info.approvalUrl}`);
    if (info.sessionId) console.log(`Session id: ${info.sessionId}`);
    else console.log("Session is not active yet. Re-run: pnpm scout session status");
    console.log(`Wrote ${file}`);
    return;
  }
  if (sub === "status") {
    const config = loadConfig();
    if (!config.kpassExists) {
      console.log("kpass is not on PATH. Status is available only for a local Passport login.");
      console.log(config.kiteSessionId ? `Configured session id: ${config.kiteSessionId}` : "No session id configured.");
      return;
    }
    const listed = await listActiveSessions({ bin: config.kpassBin, cwd: config.kpassCwd });
    console.log(JSON.stringify(listed, null, 2));
    return;
  }
  throw new Error(`Unknown session command "${sub}". Use create or status.`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(HELP);
    return;
  }
  if (command === "run") return cmdRun(argv.slice(1));
  if (command === "digest") return cmdDigest();
  if (command === "serve") return cmdServe(argv.slice(1));
  if (command === "session") return cmdSession(argv.slice(1));
  throw new Error(`Unknown command "${command}".\n${HELP}`);
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err: unknown) => {
    const configKey = process.env.OPENSERV_API_KEY ?? process.env.SERV_API_KEY;
    console.error(errorMessage(err, [configKey, process.env.KITE_AGENT_TOKEN].filter((value): value is string => Boolean(value))));
    process.exitCode = 1;
  });
}
