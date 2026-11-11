import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { applyEnvFile, loadConfig, resolveMode, PROJECT_ROOT } from "../src/config.js";

describe("mode", () => {
  it("stays in dry-run unless a SERV key and kpass are both available", () => {
    assert.equal(resolveMode({}, false), "dry-run");
    assert.equal(resolveMode({ OPENSERV_API_KEY: "present" }, false), "dry-run");
    assert.equal(resolveMode({}, true), "dry-run");
    assert.equal(resolveMode({ SERV_API_KEY: "present" }, true), "live");
    assert.equal(resolveMode({ OPENSERV_API_KEY: "present", SCOUT_MODE: "dry-run" }, true), "dry-run");
  });

  it("refuses live mode when a dependency is missing", () => {
    assert.throws(() => resolveMode({ SCOUT_MODE: "live" }, false), /kpass/);
    assert.throws(() => resolveMode({ SCOUT_MODE: "live", KITE_PAYER: "http" }, false), /KITE_AGENT_TOKEN/);
    assert.equal(
      resolveMode({ SCOUT_MODE: "live", KITE_PAYER: "http", KITE_AGENT_TOKEN: "tok", OPENSERV_API_KEY: "k" }, false),
      "live",
    );
  });

  it("prefers OPENSERV_API_KEY and does not let a file override the environment", () => {
    const env: NodeJS.ProcessEnv = { OPENSERV_API_KEY: "from-env", SERV_API_KEY: "other" };
    applyEnvFile("OPENSERV_API_KEY=from-file\nSCOUT_BUDGET_USD=0.1\n# comment\n", env);
    assert.equal(env.OPENSERV_API_KEY, "from-env");
    assert.equal(env.SCOUT_BUDGET_USD, "0.1");
    const config = loadConfig(
      { OPENSERV_API_KEY: "preferred", SERV_API_KEY: "fallback", SCOUT_MODE: "dry-run" },
      { kpassExists: false, loadEnvFile: false, root: PROJECT_ROOT },
    );
    assert.equal(config.servApiKey, "preferred");
    assert.equal(config.mode, "dry-run");
    assert.equal(config.criteria.budgetUsd, 0.25);
    assert.equal(config.kiteMaxPerTx, 0.05);
  });

  it("rejects a non-positive budget and a per-tx cap above the budget", () => {
    assert.throws(
      () => loadConfig({ SCOUT_BUDGET_USD: "0", SCOUT_MODE: "dry-run" }, { kpassExists: false, loadEnvFile: false }),
      /greater than 0/,
    );
    assert.throws(
      () =>
        loadConfig(
          { SCOUT_BUDGET_USD: "0.02", KITE_MAX_AMOUNT_PER_TX: "0.05", SCOUT_MODE: "dry-run" },
          { kpassExists: false, loadEnvFile: false },
        ),
      /not above the run budget/,
    );
    const dir = mkdtempSync(path.join(tmpdir(), "scout-cfg-"));
    const config = loadConfig(
      { SCOUT_MODE: "dry-run", SCOUT_DATA_DIR: dir },
      { kpassExists: false, loadEnvFile: false, root: PROJECT_ROOT },
    );
    assert.equal(config.dataDir, dir);
  });
});
