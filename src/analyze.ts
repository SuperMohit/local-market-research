import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { llmJson } from "./llm.js";
import type { Extraction, Item, Plan } from "./types.js";
import { chunk, log, truncate } from "./util.js";

// ---------------------------------------------------------------- relevance filter

export async function filterRelevant(plan: Plan, items: Item[]): Promise<Set<string>> {
  const keep = new Set(items.filter((i) => i.source === "amazon").map((i) => i.id)); // matched a product query already
  const candidates = items.filter((i) => !keep.has(i.id));
  const topic = [plan.subject, plan.category, ...plan.brands, ...plan.competitors].filter(Boolean).join(", ");
  for (const [n, batch] of chunk(candidates, 25).entries()) {
    const prompt = `Topic: ${topic}

For each item below, decide whether it is actually about this topic (the brands, their products, or the category) — not a different meaning of the same words.

${batch.map((i) => `[${i.id}] ${truncate((i.title ? i.title + " — " : "") + i.text, 300).replace(/\n+/g, " ")}`).join("\n")}

Reply with ONLY JSON: {"relevant": ["S1", "S4", ...]}`;
    try {
      const res = await llmJson(prompt, {
        model: config.filterModel,
        think: "off",
        validate: (x) => {
          const ids = (x as { relevant?: unknown }).relevant;
          if (!Array.isArray(ids)) throw new Error("relevant must be an array");
          return ids.map(String);
        },
      });
      res.forEach((id) => keep.add(id));
    } catch (e) {
      log("filter", `batch ${n + 1} failed (${(e as Error).message}); keeping all items in it`);
      batch.forEach((i) => keep.add(i.id));
    }
    log("filter", `${Math.min((n + 1) * 25, candidates.length)}/${candidates.length}`);
  }
  // Keep comments whose parent thread is relevant even if the comment alone is ambiguous.
  const keptKeys = new Set(items.filter((i) => keep.has(i.id)).map((i) => i.key));
  for (const i of items) if (i.parentKey && keptKeys.has(i.parentKey)) keep.add(i.id);
  return keep;
}

// ---------------------------------------------------------------- extraction

const EXTRACT_RULES = `Extract market-research signals from each item. Be precise about WHICH brand each aspect belongs to.

Attribution rules:
- In comparisons ("X is clunky compared to Y"), the aspect belongs to the brand being described (X), not the reference brand (Y).
- "Switched from A to B" => switch {from: A, to: B}. Only fill switch when someone actually moved (or is moving) between brands.
- Use brand names as written by the customer, but normalize obvious variants (e.g. "LD" => "Liquid Death") when clear from context.
- objections = reasons someone would NOT buy / stopped using. triggers = reasons someone bought / switched / recommends.
- quote = the single most informative verbatim sentence from the item (max 200 chars), copied exactly.
- brands = EVERY brand named in the item, including in headlines and titles.
- relevant = true whenever the item mentions any of the brands or the category — news, announcements, launches, marketing and ads all count. Only use false when the words mean something else entirely (e.g. "liquid" in a chemistry article).
- Items without customer opinions (news, listings) are still relevant: give them sentiment "neutral" and empty aspects unless the text clearly praises or criticizes.

Example item: "Switched from Notion to Obsidian last month. Love that it's local and fast, but sync costs $8/mo which feels steep, and the mobile app is clunky compared to Notion."
Example output: {"id":"S0","relevant":true,"brands":["Notion","Obsidian"],"sentiment":"mixed","aspects":[{"brand":"Obsidian","aspect":"local storage and speed","polarity":"positive"},{"brand":"Obsidian","aspect":"sync pricing","polarity":"negative"},{"brand":"Obsidian","aspect":"mobile app","polarity":"negative"},{"brand":"Notion","aspect":"mobile app","polarity":"positive"}],"switch":{"from":"Notion","to":"Obsidian"},"prices":["Obsidian sync $8/mo"],"objections":["sync costs extra"],"triggers":["local-first and fast"],"quote":"the mobile app is clunky compared to Notion"}`;

const SENTIMENTS = new Set(["positive", "negative", "mixed", "neutral"]);
const strList = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);

function validateExtractions(ids: Set<string>) {
  return (x: unknown): Extraction[] => {
    const results = (x as { results?: unknown }).results;
    if (!Array.isArray(results)) throw new Error('expected {"results": [...]}');
    return results
      .filter((r): r is Record<string, unknown> => !!r && typeof r === "object" && ids.has(String((r as { id?: unknown }).id)))
      .map((r) => {
        const sw = r.switch as { from?: unknown; to?: unknown } | null | undefined;
        return {
          id: String(r.id),
          relevant: r.relevant !== false,
          brands: strList(r.brands),
          sentiment: SENTIMENTS.has(String(r.sentiment)) ? (r.sentiment as Extraction["sentiment"]) : "neutral",
          aspects: (Array.isArray(r.aspects) ? r.aspects : [])
            .map((a: Record<string, unknown>) => ({ brand: String(a?.brand ?? "").trim(), aspect: String(a?.aspect ?? "").trim().toLowerCase(), polarity: a?.polarity === "negative" ? "negative" : "positive" }) as Extraction["aspects"][number])
            .filter((a) => a.aspect),
          switch: sw && sw.from && sw.to ? { from: String(sw.from).trim(), to: String(sw.to).trim() } : null,
          prices: strList(r.prices),
          objections: strList(r.objections).map((o) => o.toLowerCase()),
          triggers: strList(r.triggers).map((t) => t.toLowerCase()),
          quote: String(r.quote ?? "").trim(),
        };
      });
  };
}

function itemForPrompt(i: Item): string {
  const limit = i.kind === "transcript" ? 5000 : 1200;
  const ctx = [i.source, i.kind, i.author && `by ${i.author}`].filter(Boolean).join(", ");
  return `[${i.id}] (${ctx})\n${truncate((i.title && i.kind !== "post" ? i.title + "\n" : "") + i.text, limit)}`;
}

/** Batch by size so long items (transcripts) don't blow the context window. */
function batches(items: Item[]): Item[][] {
  const out: Item[][] = [];
  let cur: Item[] = [];
  let size = 0;
  for (const i of items) {
    const len = itemForPrompt(i).length;
    if (cur.length && (size + len > 7000 || cur.length >= 8)) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(i);
    size += len;
  }
  if (cur.length) out.push(cur);
  return out;
}

export async function extract(plan: Plan, items: Item[], runDir: string): Promise<Map<string, Extraction>> {
  const file = path.join(runDir, "extraction.jsonl");
  const done = new Map<string, Extraction>();
  try {
    for (const line of (await fs.readFile(file, "utf8")).split("\n").filter(Boolean)) {
      const e = JSON.parse(line) as Extraction;
      done.set(e.id, e);
    }
    if (done.size) log("extract", `resuming: ${done.size} items already extracted`);
  } catch {
    // fresh run
  }

  const todo = items.filter((i) => !done.has(i.id));
  const all = batches(todo);
  const started = Date.now();
  for (const [n, batch] of all.entries()) {
    const ids = new Set(batch.map((i) => i.id));
    const prompt = `${EXTRACT_RULES}

Research subject: ${plan.subject} (category: ${plan.category}). Known brands: ${[...plan.brands, ...plan.competitors].join(", ")}.

Items:
${batch.map(itemForPrompt).join("\n\n")}

Reply with ONLY JSON: {"results": [ one object per item, same shape as the example, using each item's id ]}`;
    try {
      const results = await llmJson(prompt, { validate: validateExtractions(ids) });
      for (const r of results) done.set(r.id, r);
      await fs.appendFile(file, results.map((r) => JSON.stringify(r)).join("\n") + (results.length ? "\n" : ""));
    } catch (e) {
      log("extract", `batch ${n + 1} failed: ${(e as Error).message}`);
    }
    const perBatch = (Date.now() - started) / (n + 1);
    log("extract", `batch ${n + 1}/${all.length} — ~${Math.round((perBatch * (all.length - n - 1)) / 60000)} min left`);
  }
  return done;
}

// ---------------------------------------------------------------- aggregation (deterministic, no LLM)

export interface Counted {
  label: string;
  count: number;
  ids: string[];
}

export interface BrandStats {
  brand: string;
  mentions: number;
  bySource: Record<string, number>;
  sentiment: Record<Extraction["sentiment"], number>;
  praise: Counted[];
  complaints: Counted[];
}

export interface Analysis {
  totals: { items: number; relevant: number; bySource: Record<string, number> };
  /** Items counted as relevant (LLM judgment or exact brand-name match). */
  relevantIds: string[];
  brands: BrandStats[];
  otherBrands: Counted[];
  switches: (Counted & { from: string; to: string })[];
  objections: Counted[];
  triggers: Counted[];
  prices: { text: string; id: string }[];
  amazon: { id: string; title: string; price?: number; currency?: string; rating?: number; reviews?: number; url?: string }[];
  creators: { name: string; source: string; items: number; reach: number }[];
  topItems: { id: string; source: string; engagement: number }[];
  quotes: Record<string, string>;
}

function tally(entries: [string, string][], top = 10): Counted[] {
  const m = new Map<string, Counted>();
  for (const [label, id] of entries) {
    const c = m.get(label) ?? { label, count: 0, ids: [] };
    c.count++;
    if (!c.ids.includes(id)) c.ids.push(id);
    m.set(label, c);
  }
  return [...m.values()].sort((a, b) => b.count - a.count).slice(0, top);
}

const engagement = (i: Item) => {
  const m = i.metrics;
  return (m.score ?? 0) + (m.likes ?? 0) + (m.comments ?? 0) * 2 + (m.views ?? 0) / 100 + (m.plays ?? 0) / 100 + (m.reviews ?? 0);
};

export function aggregate(plan: Plan, items: Item[], extractions: Map<string, Extraction>): Analysis {
  const known = [...plan.brands, ...plan.competitors];
  const canon = (name: string): string | undefined => {
    const n = name.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!n) return undefined;
    return known.find((k) => {
      const kk = k.toLowerCase().replace(/[^a-z0-9]/g, "");
      return kk === n || (n.length > 3 && (kk.includes(n) || n.includes(kk)));
    });
  };

  // Exact-name matching backs up the LLM: small models drop brands from headlines and
  // mark plain news as irrelevant, which silently wipes out share of voice.
  const patterns = known.map((k) => [k, new RegExp(`(^|[^a-z0-9])${k.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`)] as const);
  const namedIn = (i: Item) => {
    const text = `${i.title ?? ""} ${i.text}`.toLowerCase();
    return patterns.filter(([, re]) => re.test(text)).map(([k]) => k);
  };

  const byId = new Map(items.map((i) => [i.id, i]));
  const rel = [...extractions.values()]
    .filter((e) => byId.has(e.id))
    .map((e) => {
      const named = namedIn(byId.get(e.id)!);
      return { ...e, relevant: e.relevant || named.length > 0, brands: [...e.brands, ...named] };
    })
    .filter((e) => e.relevant);
  const relevantItems = rel.map((e) => byId.get(e.id)!);

  const brands: BrandStats[] = known.map((brand) => ({ brand, mentions: 0, bySource: {}, sentiment: { positive: 0, negative: 0, mixed: 0, neutral: 0 }, praise: [], complaints: [] }));
  const statsOf = new Map(brands.map((b) => [b.brand, b]));
  const praise = new Map<string, [string, string][]>();
  const complaints = new Map<string, [string, string][]>();
  const others: [string, string][] = [];

  for (const e of rel) {
    const item = byId.get(e.id)!;
    for (const b of new Set(e.brands.map((x) => canon(x) ?? `?${x}`))) {
      if (b.startsWith("?")) {
        others.push([b.slice(1), e.id]);
        continue;
      }
      const st = statsOf.get(b)!;
      st.mentions++;
      st.bySource[item.source] = (st.bySource[item.source] ?? 0) + 1;
      st.sentiment[e.sentiment]++;
    }
    for (const a of e.aspects) {
      const b = canon(a.brand);
      if (!b) continue;
      const bucket = a.polarity === "positive" ? praise : complaints;
      bucket.set(b, [...(bucket.get(b) ?? []), [a.aspect, e.id]]);
    }
  }
  for (const b of brands) {
    b.praise = tally(praise.get(b.brand) ?? [], 8);
    b.complaints = tally(complaints.get(b.brand) ?? [], 8);
  }

  const switchMap = new Map<string, Counted & { from: string; to: string }>();
  for (const e of rel) {
    if (!e.switch) continue;
    const from = canon(e.switch.from) ?? e.switch.from;
    const to = canon(e.switch.to) ?? e.switch.to;
    const k = `${from}→${to}`;
    const c = switchMap.get(k) ?? { label: k, from, to, count: 0, ids: [] };
    c.count++;
    c.ids.push(e.id);
    switchMap.set(k, c);
  }

  const creatorMap = new Map<string, { name: string; source: string; items: number; reach: number }>();
  for (const i of relevantItems) {
    if (!i.author || !["youtube", "twitter", "tiktok"].includes(i.source) || i.kind === "comment") continue;
    const k = `${i.source}:${i.author}`;
    const c = creatorMap.get(k) ?? { name: i.author, source: i.source, items: 0, reach: 0 };
    c.items++;
    c.reach += i.metrics.views ?? i.metrics.plays ?? i.metrics.likes ?? 0;
    creatorMap.set(k, c);
  }

  const bySource: Record<string, number> = {};
  for (const i of items) bySource[i.source] = (bySource[i.source] ?? 0) + 1;

  return {
    totals: { items: items.length, relevant: rel.length, bySource },
    relevantIds: rel.map((e) => e.id),
    brands: brands.sort((a, b) => b.mentions - a.mentions),
    otherBrands: tally(others, 15),
    switches: [...switchMap.values()].sort((a, b) => b.count - a.count),
    objections: tally(rel.flatMap((e) => e.objections.map((o) => [o, e.id] as [string, string])), 15),
    triggers: tally(rel.flatMap((e) => e.triggers.map((t) => [t, e.id] as [string, string])), 15),
    prices: rel.flatMap((e) => e.prices.map((text) => ({ text, id: e.id }))).slice(0, 40),
    amazon: items
      .filter((i) => i.source === "amazon" && i.kind === "product")
      .sort((a, b) => (b.metrics.reviews ?? 0) - (a.metrics.reviews ?? 0))
      .slice(0, 20)
      .map((i) => ({ id: i.id, title: i.title ?? "", price: i.metrics.price, currency: i.currency, rating: i.metrics.rating, reviews: i.metrics.reviews, url: i.url })),
    creators: [...creatorMap.values()].sort((a, b) => b.reach - a.reach).slice(0, 15),
    topItems: relevantItems
      .map((i) => ({ id: i.id, source: i.source, engagement: Math.round(engagement(i)) }))
      .sort((a, b) => b.engagement - a.engagement)
      .slice(0, 25),
    quotes: Object.fromEntries(rel.filter((e) => e.quote).map((e) => [e.id, e.quote])),
  };
}
