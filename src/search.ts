import { config } from "./config.js";
import { opencli, type Row } from "./opencli.js";
import { log } from "./util.js";

export interface WebResult {
  title: string;
  url: string;
  snippet: string;
  engine: string;
}

async function searxng(query: string, limit: number): Promise<WebResult[]> {
  const url = `${config.searxngUrl}/search?format=json&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`searxng HTTP ${res.status}`);
  const data = (await res.json()) as { results?: { title: string; url: string; content?: string }[] };
  return (data.results ?? []).slice(0, limit).map((r) => ({ title: r.title, url: r.url, snippet: r.content ?? "", engine: "searxng" }));
}

const fromRows = (rows: Row[], engine: string): WebResult[] =>
  rows
    .filter((r) => typeof r.url === "string" && r.url)
    .map((r) => ({ title: String(r.title ?? ""), url: String(r.url), snippet: String(r.snippet ?? ""), engine }));

const providers: Record<string, (q: string, limit: number) => Promise<WebResult[]>> = {
  google: async (q, limit) => fromRows(await opencli({ site: "google", cmd: "search", args: [q], opts: { limit }, browser: true }), "google"),
  duckduckgo: async (q, limit) =>
    fromRows(await opencli({ site: "duckduckgo", cmd: "search", args: [q], opts: { limit }, browser: true }), "duckduckgo"),
  searxng,
};

/** Try each provider in SEARCH_ORDER until one returns results. */
export async function webSearch(query: string, limit = 10): Promise<WebResult[]> {
  for (const name of config.searchOrder) {
    const provider = providers[name];
    if (!provider) continue;
    try {
      const results = await provider(query, limit);
      if (results.length) return results;
    } catch (e) {
      log("search", `${name} failed for "${query}": ${(e as Error).message.split("\n")[0]}`);
    }
  }
  return [];
}

/** Autocomplete from Google and DuckDuckGo — plain HTTP adapters, no browser or login needed. */
export async function suggest(seed: string): Promise<string[]> {
  const [g, d] = await Promise.allSettled([
    opencli({ site: "google", cmd: "suggest", args: [seed], opts: { lang: "en" }, browser: false }),
    opencli({ site: "duckduckgo", cmd: "suggest", args: [seed], opts: { limit: 10 }, browser: false }),
  ]);
  const out: string[] = [];
  if (g.status === "fulfilled") out.push(...g.value.map((r) => String(r.suggestion ?? "")));
  if (d.status === "fulfilled") out.push(...d.value.map((r) => String(r.phrase ?? "")));
  return [...new Set(out.map((s) => s.trim().toLowerCase()).filter(Boolean))];
}
