import Anthropic from "@anthropic-ai/sdk";
import { config, type ThinkLevel } from "./config.js";
import { extractJson } from "./util.js";

export interface ChatOpts {
  model?: string;
  system?: string;
  think?: ThinkLevel;
  numCtx?: number;
  temperature?: number;
}

/** gpt-oss takes a reasoning level; most other Ollama thinking models take a boolean. */
function thinkParam(model: string, level: ThinkLevel): boolean | string {
  if (model.startsWith("gpt-oss")) return level === "off" ? "low" : level;
  return level !== "off";
}

export async function ollamaChat(prompt: string, opts: ChatOpts = {}): Promise<string> {
  const model = opts.model ?? config.model;
  const messages = [
    ...(opts.system ? [{ role: "system", content: opts.system }] : []),
    { role: "user", content: prompt },
  ];
  const res = await fetch(`${config.ollamaUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      think: thinkParam(model, opts.think ?? config.think),
      // Ollama's default context is small and silently truncates long prompts — always set it.
      options: { num_ctx: opts.numCtx ?? config.numCtx, temperature: opts.temperature ?? 0.2 },
    }),
  });
  if (!res.ok) throw new Error(`ollama ${model}: HTTP ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { message?: { content?: string } };
  return data.message?.content ?? "";
}

export interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[];
  tool_name?: string;
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ToolSchema {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/** One turn of native Ollama tool calling. Thinking is returned separately and not sent back. */
export async function ollamaToolChat(
  messages: OllamaMessage[],
  tools: ToolSchema[],
  opts: ChatOpts = {},
): Promise<{ content: string; thinking: string; toolCalls: ToolCall[] }> {
  const model = opts.model ?? config.model;
  const res = await fetch(`${config.ollamaUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      tools,
      stream: false,
      think: thinkParam(model, opts.think ?? "low"),
      options: { num_ctx: opts.numCtx ?? config.numCtx, temperature: opts.temperature ?? 0.2 },
    }),
  });
  if (!res.ok) throw new Error(`ollama ${model}: HTTP ${res.status} ${await res.text()}`);
  const data = (await res.json()) as {
    message?: { content?: string; thinking?: string; tool_calls?: { function?: { name?: string; arguments?: unknown } }[] };
  };
  const toolCalls = (data.message?.tool_calls ?? [])
    .map((c) => {
      let args = c.function?.arguments ?? {};
      if (typeof args === "string") {
        try {
          args = JSON.parse(args);
        } catch {
          args = {};
        }
      }
      return { name: c.function?.name ?? "", args: args as Record<string, unknown> };
    })
    .filter((c) => c.name);
  return { content: data.message?.content ?? "", thinking: data.message?.thinking ?? "", toolCalls };
}

/** Embed texts with an Ollama embedding model. */
export async function ollamaEmbed(texts: string[], model = config.embedModel): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 32) {
    const res = await fetch(`${config.ollamaUrl}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Ollama defaults embedding models to a 32k context (~5.8 GB for a 0.6B model); inputs are ~400 tokens.
      body: JSON.stringify({ model, input: texts.slice(i, i + 32), truncate: true, options: { num_ctx: 512 } }),
    });
    if (!res.ok) throw new Error(`ollama embed ${model}: HTTP ${res.status} ${await res.text()}`);
    out.push(...((await res.json()) as { embeddings: number[][] }).embeddings);
  }
  return out;
}

/**
 * Ask for JSON and parse it. The JSON shape is described in the prompt rather than
 * enforced with Ollama's `format` schema: constrained decoding garbled gpt-oss output in testing.
 */
export async function llmJson<T>(prompt: string, opts: ChatOpts & { validate: (x: unknown) => T }): Promise<T> {
  let lastErr: unknown;
  let p = prompt;
  for (let attempt = 0; attempt < 3; attempt++) {
    const text = await ollamaChat(p, opts);
    try {
      return opts.validate(extractJson(text));
    } catch (e) {
      lastErr = e;
      p = `${prompt}\n\nYour previous reply was not valid (${(e as Error).message}). Reply with ONLY the JSON.`;
    }
  }
  throw new Error(`model did not return valid JSON after 3 attempts: ${(lastErr as Error)?.message}`);
}

const FALLBACK_MODELS = /^claude-(opus-5|fable-5|sonnet-5-5)/;

export async function claudeText(system: string, prompt: string): Promise<string> {
  const client = new Anthropic();
  const params = {
    model: config.claudeModel,
    max_tokens: 64000,
    thinking: { type: "adaptive" as const },
    output_config: { effort: "high" as const },
    system,
    messages: [{ role: "user" as const, content: prompt }],
    // Re-runs a declined request on a fallback model instead of failing the report.
    ...(FALLBACK_MODELS.test(config.claudeModel)
      ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" }
      : {}),
  };
  const stream = client.beta.messages.stream(params as Parameters<typeof client.beta.messages.stream>[0]);
  const msg = await stream.finalMessage();
  if (msg.stop_reason === "refusal") throw new Error("Claude declined to write the report synthesis");
  return msg.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/** Free a model's memory now instead of after Ollama's 5-minute keep-alive. */
export async function unloadModel(model: string) {
  await fetch(`${config.ollamaUrl}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, keep_alive: 0 }),
  }).catch(() => undefined);
}

export async function ollamaModels(): Promise<string[]> {
  const res = await fetch(`${config.ollamaUrl}/api/tags`);
  if (!res.ok) throw new Error(`ollama: HTTP ${res.status}`);
  const data = (await res.json()) as { models: { name: string }[] };
  return data.models.map((m) => m.name);
}

export async function assertModels(models: string[]) {
  let installed: string[];
  try {
    installed = await ollamaModels();
  } catch (e) {
    throw new Error(`Ollama is not reachable at ${config.ollamaUrl} (${(e as Error).message}). Start the Ollama app.`);
  }
  const has = (m: string) => installed.includes(m) || installed.includes(`${m}:latest`);
  const missing = models.filter((m) => !has(m));
  if (missing.length) {
    throw new Error(`Missing Ollama models: ${missing.join(", ")}. Run: ${missing.map((m) => `ollama pull ${m}`).join(" && ")}`);
  }
}
