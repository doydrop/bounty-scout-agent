import OpenAI from "openai";
import type { ZodType } from "zod";
import type { AppConfig } from "../config.js";
import { errorMessage } from "../secrets.js";
import { JSON_SCHEMAS } from "./schemas.js";

export interface ServUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface ServCompletion<T> {
  data: T;
  raw: unknown;
  usage?: ServUsage;
  model?: string;
}

export interface ServClient {
  completeJson<T>(input: {
    schemaName: string;
    schema: ZodType<T>;
    system: string;
    user: string;
    maxTokens?: number;
  }): Promise<ServCompletion<T>>;
}

interface ChatMessage {
  role: "system" | "user";
  content: string;
}

export interface ChatResult {
  choices?: Array<{ message?: { content?: string | null; refusal?: string | null } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  model?: string;
}

export type ChatCreate = (body: Record<string, unknown>) => Promise<ChatResult>;

function usageOf(result: ChatResult): ServUsage | undefined {
  if (!result.usage) return undefined;
  return {
    promptTokens: result.usage.prompt_tokens,
    completionTokens: result.usage.completion_tokens,
    totalTokens: result.usage.total_tokens,
  };
}

export function parseModelJson(content: string): unknown {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced?.[1] ?? trimmed;
  return JSON.parse(candidate);
}

function statusOf(err: unknown): number | undefined {
  if (err && typeof err === "object" && "status" in err && typeof (err as { status: unknown }).status === "number") {
    return (err as { status: number }).status;
  }
  return undefined;
}

export class OpenAiServClient implements ServClient {
  constructor(
    private readonly opts: {
      create: ChatCreate;
      model: string;
      reasoningEffort: AppConfig["reasoningEffort"];
      apiKey?: string;
    },
  ) {}

  async completeJson<T>(input: {
    schemaName: string;
    schema: ZodType<T>;
    system: string;
    user: string;
    maxTokens?: number;
  }): Promise<ServCompletion<T>> {
    if (!input.system.trim()) {
      throw new Error("SERV requires a system prompt.");
    }
    const schema = JSON_SCHEMAS[input.schemaName];
    let allowSchema = Boolean(schema);
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const messages: ChatMessage[] = [
        { role: "system", content: input.system },
        {
          role: "user",
          content:
            allowSchema || attempt === 0
              ? input.user
              : `${input.user}\n\nReturn only a JSON object matching the ${input.schemaName} schema. No markdown.`,
        },
      ];
      const body: Record<string, unknown> = {
        model: this.opts.model,
        messages,
        reasoning_effort: this.opts.reasoningEffort,
        max_completion_tokens: input.maxTokens ?? 2048,
      };
      if (allowSchema && schema) {
        body.response_format = {
          type: "json_schema",
          json_schema: { name: input.schemaName, strict: true, schema },
        };
      }
      try {
        const result = await this.opts.create(body);
        const message = result.choices?.[0]?.message;
        if (message?.refusal) {
          throw new Error(`SERV refused the request: ${message.refusal}`);
        }
        const content = message?.content ?? "";
        if (!content.trim()) throw new Error("SERV returned an empty completion.");
        const parsed = parseModelJson(content);
        const data = input.schema.parse(parsed);
        return { data, raw: parsed, usage: usageOf(result), model: result.model };
      } catch (err) {
        lastError = err;
        const message = errorMessage(err, this.opts.apiKey ? [this.opts.apiKey] : []);
        const status = statusOf(err);
        if (status === 404) {
          throw new Error(
            `SERV model "${this.opts.model}" was not found (HTTP 404). Set SERV_MODEL to a catalog id such as gpt-5.4-mini.`,
          );
        }
        if (status === 401) {
          throw new Error("SERV rejected the API key (HTTP 401). Check OPENSERV_API_KEY.");
        }
        if (allowSchema && /response_format|json_schema|unsupported|invalid_request/i.test(message)) {
          allowSchema = false;
          continue;
        }
        if (attempt === 0 && err instanceof SyntaxError) continue;
        if (attempt === 0 && err && typeof err === "object" && "issues" in err) continue;
        throw new Error(message);
      }
    }
    throw new Error(errorMessage(lastError, this.opts.apiKey ? [this.opts.apiKey] : []));
  }
}

export function createLiveServClient(config: AppConfig): ServClient {
  if (!config.servApiKey) {
    throw new Error("OPENSERV_API_KEY or SERV_API_KEY is required for live SERV calls.");
  }
  const sdk = new OpenAI({
    baseURL: config.servBaseUrl,
    apiKey: config.servApiKey,
  });
  return new OpenAiServClient({
    model: config.servModel,
    reasoningEffort: config.reasoningEffort,
    apiKey: config.servApiKey,
    create: (body) =>
      sdk.chat.completions.create(body as unknown as Parameters<typeof sdk.chat.completions.create>[0]) as Promise<ChatResult>,
  });
}

export class FixtureServClient implements ServClient {
  constructor(private readonly responses: Record<string, unknown>) {}

  async completeJson<T>(input: {
    schemaName: string;
    schema: ZodType<T>;
    system: string;
    user: string;
  }): Promise<ServCompletion<T>> {
    if (!input.system.trim()) throw new Error("SERV requires a system prompt.");
    const raw = this.responses[input.schemaName];
    if (raw === undefined) {
      throw new Error(`No dry-run SERV fixture for ${input.schemaName}.`);
    }
    return {
      data: input.schema.parse(raw),
      raw,
      model: "fixture",
    };
  }
}
