import fs from "node:fs/promises";
import { config, type ThinkLevel } from "./config.js";
import { ollamaToolChat, type OllamaMessage, type ToolSchema } from "./llm.js";
import { log, truncate } from "./util.js";

export interface Tool {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>;
  /** Returns the observation shown to the model. Throwing is reported to the model as an error. */
  run(args: Record<string, unknown>): Promise<string>;
  /** Calling this tool ends the loop (when it returns without "error:"). */
  terminal?: boolean;
}

export interface LoopOptions {
  label: string;
  system: string;
  user: string;
  tools: Tool[];
  maxSteps: number;
  model?: string;
  numCtx?: number;
  think?: ThinkLevel;
  /** JSONL file the full reasoning/action/observation trace is appended to. */
  traceFile?: string;
  /** Appended to every observation, e.g. coverage stats and remaining budget. */
  footer?: () => string;
}

export interface LoopResult {
  steps: number;
  finished: boolean;
  /** Tool calls that ran without an error. */
  okCalls: number;
}

const NUDGE = "Do not answer in prose. Call exactly one tool now (or the finishing tool if you are done).";

/**
 * ReAct loop over native Ollama tool calling: the model reasons (its thinking is logged), calls a tool,
 * sees the observation, and repeats until a terminal tool succeeds or the step budget runs out.
 */
export async function reactLoop(o: LoopOptions): Promise<LoopResult> {
  const schemas: ToolSchema[] = o.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
  const messages: OllamaMessage[] = [
    { role: "system", content: o.system },
    { role: "user", content: o.user },
  ];
  const trace = async (entry: Record<string, unknown>) => {
    if (o.traceFile) await fs.appendFile(o.traceFile, JSON.stringify({ at: new Date().toISOString(), agent: o.label, ...entry }) + "\n");
  };

  let okCalls = 0;
  let nudges = 0;
  for (let step = 1; step <= o.maxSteps; step++) {
    const turn = await ollamaToolChat(messages, schemas, { model: o.model, numCtx: o.numCtx ?? config.numCtx, think: o.think ?? "low" });
    if (!turn.toolCalls.length) {
      await trace({ step, thought: turn.thinking, prose: turn.content });
      if (++nudges > 2) {
        log(o.label, `step ${step}: model stopped calling tools — ending`);
        return { steps: step, finished: false, okCalls };
      }
      messages.push({ role: "assistant", content: turn.content }, { role: "user", content: NUDGE });
      continue;
    }
    nudges = 0;
    messages.push({ role: "assistant", content: turn.content, tool_calls: turn.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.args } })) });

    let finished = false;
    for (const call of turn.toolCalls) {
      const tool = o.tools.find((t) => t.name === call.name);
      let observation: string;
      try {
        observation = tool ? await tool.run(call.args) : `error: unknown tool "${call.name}". Available: ${o.tools.map((t) => t.name).join(", ")}`;
      } catch (e) {
        observation = `error: ${(e as Error).message}`;
      }
      const failed = observation.startsWith("error:");
      if (!failed) okCalls++;
      if (tool?.terminal && !failed) finished = true;
      const shownArgs = truncate(JSON.stringify(call.args), 90);
      log(o.label, `step ${step}: ${call.name}(${shownArgs}) → ${truncate(observation.split("\n")[0], 110)}`);
      if (turn.thinking) log(o.label, `  thought: ${truncate(turn.thinking.replace(/\s+/g, " "), 140)}`);
      await trace({ step, thought: turn.thinking, action: call.name, args: call.args, observation });
      const footer = o.footer && !finished ? `\n\n${o.footer()} | steps left: ${o.maxSteps - step}` : "";
      messages.push({ role: "tool", tool_name: call.name, content: observation + footer });
    }
    if (finished) return { steps: step, finished: true, okCalls };
  }
  log(o.label, `step budget (${o.maxSteps}) used`);
  return { steps: o.maxSteps, finished: false, okCalls };
}

/** Small helpers for tool argument parsing. */
export const argStr = (args: Record<string, unknown>, key: string): string => String(args[key] ?? "").trim();
export const argList = (args: Record<string, unknown>, key: string): string[] => {
  const v = args[key];
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === "string") return v.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
  return [];
};
