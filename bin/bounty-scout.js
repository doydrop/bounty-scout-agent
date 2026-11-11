#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const result = spawnSync(
  process.execPath,
  ["--import", "tsx", path.join(root, "src", "cli.ts"), ...process.argv.slice(2)],
  { stdio: "inherit", cwd: root, env: process.env },
);
process.exit(result.status ?? 1);
