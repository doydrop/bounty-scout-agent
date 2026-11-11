import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import { OpenAiServClient, type ChatCreate, type ChatResult } from "../src/serv/client.js";
import { PLANNER_SYSTEM, plannerUserPrompt } from "../src/serv/prompts.js";
import { catalogForPrompt } from "../src/tools/catalog.js";

const schema = z.object({ ok: z.boolean() });

function result(content: string): ChatResult {
  return {
    model: "gpt-5.4-mini-2026-03-17",
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  };
}

describe("SERV client", () => {
  it("sends a system message, the pinned model, and low reasoning effort", async () => {
    const bodies: Record<string, unknown>[] = [];
    const create: ChatCreate = async (body) => {
      bodies.push(body);
      return result('{"ok":true}');
    };
    const client = new OpenAiServClient({ create, model: "gpt-5.4-mini", reasoningEffort: "low" });
    const completion = await client.completeJson({
      schemaName: "scout_plan",
      schema,
      system: "Reply with JSON.",
      user: "ping",
    });
    assert.equal(completion.data.ok, true);
    const body = bodies[0] as {
      model: string;
      reasoning_effort: string;
      messages: Array<{ role: string; content: string }>;
      response_format: { type: string };
    };
    assert.equal(body.model, "gpt-5.4-mini");
    assert.equal(body.reasoning_effort, "low");
    assert.equal(body.messages[0]?.role, "system");
    assert.equal(body.response_format.type, "json_schema");
  });

  it("retries without json_schema when the model rejects it", async () => {
    const bodies: Record<string, unknown>[] = [];
    const create: ChatCreate = async (body) => {
      bodies.push(body);
      if (bodies.length === 1) throw new Error("unsupported response_format json_schema");
      return result("```json\n{\"ok\":true}\n```");
    };
    const client = new OpenAiServClient({ create, model: "gpt-5.4-mini", reasoningEffort: "low" });
    const completion = await client.completeJson({
      schemaName: "scout_plan",
      schema,
      system: "Reply with JSON.",
      user: "ping",
    });
    assert.equal(completion.data.ok, true);
    assert.equal(bodies.length, 2);
    assert.equal("response_format" in (bodies[1] ?? {}), false);
  });

  it("names a 404 model and redacts the API key", async () => {
    const create: ChatCreate = async () => {
      const error = new Error("model missing for key sk-test-openserv-not-a-real-key");
      (error as { status?: number }).status = 404;
      throw error;
    };
    const client = new OpenAiServClient({
      create,
      model: "missing-model",
      reasoningEffort: "low",
      apiKey: "sk-test-openserv-not-a-real-key",
    });
    await assert.rejects(
      () => client.completeJson({ schemaName: "scout_plan", schema, system: "s", user: "u" }),
      (err: unknown) => {
        const message = err instanceof Error ? err.message : "";
        assert.match(message, /missing-model/);
        assert.equal(message.includes("sk-test-openserv-not-a-real-key"), false);
        return true;
      },
    );
  });

  it("refuses to call SERV without a system prompt", async () => {
    const client = new OpenAiServClient({
      create: async () => result("{}"),
      model: "gpt-5.4-mini",
      reasoningEffort: "low",
    });
    await assert.rejects(
      () => client.completeJson({ schemaName: "scout_plan", schema, system: "  ", user: "u" }),
      /system prompt/,
    );
  });
});

describe("planner prompt", () => {
  it("includes the budget, catalog prices, and the untrusted-data rule", () => {
    assert.match(PLANNER_SYSTEM, /untrusted/i);
    const prompt = plannerUserPrompt({
      criteria: {
        chains: ["solana"],
        entryCost: "free_or_gas",
        categories: ["contest", "creative"],
        maxEffortMinutes: 30,
        budgetUsd: 0.25,
      },
      remainingUsd: 0.25,
      slackUsd: 0.01,
      perTxUsd: 0.05,
      maxSearches: 8,
      allowAnswer: false,
      catalog: catalogForPrompt(false),
    });
    assert.match(prompt, /0\.25/);
    assert.match(prompt, /0\.008/);
    assert.match(prompt, /Answer tool allowed: no/);
  });
});
