import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { sha, sleep } from "./util.js";

export type Row = Record<string, unknown>;

export type OpencliErrorKind = "auth" | "timeout" | "failed";

export class OpencliError extends Error {
  constructor(
    message: string,
    readonly kind: OpencliErrorKind,
    readonly site: string,
  ) {
    super(message);
  }
}

export interface OpencliCall {
  site: string;
  cmd: string;
  args?: string[];
  opts?: Record<string, string | number | boolean | undefined>;
  /** Drives the logged-in Chrome (vs. a plain HTTP adapter). Browser calls run one at a time. */
  browser: boolean;
  /** Skip the response cache (for live checks). */
  cache?: boolean;
}

// opencli exit codes follow sysexits.h
const EXIT_EMPTY = 66;
const EXIT_AUTH = 77;

let browserLane: Promise<unknown> = Promise.resolve();
let lastBrowserCallAt = 0;

/** Serialize browser-driven calls and space them out with jitter. */
function inBrowserLane<T>(fn: () => Promise<T>): Promise<T> {
  const next = browserLane.then(async () => {
    const wait = lastBrowserCallAt + config.browserDelayMs * (0.7 + Math.random() * 0.6) - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      return await fn();
    } finally {
      lastBrowserCallAt = Date.now();
    }
  });
  browserLane = next.catch(() => undefined);
  return next;
}

function toArgv(call: OpencliCall): string[] {
  const argv = [call.site, call.cmd, ...(call.args ?? [])];
  for (const [k, v] of Object.entries(call.opts ?? {})) {
    if (v === undefined || v === "") continue;
    argv.push(`--${k}`, String(v));
  }
  argv.push("-f", "json");
  if (call.browser && config.browserMode === "extension") argv.push("--window", "background");
  return argv;
}

async function readCache(key: string): Promise<Row[] | undefined> {
  const file = path.join(config.cacheDir, `${key}.json`);
  try {
    const stat = await fs.stat(file);
    if (Date.now() - stat.mtimeMs > config.cacheTtlHours * 3_600_000) return undefined;
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

async function writeCache(key: string, rows: Row[]) {
  await fs.mkdir(config.cacheDir, { recursive: true });
  await fs.writeFile(path.join(config.cacheDir, `${key}.json`), JSON.stringify(rows));
}

function parseRows(stdout: string): Row[] {
  const start = stdout.search(/[[{]/);
  if (start < 0) return [];
  const parsed = JSON.parse(stdout.slice(start));
  if (Array.isArray(parsed)) return parsed as Row[];
  if (parsed && typeof parsed === "object") return [parsed as Row];
  return [];
}

/** In cdp mode, point OpenCLI at the dedicated Chrome instead of the extension bridge. */
const childEnv = () => (config.browserMode === "cdp" ? { ...process.env, OPENCLI_CDP_ENDPOINT: config.cdpEndpoint } : process.env);

function exec(site: string, argv: string[]): Promise<Row[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.opencliBin, argv, { stdio: ["ignore", "pipe", "pipe"], env: childEnv() });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGTERM"), config.opencliTimeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new OpencliError(`could not start opencli: ${e.message}`, "failed", site));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const cmd = `opencli ${argv.join(" ")}`;
      if (signal) {
        return reject(
          new OpencliError(
            `${cmd} timed out after ${config.opencliTimeoutMs / 1000}s — is the OpenCLI Chrome extension connected? Run \`pnpm check\`.`,
            "timeout",
            site,
          ),
        );
      }
      if (code === EXIT_EMPTY) return resolve([]);
      if (code === EXIT_AUTH) {
        return reject(new OpencliError(`${site}: not logged in — sign in to ${site} in Chrome, then rerun.`, "auth", site));
      }
      if (code !== 0) {
        return reject(new OpencliError(`${cmd} exited ${code}: ${stderr.trim().slice(-400)}`, "failed", site));
      }
      try {
        resolve(parseRows(stdout));
      } catch (e) {
        reject(new OpencliError(`${cmd} returned unparseable JSON: ${(e as Error).message}`, "failed", site));
      }
    });
  });
}

export async function opencli(call: OpencliCall): Promise<Row[]> {
  const argv = toArgv(call);
  const key = sha(argv.join("\u0000"));
  const cached = call.cache === false ? undefined : await readCache(key);
  if (cached) return cached;
  const rows = call.browser ? await inBrowserLane(() => exec(call.site, argv)) : await exec(call.site, argv);
  if (call.cache !== false) await writeCache(key, rows);
  return rows;
}

/** `opencli doctor` exits 0 even when the extension is missing, so read its report instead. */
export async function browserBridgeStatus(): Promise<{ connected: boolean; report: string }> {
  if (config.browserMode === "cdp") {
    const ok = await fetch(`${config.cdpEndpoint}/json/version`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
    return { connected: ok, report: ok ? `Chrome DevTools reachable at ${config.cdpEndpoint}` : `No Chrome at ${config.cdpEndpoint} — run \`pnpm cli browser login\` once, then reports start headless Chrome automatically.` };
  }
  const { code, out } = await opencliRaw(["doctor"], 45_000);
  return { connected: code === 0 && !/\[(MISSING|FAIL)\]/.test(out), report: out };
}

/** Raw passthrough for diagnostics (no JSON parsing, no cache). */
export function opencliRaw(argv: string[], timeoutMs = 30_000): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(config.opencliBin, argv, { stdio: ["ignore", "pipe", "pipe"], env: childEnv() });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("error", (e) => resolve({ code: -1, out: e.message }));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}
