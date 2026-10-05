#!/usr/bin/env -S npx tsx
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { aggregate, extract, filterRelevant } from "./analyze.js";
import { BROWSER_SOURCES, Collector, collect } from "./collect.js";
import { config } from "./config.js";
import { assertModels, ollamaModels, unloadModel } from "./llm.js";
import { browserBridgeStatus, opencli, opencliRaw } from "./opencli.js";
import { makePlan } from "./plan.js";
import { buildReport, synthesize } from "./report.js";
import { ALL_SOURCES, DEFAULT_SOURCES, type CollectError, type Item, type Plan, type SearchDemand, type Source } from "./types.js";
import { log, slugify, timestamp } from "./util.js";
import { ensureHeadlessChrome, launchChrome, loginUrls } from "./browser.js";
import { checkLogins } from "./logins.js";
import { assertModelFits, availableMemory } from "./memory.js";
import { runSynthAgent } from "./synth-agent.js";

const USAGE = `open-review — local-first market research reports

Usage:
  pnpm report "<brand, product or category>" [options]
  pnpm check
  pnpm cli browser login     open the dedicated Chrome profile to sign in (for --headless)

Options:
  --sources <list>      comma-separated: ${ALL_SOURCES.join(",")}  (default: all except tiktok)
  --competitors <list>  competitors to include (planner adds more)
  --limit <n>           results per query (default 10)
  --deep <n>            top posts/videos to open for comments & transcripts (default 5)
  --synth <provider>    local | claude  (default: SYNTH_PROVIDER or local)
  --no-filter           skip the relevance filter pass
  --resume <runDir>     continue an existing run (reuses plan, collected data, finished extractions)
  --headless            collect through a headless dedicated Chrome instead of the extension (BROWSER_MODE=cdp)
  --no-agent            fixed collection plan and one-shot synthesis instead of the ReAct agents
`;

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}
const writeJson = (file: string, data: unknown) => fs.writeFile(file, JSON.stringify(data, null, 2));

async function run(subjectArg: string | undefined, values: Record<string, string | boolean | undefined>) {
  if (values.headless) config.browserMode = "cdp";
  if (values.synth) config.synthProvider = values.synth === "claude" ? "claude" : "local";
  const sources = new Set<Source>(
    typeof values.sources === "string" ? (values.sources.split(",").map((s) => s.trim()) as Source[]).filter((s) => ALL_SOURCES.includes(s)) : DEFAULT_SOURCES,
  );
  const limit = Number(values.limit ?? 10);
  const deep = Number(values.deep ?? 5);
  const useFilter = !values["no-filter"];
  const useAgents = !values["no-agent"];

  const runDir = typeof values.resume === "string" ? path.resolve(values.resume) : undefined;
  const existingPlan = runDir ? await readJson<Plan>(path.join(runDir, "plan.json")) : undefined;
  const subject = subjectArg ?? existingPlan?.subject;
  if (!subject) throw new Error(`Missing subject.\n\n${USAGE}`);

  await assertModels([config.model, ...(useFilter ? [config.filterModel] : [])]);
  await assertModelFits(config.model);

  const dir = runDir ?? path.join(config.dataDir, slugify(subject), timestamp());
  await fs.mkdir(dir, { recursive: true });
  log("run", `output: ${dir}`);

  // 1. Plan
  let plan = existingPlan;
  if (!plan) {
    const competitors = typeof values.competitors === "string" ? values.competitors.split(",").map((s) => s.trim()).filter(Boolean) : [];
    plan = (await makePlan(subject, { competitors })).plan;
    await writeJson(path.join(dir, "plan.json"), plan);
  }
  plan.qualifier ??= ""; // runs planned before the qualifier existed
  log("plan", `brands: ${plan.brands.join(", ") || "—"} | competitors: ${plan.competitors.join(", ")}`);

  // 2–3. Collect + store raw snapshots
  let items = await readJson<Item[]>(path.join(dir, "items.json"));
  let demand = (await readJson<SearchDemand[]>(path.join(dir, "demand.json"))) ?? [];
  let errors = (await readJson<CollectError[]>(path.join(dir, "errors.json"))) ?? [];
  if (!items) {
    const stopChrome = config.browserMode === "cdp" ? await ensureHeadlessChrome() : async () => {};
    const res = await collect(plan, { sources, limit, deep, agent: useAgents }, dir).finally(stopChrome);
    ({ items, demand, errors } = res);
    await Promise.all([writeJson(path.join(dir, "items.json"), items), writeJson(path.join(dir, "demand.json"), demand), writeJson(path.join(dir, "errors.json"), errors)]);
  }
  log("collect", `${items.length} unique items, ${errors.length} failed tasks`);
  if (!items.length) throw new Error("Nothing was collected. Run `pnpm check` to check the OpenCLI browser bridge and logins.");

  // 4. Analyze
  const savedRelevant = await readJson<string[]>(path.join(dir, "relevant.json"));
  const relevantIds = savedRelevant ? new Set(savedRelevant) : useFilter ? await filterRelevant(plan, items) : new Set(items.map((i) => i.id));
  if (!savedRelevant) await writeJson(path.join(dir, "relevant.json"), [...relevantIds]);
  log("filter", `${relevantIds.size}/${items.length} items look relevant`);
  // Keep only one model resident: the filter model would otherwise sit next to the main model for 5 minutes.
  if (useFilter && !savedRelevant && config.filterModel !== config.model) await unloadModel(config.filterModel);
  // Product listings feed the pricing table directly; extracting them would inflate brand mention counts.
  let extractions = await extract(plan, items.filter((i) => relevantIds.has(i.id) && i.kind !== "product"), dir);
  let analysis = aggregate(plan, items, extractions);
  await writeJson(path.join(dir, "analysis.json"), analysis);

  // 5. Report: section-by-section ReAct synthesis (local), or one-shot (Claude / --no-agent)
  let narrative: string;
  if (useAgents && config.synthAgent && config.synthProvider === "local") {
    const collector = new Collector(plan, dir, limit, items);
    // collect_more may need the browser for gap-filling searches.
    const needsBrowser = config.synthCollectBudget > 0 && BROWSER_SOURCES.some((s) => sources.has(s));
    const stopChrome = needsBrowser && config.browserMode === "cdp" ? await ensureHeadlessChrome() : async () => {};
    if (needsBrowser && !(await browserBridgeStatus()).connected) collector.browserDown = true;
    try {
      ({ narrative, analysis, extractions } = await runSynthAgent({ plan, collector, extractions, analysis, demand, runDir: dir, sources }));
    } finally {
      await stopChrome();
    }
    if (collector.items.length > items.length) {
      log("synth", `collect_more added ${collector.items.length - items.length} items`);
      items = collector.items;
      errors = [...errors, ...collector.errors];
      await Promise.all([writeJson(path.join(dir, "items.json"), items), writeJson(path.join(dir, "errors.json"), errors), writeJson(path.join(dir, "analysis.json"), analysis)]);
    }
  } else {
    narrative = await synthesize(plan, analysis, items, demand);
  }
  await fs.writeFile(path.join(dir, "narrative.md"), narrative);
  const generatedWith = `analysis: ${config.model} · synthesis: ${config.synthProvider === "claude" ? config.claudeModel : config.model}`;
  const { md, html, invalidCitations, uncitedBullets } = buildReport({ plan, analysis, items, demand, errors, narrative, generatedWith });
  await fs.writeFile(path.join(dir, "report.md"), md);
  await fs.writeFile(path.join(dir, "report.html"), html);

  if (uncitedBullets) log("report", `${uncitedBullets} evidence bullets have no citation`);
  if (invalidCitations.length) log("report", `removed ${invalidCitations.length} citations to ids that don't exist: ${invalidCitations.slice(0, 10).join(", ")}`);
  console.log(`\nReport: ${path.join(dir, "report.html")}\nMarkdown: ${path.join(dir, "report.md")}`);
}

async function browserLogin() {
  console.log(`Opening a dedicated Chrome profile (${config.browserProfileDir}).
Sign in to the sites you want covered, then quit that Chrome window (Cmd+Q) to save the session.
Afterwards run reports with --headless (or set BROWSER_MODE=cdp in .env).\n`);
  const chrome = await launchChrome({ headless: false, urls: loginUrls() });
  await chrome.exited;
  console.log("Saved. Run: pnpm check --headless");
}

async function reportLogins(check: (ok: boolean, label: string, detail?: string) => void) {
  const fix = config.browserMode === "cdp" ? "run `pnpm cli browser login`" : "sign in to it in Chrome";
  for (const l of await checkLogins(new Set(DEFAULT_SOURCES))) {
    if (l.loggedIn === undefined) console.log(`? ${l.site} login — could not check (${l.detail})`);
    else check(l.loggedIn, `${l.site} login`, l.loggedIn ? l.detail : `${l.detail} — ${fix}`);
  }
}

async function doctor() {
  const check = (ok: boolean, label: string, detail = "") => console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);

  const version = await opencliRaw(["--version"]);
  check(version.code === 0, "opencli installed", version.out.trim());

  try {
    const rows = await opencli({ site: "google", cmd: "suggest", args: ["coffee"], opts: { lang: "en" }, browser: false });
    check(rows.length > 0, "opencli HTTP adapters (no browser needed)", `${rows.length} suggestions`);
  } catch (e) {
    check(false, "opencli HTTP adapters", (e as Error).message);
  }

  if (config.browserMode === "cdp") {
    const hasProfile = existsSync(config.browserProfileDir);
    check(hasProfile, "dedicated Chrome profile", hasProfile ? config.browserProfileDir : "missing — run `pnpm cli browser login` and sign in");
    const stop = await ensureHeadlessChrome().catch((e) => {
      check(false, "headless Chrome", (e as Error).message);
      return undefined;
    });
    if (stop) {
      try {
        const rows = await opencli({ site: "youtube", cmd: "search", args: ["coffee"], opts: { limit: 1 }, browser: true });
        check(rows.length > 0, "headless Chrome via DevTools", `live test returned ${rows.length} result(s)`);
        await reportLogins(check);
      } catch (e) {
        check(false, "headless Chrome via DevTools", (e as Error).message.split("\n")[0]);
      } finally {
        await stop();
      }
    }
  } else {
    const bridge = await browserBridgeStatus();
    check(bridge.connected, "opencli browser bridge (Chrome extension)", bridge.connected ? "connected" : "not connected — browser sources (reddit, twitter, youtube, amazon, web, tiktok) will be skipped. Or use --headless");
    if (!bridge.connected) console.log(bridge.report.trim().split("\n").map((l) => `    ${l}`).join("\n"));
    else await reportLogins(check);
  }

  try {
    await assertModelFits(config.model);
    check(true, `memory for ${config.model}`, `${(availableMemory() / 1e9).toFixed(1)} GB available`);
  } catch (e) {
    check(false, `memory for ${config.model}`, (e as Error).message.split("\n")[0]);
  }

  try {
    const models = await ollamaModels();
    for (const m of [config.model, config.filterModel]) {
      const ok = models.includes(m) || models.includes(`${m}:latest`);
      check(ok, `ollama model ${m}`, ok ? "" : `run: ollama pull ${m}`);
    }
  } catch (e) {
    check(false, "ollama reachable", `${config.ollamaUrl}: ${(e as Error).message}`);
  }

  try {
    const res = await fetch(`${config.searxngUrl}/search?format=json&q=test`, { signal: AbortSignal.timeout(5000) });
    check(res.ok, "searxng (optional search fallback)", res.ok ? config.searxngUrl : `HTTP ${res.status}`);
  } catch {
    check(false, "searxng (optional search fallback)", "not running — `docker compose up -d searxng` to enable");
  }

  if (config.synthProvider === "claude") check(!!process.env.ANTHROPIC_API_KEY, "ANTHROPIC_API_KEY set for Claude synthesis", "or use `ant auth login`");
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      sources: { type: "string" },
      competitors: { type: "string" },
      limit: { type: "string" },
      deep: { type: "string" },
      synth: { type: "string" },
      "no-filter": { type: "boolean" },
      resume: { type: "string" },
      "no-agent": { type: "boolean" },
      headless: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, ...rest] = positionals;
  if (values.help || !command) return console.log(USAGE);
  if (values.headless) config.browserMode = "cdp";
  if (command === "doctor") return doctor();
  if (command === "browser" && rest[0] === "login") return browserLogin();
  if (command === "run") return run(rest.join(" ").trim() || undefined, values);
  console.log(USAGE);
}

main().catch((e) => {
  console.error(`\nerror: ${(e as Error).message}`);
  process.exit(1);
});
