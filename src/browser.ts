import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { config } from "./config.js";
import { log, sleep } from "./util.js";

/**
 * Dedicated Chrome for "cdp" browser mode: a separate profile (not your everyday Chrome) that you
 * log into once with a visible window, then reuse headless. OpenCLI talks to it over the DevTools
 * protocol, so the Chrome extension isn't needed.
 */

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

function chromePath(): string {
  const found = [config.chromePath, ...CHROME_CANDIDATES].find((p) => p && fs.existsSync(p));
  if (!found) throw new Error("Chrome not found. Set CHROME_PATH to your Chrome/Chromium binary.");
  return found;
}

/** Headless Chrome advertises "HeadlessChrome"; several sites serve it empty pages. Present as regular Chrome. */
function regularUserAgent(bin: string): string {
  let major = "150";
  try {
    major = execFileSync(bin, ["--version"], { encoding: "utf8" }).match(/(\d+)\./)?.[1] ?? major;
  } catch {
    // keep default
  }
  const platform =
    process.platform === "darwin" ? "Macintosh; Intel Mac OS X 10_15_7" : process.platform === "win32" ? "Windows NT 10.0; Win64; x64" : "X11; Linux x86_64";
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

const port = () => Number(new URL(config.cdpEndpoint).port || 9333);

export async function cdpReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${config.cdpEndpoint}/json/version`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

export interface ChromeHandle {
  stop(): Promise<void>;
  exited: Promise<void>;
}

export async function launchChrome(opts: { headless: boolean; urls?: string[] }): Promise<ChromeHandle> {
  if (await cdpReachable()) throw new Error(`Something is already listening on ${config.cdpEndpoint}. Close that browser first.`);
  const bin = chromePath();
  fs.mkdirSync(config.browserProfileDir, { recursive: true });
  const args = [
    `--remote-debugging-port=${port()}`,
    `--user-data-dir=${config.browserProfileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    ...(opts.headless ? ["--headless=new", "--window-size=1366,900", `--user-agent=${regularUserAgent(bin)}`] : []),
    ...(opts.urls?.length ? opts.urls : ["about:blank"]),
  ];
  const child: ChildProcess = spawn(bin, args, { stdio: "ignore" });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  for (let i = 0; i < 40; i++) {
    if (await cdpReachable()) break;
    await sleep(250);
  }
  if (!(await cdpReachable())) {
    child.kill();
    throw new Error(`Chrome did not open a DevTools endpoint on ${config.cdpEndpoint}`);
  }
  log("browser", `${opts.headless ? "headless" : "visible"} Chrome on ${config.cdpEndpoint} (profile ${config.browserProfileDir})`);
  return {
    exited,
    stop: async () => {
      child.kill("SIGTERM");
      await Promise.race([exited, sleep(5000)]);
    },
  };
}

/** Start headless Chrome for a run unless one is already listening. Returns a stop function (no-op if we didn't start it). */
export async function ensureHeadlessChrome(): Promise<() => Promise<void>> {
  if (await cdpReachable()) return async () => {};
  const chrome = await launchChrome({ headless: true });
  return chrome.stop;
}

export function loginUrls(): string[] {
  return ["https://www.reddit.com/login", "https://x.com/login", "https://accounts.google.com/ServiceLogin?service=youtube", "https://www.amazon.com/"];
}
