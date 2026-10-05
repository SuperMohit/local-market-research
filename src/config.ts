import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

try {
  process.loadEnvFile(path.join(ROOT, ".env"));
} catch {
  // no .env — defaults apply
}

const str = (k: string, d: string) => process.env[k]?.trim() || d;
const num = (k: string, d: number) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && v > 0 ? v : d;
};

export type ThinkLevel = "off" | "low" | "medium" | "high";

const MODEL = str("LLM_MODEL", "qwen3.6:35b-a3b");

export const config = {
  /** extension: your everyday Chrome via the OpenCLI extension. cdp: a dedicated Chrome profile over DevTools (headless-capable). */
  browserMode: (str("BROWSER_MODE", "extension") === "cdp" ? "cdp" : "extension") as "extension" | "cdp",
  cdpEndpoint: str("CDP_ENDPOINT", "http://127.0.0.1:9333"),
  browserProfileDir: str("BROWSER_PROFILE_DIR", path.join(ROOT, ".browser-profile")),
  chromePath: str("CHROME_PATH", ""),

  opencliBin: str("OPENCLI_BIN", path.join(ROOT, "node_modules/.bin/opencli")),
  opencliTimeoutMs: num("OPENCLI_TIMEOUT_MS", 90_000),
  browserDelayMs: num("BROWSER_DELAY_MS", 2500),
  cacheTtlHours: num("CACHE_TTL_HOURS", 24),
  cacheDir: path.join(ROOT, ".cache/opencli"),
  dataDir: str("DATA_DIR", path.join(ROOT, "projects")),

  searchOrder: str("SEARCH_ORDER", "google,searxng,duckduckgo").split(",").map((s) => s.trim()),
  searxngUrl: str("SEARXNG_URL", "http://localhost:8888"),

  ollamaUrl: str("OLLAMA_URL", "http://localhost:11434"),
  // ~22 GB resident; needs other heavy apps closed on a 36 GB Mac (the pre-run memory check enforces this).
  model: MODEL,
  // Defaults to the main model so only one large model is ever resident (two at once froze a 36 GB Mac).
  filterModel: str("FILTER_MODEL", MODEL),
  // One context size for every call: changing it makes Ollama reload the model with a bigger KV cache,
  // which pushed a 36 GB Mac into swap. Prompts are sized to fit 16k.
  numCtx: num("LLM_NUM_CTX", 16384),
  /** Embeddings for evidence search during synthesis; falls back to keyword search if not installed. */
  embedModel: str("EMBED_MODEL", "qwen3-embedding:0.6b"),
  /** ReAct agents: collection tool-call budget, and whether synthesis runs section by section with tools. */
  agentMaxSteps: num("AGENT_MAX_STEPS", 30),
  synthAgent: str("SYNTH_AGENT", "on") !== "off",
  /** Extra collection calls the synthesis agent may make to fill evidence gaps. */
  synthCollectBudget: num("SYNTH_COLLECT_BUDGET", 3),
  think: str("LLM_THINK", "off") as ThinkLevel,

  synthProvider: str("SYNTH_PROVIDER", "local") as "local" | "claude",
  claudeModel: str("CLAUDE_MODEL", "claude-opus-5-5"),
};
