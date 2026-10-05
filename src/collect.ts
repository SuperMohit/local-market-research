import { readdirSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { runCollectAgent } from "./collect-agent.js";
import { checkLogins } from "./logins.js";
import { OpencliError, browserBridgeStatus, opencli, type OpencliCall, type Row } from "./opencli.js";
import { suggest, webSearch } from "./search.js";
import type { CollectError, Item, Plan, SearchDemand, Source } from "./types.js";
import { log, sha, toNumber, uniq } from "./util.js";

export interface CollectOptions {
  sources: Set<Source>;
  /** Results per query. */
  limit: number;
  /** How many top posts/videos to open for comments and transcripts. */
  deep: number;
  /** Let the ReAct agent decide what to search (falls back to the fixed plan if it fails). */
  agent: boolean;
}

export interface CollectResult {
  items: Item[];
  demand: SearchDemand[];
  errors: CollectError[];
}

/** Sources that drive the logged-in Chrome (everything else is plain HTTP). */
export const BROWSER_SOURCES: Source[] = ["web", "reddit", "twitter", "youtube", "amazon", "tiktok"];

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Stringify, decode HTML entities (Reddit returns them raw) and drop zero-width characters. */
const s = (v: unknown) =>
  v === undefined || v === null
    ? ""
    : String(v)
        .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
          e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ENTITIES[e.toLowerCase()] ?? m),
        )
        .replace(/[​-‍﻿]/g, "")
        .trim();

function metrics(r: Row, fields: Record<string, string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, field] of Object.entries(fields)) {
    const n = toNumber(r[field]);
    if (n !== undefined) out[name] = n;
  }
  return out;
}

function isoDate(v: unknown): string | undefined {
  if (typeof v === "number") return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  const str = s(v);
  if (!str) return undefined;
  const d = new Date(str);
  return Number.isNaN(d.getTime()) ? str : d.toISOString();
}

/** Competitor names get the plan's qualifier ("Celsius" → "Celsius drink") so searches aren't about something else. */
export function qualified(name: string, plan: Pick<Plan, "qualifier">): string {
  const q = plan.qualifier?.trim();
  return q && !name.toLowerCase().includes(q.toLowerCase()) ? `${name} ${q}` : name;
}

export function demandSeeds(plan: Pick<Plan, "subject" | "brands" | "competitors" | "category" | "qualifier">): string[] {
  const own = uniq([plan.subject, ...plan.brands]);
  const rivals = plan.competitors.slice(0, 3).map((c) => qualified(c, plan));
  const names = uniq([...own, ...rivals]).slice(0, 5);
  const seeds = names.flatMap((b) => [b, `${b} vs`, `${b} alternative`, `is ${b}`, `${b} review`]);
  if (plan.category) seeds.push(`best ${plan.category}`, `${plan.category} for`, `${plan.category} vs`);
  return uniq(seeds.map((x) => x.toLowerCase()));
}

export async function collectDemand(seeds: string[]): Promise<SearchDemand[]> {
  const results = await Promise.all(seeds.map(async (seed) => ({ seed, suggestions: await suggest(seed).catch(() => []) })));
  return results.filter((d) => d.suggestions.length);
}

const BOT_AUTHORS = new Set(["AutoModerator", "[deleted]"]);
const isPlaceholder = (t: string) => /^\[\+\d+ more repl(y|ies)\]$/i.test(t) || /^\[(deleted|removed)\]$/i.test(t);

/** Text mentions one of the names (word-boundary, case-insensitive). */
export function namesAny(text: string, names: string[]): boolean {
  const t = text.toLowerCase();
  return names.some((b) => new RegExp(`(^|[^a-z0-9])${b.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`).test(t));
}

function uniqBy<T>(xs: T[], key: (x: T) => string): T[] {
  const seen = new Set<string>();
  return xs.filter((x) => (seen.has(key(x)) ? false : (seen.add(key(x)), true)));
}

/** Transcript output shape varies by video; join whatever text it returns. */
function transcriptText(rows: Row[]): string {
  const parts = rows.map((r) => s(r.text ?? r.content ?? r.value ?? Object.values(r).filter((v) => typeof v === "string").join(" ")));
  return parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

/** Result of one source call: items it added (new, deduplicated) and how many rows it returned. */
export interface Fetched {
  added: Item[];
  total: number;
  error?: string;
}

/**
 * Fetches from each source, normalizes rows into Items, deduplicates, and assigns citation ids.
 * Shared by the fixed collection path, the collection agent and the synthesis agent's collect_more.
 */
export class Collector {
  readonly items: Item[] = [];
  readonly errors: CollectError[] = [];
  private readonly keys = new Set<string>();
  private readonly blocked = new Set<string>();
  browserDown = false;
  private rawCount: number;
  private readonly rawDir: string;

  constructor(
    readonly plan: Plan,
    runDir: string,
    readonly limit: number,
    existing: Item[] = [],
  ) {
    for (const i of existing) {
      this.items.push(i);
      this.keys.add(i.key);
    }
    this.rawDir = path.join(runDir, "raw");
    try {
      this.rawCount = readdirSync(this.rawDir).length;
    } catch {
      this.rawCount = 0;
    }
  }

  get brands(): string[] {
    return uniq([...this.plan.brands, ...this.plan.competitors]);
  }

  byId(id: string): Item | undefined {
    return this.items.find((i) => i.id === id);
  }

  /** Add items, skipping empty and already-seen ones; assigns the next citation ids. */
  private add(xs: Item[]): Item[] {
    const added: Item[] = [];
    for (const x of xs) {
      if (!x.text || this.keys.has(x.key)) continue;
      this.keys.add(x.key);
      x.id = `S${this.items.length + 1}`;
      this.items.push(x);
      added.push(x);
    }
    return added;
  }

  /** Run one opencli call, save its raw output, and record (not throw) failures. */
  private async run(task: string, call: OpencliCall): Promise<{ rows: Row[]; error?: string }> {
    if (this.blocked.has(call.site)) return { rows: [], error: `${call.site} is not logged in` };
    if (call.browser && this.browserDown) return { rows: [], error: "browser unavailable" };
    try {
      const rows = await opencli(call);
      await fs.mkdir(this.rawDir, { recursive: true });
      await fs.writeFile(path.join(this.rawDir, `${String(++this.rawCount).padStart(3, "0")}-${task.replace(/[^a-z0-9]+/gi, "_").slice(0, 60)}.json`), JSON.stringify(rows, null, 2));
      log("collect", `${task}: ${rows.length} rows`);
      return { rows };
    } catch (e) {
      const err = e instanceof OpencliError ? e : new OpencliError((e as Error).message, "failed", call.site);
      this.errors.push({ task, site: err.site, kind: err.kind, message: err.message });
      log("collect", `${task}: ${err.kind} — ${err.message.split("\n")[0]}`);
      if (err.kind === "auth") this.blocked.add(call.site);
      if (err.kind === "timeout" && call.browser) {
        this.browserDown = true;
        log("collect", "browser unresponsive — skipping remaining browser sources");
      }
      return { rows: [], error: `${err.kind}: ${err.message.split("\n")[0]}` };
    }
  }

  private done(res: { rows: Row[]; error?: string }, items: Item[]): Fetched {
    return { added: this.add(items), total: res.rows.length, error: res.error };
  }

  // ---------------------------------------------------------------- sources

  async news(q: string): Promise<Fetched> {
    const res = await this.run(`news ${q}`, { site: "google", cmd: "news", args: [q], opts: { limit: this.limit }, browser: false });
    return this.done(
      res,
      res.rows.filter((r) => s(r.url)).map((r) => ({ id: "", key: `news:${sha(s(r.url))}`, source: "news", kind: "article", url: s(r.url), title: s(r.title), text: s(r.title), author: s(r.source), createdAt: isoDate(r.date), metrics: {}, query: q })),
    );
  }

  async hackernews(q: string): Promise<Fetched> {
    const res = await this.run(`hackernews ${q}`, { site: "hackernews", cmd: "search", args: [q], opts: { limit: this.limit }, browser: false });
    return this.done(
      res,
      res.rows.map((r) => ({ id: "", key: `hn:${s(r.id)}`, source: "hackernews", kind: "post", url: `https://news.ycombinator.com/item?id=${s(r.id)}`, title: s(r.title), text: s(r.title), author: s(r.author), metrics: metrics(r, { score: "score", comments: "comments" }), query: q })),
    );
  }

  async substack(q: string): Promise<Fetched> {
    const res = await this.run(`substack ${q}`, { site: "substack", cmd: "search", args: [q], opts: { limit: this.limit }, browser: false });
    return this.done(
      res,
      res.rows.map((r) => ({ id: "", key: `substack:${sha(s(r.url))}`, source: "substack", kind: "article", url: s(r.url), title: s(r.title), text: [s(r.title), s(r.description)].filter(Boolean).join(" — "), author: s(r.author), createdAt: isoDate(r.date), metrics: {}, query: q })),
    );
  }

  async web(q: string): Promise<Fetched> {
    if (this.browserDown) return { added: [], total: 0, error: "browser unavailable" };
    try {
      const results = await webSearch(q, this.limit);
      log("collect", `web ${q}: ${results.length} results`);
      return {
        added: this.add(results.map((r) => ({ id: "", key: `web:${sha(r.url)}`, source: "web", kind: "result", url: r.url, title: r.title, text: [r.title, r.snippet].filter(Boolean).join(" — "), metrics: {}, query: q }))),
        total: results.length,
      };
    } catch (e) {
      this.errors.push({ task: `web ${q}`, site: "search", kind: "failed", message: (e as Error).message });
      return { added: [], total: 0, error: (e as Error).message };
    }
  }

  async redditSearch(q: string, subreddit?: string): Promise<Fetched> {
    const res = await this.run(`reddit ${subreddit ? `r/${subreddit} ` : ""}${q}`, { site: "reddit", cmd: "search", args: [q], opts: { limit: this.limit, subreddit, sort: "relevance", time: "year" }, browser: true });
    return this.done(
      res,
      res.rows.map((r) => ({ id: "", key: `reddit:post:${s(r.id)}`, source: "reddit", kind: "post", url: s(r.url), title: s(r.title), text: [s(r.title), s(r.selftext)].filter(Boolean).join("\n\n"), author: s(r.author), createdAt: isoDate(r.created_utc), metrics: metrics(r, { score: "score", comments: "comments" }), query: q })),
    );
  }

  /** Open a Reddit thread's comments. Accepts a citation id (S12) of a collected post or a raw Reddit post id. */
  async redditRead(ref: string): Promise<Fetched> {
    const post = this.byId(ref) ?? this.items.find((i) => i.key === `reddit:post:${ref}`);
    if (post && (post.source !== "reddit" || post.kind !== "post")) return { added: [], total: 0, error: `${ref} is not a Reddit post` };
    if (!post && /^S\d+$/.test(ref)) return { added: [], total: 0, error: `${ref} is not a collected item` };
    const postId = post ? post.key.split(":").pop()! : ref;
    const res = await this.run(`reddit read ${postId}`, { site: "reddit", cmd: "read", args: [postId], opts: { limit: 25 }, browser: true });
    // Comment rows are typed by depth (L0, L1, …); the thread's own row is "POST".
    const comments = res.rows.filter((r) => /^L\d+$/.test(s(r.type)) && s(r.text) && !isPlaceholder(s(r.text)) && !BOT_AUTHORS.has(s(r.author)));
    return this.done(
      res,
      comments.map((r) => ({ id: "", key: `reddit:comment:${postId}:${sha(s(r.author) + s(r.text))}`, source: "reddit", kind: "comment", url: post?.url ?? `https://www.reddit.com/comments/${postId}`, text: s(r.text), author: s(r.author), metrics: metrics(r, { score: "score" }), query: post?.query ?? "", parentKey: post?.key ?? `reddit:post:${postId}` })),
    );
  }

  async twitter(q: string): Promise<Fetched> {
    const res = await this.run(`twitter ${q}`, { site: "twitter", cmd: "search", args: [q], opts: { limit: this.limit, filter: "top" }, browser: true });
    return this.done(
      res,
      res.rows.map((r) => ({ id: "", key: `twitter:${s(r.id)}`, source: "twitter", kind: "post", url: s(r.url), text: s(r.text), author: s(r.author), createdAt: isoDate(r.created_at), metrics: metrics(r, { likes: "likes", views: "views" }), query: q })),
    );
  }

  async youtubeSearch(q: string): Promise<Fetched> {
    const res = await this.run(`youtube ${q}`, { site: "youtube", cmd: "search", args: [q], opts: { limit: this.limit }, browser: true });
    return this.done(
      res,
      res.rows.filter((r) => s(r.url)).map((r) => ({ id: "", key: `youtube:${sha(s(r.url))}`, source: "youtube", kind: "video", url: s(r.url), title: s(r.title), text: s(r.title), author: s(r.channel), createdAt: s(r.published) || undefined, metrics: metrics(r, { views: "views" }), query: q })),
    );
  }

  private video(ref: string): Item | undefined {
    const v = this.byId(ref) ?? this.items.find((i) => i.url === ref && i.kind === "video");
    return v?.source === "youtube" && v.kind === "video" ? v : undefined;
  }

  async youtubeComments(ref: string): Promise<Fetched> {
    const video = this.video(ref);
    if (!video) return { added: [], total: 0, error: `${ref} is not a collected YouTube video id` };
    const res = await this.run(`youtube comments ${video.title?.slice(0, 40)}`, { site: "youtube", cmd: "comments", args: [video.url!], opts: { limit: 30 }, browser: true });
    return this.done(
      res,
      res.rows.filter((r) => s(r.text)).map((r) => ({ id: "", key: `youtube:comment:${sha(video.url! + s(r.author) + s(r.text))}`, source: "youtube", kind: "comment", url: video.url, text: s(r.text), author: s(r.author), metrics: metrics(r, { likes: "likes", replies: "replies" }), query: video.query, parentKey: video.key })),
    );
  }

  async youtubeTranscript(ref: string): Promise<Fetched> {
    const video = this.video(ref);
    if (!video) return { added: [], total: 0, error: `${ref} is not a collected YouTube video id` };
    const res = await this.run(`youtube transcript ${video.title?.slice(0, 40)}`, { site: "youtube", cmd: "transcript", args: [video.url!], browser: true });
    const text = transcriptText(res.rows);
    return this.done(res, text ? [{ id: "", key: `youtube:transcript:${sha(video.url!)}`, source: "youtube", kind: "transcript", url: video.url, title: video.title, text, author: video.author, metrics: video.metrics, query: video.query, parentKey: video.key }] : []);
  }

  async amazonSearch(q: string): Promise<Fetched> {
    const res = await this.run(`amazon ${q}`, { site: "amazon", cmd: "search", args: [q], opts: { limit: this.limit }, browser: true });
    return this.done(
      res,
      res.rows
        .filter((r) => s(r.asin) && r.is_sponsored !== true)
        .map((r) => ({ id: "", key: `amazon:${s(r.asin)}`, source: "amazon", kind: "product", url: `https://www.amazon.com/dp/${s(r.asin)}`, title: s(r.title), text: [s(r.title), s(r.price_text)].filter(Boolean).join(" — "), metrics: metrics(r, { rank: "rank", price: "price_value", rating: "rating_value", reviews: "review_count" }), currency: s(r.currency) || undefined, query: q })),
    );
  }

  async amazonReviews(ref: string): Promise<Fetched> {
    const product = this.byId(ref) ?? this.items.find((i) => i.key === `amazon:${ref}`);
    if (!product || product.kind !== "product") return { added: [], total: 0, error: `${ref} is not a collected Amazon product id` };
    const res = await this.run(`amazon reviews ${product.title?.slice(0, 40)}`, { site: "amazon", cmd: "discussion", args: [product.url!], opts: { limit: 10 }, browser: true });
    const page = res.rows[0];
    const samples = Array.isArray(page?.review_samples) ? (page.review_samples as Row[]) : [];
    return this.done(
      res,
      samples.filter((r) => s(r.body)).map((r) => ({ id: "", key: `amazon:review:${sha(product.key + s(r.author) + s(r.body))}`, source: "amazon", kind: "review", url: s(page?.discussion_url) || product.url, title: s(r.title), text: s(r.body), author: s(r.author), createdAt: s(r.date_text) || undefined, metrics: { ...metrics(r, { rating: "rating_value" }), verified: r.verified_purchase === true ? 1 : 0 }, query: product.query, parentKey: product.key })),
    );
  }

  async tiktok(q: string): Promise<Fetched> {
    const res = await this.run(`tiktok ${q}`, { site: "tiktok", cmd: "search", args: [q], opts: { limit: this.limit }, browser: true });
    return this.done(
      res,
      res.rows.filter((r) => s(r.url)).map((r) => ({ id: "", key: `tiktok:${sha(s(r.url))}`, source: "tiktok", kind: "video", url: s(r.url), text: s(r.desc), author: s(r.author), metrics: metrics(r, { plays: "plays", likes: "likes", comments: "comments", shares: "shares" }), query: q })),
    );
  }
}

// ---------------------------------------------------------------- fixed collection (no agent / fallback)

async function collectFixed(c: Collector, plan: Plan, want: (s: Source) => boolean, deep: number) {
  const brands = c.brands;
  const httpWork = (async () => {
    if (want("news")) for (const q of uniq([plan.subject, ...plan.brands, ...plan.competitors.map((x) => qualified(x, plan))]).slice(0, 6)) await c.news(q);
    if (want("hackernews")) for (const q of uniq([plan.subject, ...plan.brands.slice(0, 2)])) await c.hackernews(q);
    if (want("substack")) for (const q of uniq([plan.subject, plan.category]).filter(Boolean).slice(0, 2)) await c.substack(q);
  })();

  const browserWork = (async () => {
    if (want("web")) for (const q of plan.webQueries.slice(0, 4)) if (!c.browserDown) await c.web(q);

    if (want("reddit")) {
      const posts: Item[] = [];
      for (const q of plan.redditQueries.slice(0, 4)) posts.push(...(await c.redditSearch(q)).added);
      for (const sub of plan.subreddits.slice(0, 2)) posts.push(...(await c.redditSearch(plan.subject, sub)).added);
      // Only open threads that are actually about the brands: title mentions first, body-only mentions after.
      const byComments = (a: Item, b: Item) => (b.metrics.comments ?? 0) - (a.metrics.comments ?? 0);
      const titled = posts.filter((p) => namesAny(p.title ?? "", brands)).sort(byComments);
      const bodyOnly = posts.filter((p) => !titled.includes(p) && namesAny(p.text, brands)).sort(byComments);
      for (const post of [...titled, ...bodyOnly].slice(0, deep)) await c.redditRead(post.id);
    }

    if (want("twitter")) for (const q of plan.twitterQueries.slice(0, 3)) await c.twitter(q);

    if (want("youtube")) {
      const videos: Item[] = [];
      for (const q of plan.youtubeQueries.slice(0, 3)) videos.push(...(await c.youtubeSearch(q)).added);
      const top = uniqBy(videos, (v) => v.key).sort((a, b) => (b.metrics.views ?? 0) - (a.metrics.views ?? 0)).slice(0, deep);
      for (const v of top) await c.youtubeComments(v.id);
      for (const v of top.slice(0, Math.min(3, deep))) await c.youtubeTranscript(v.id);
    }

    if (want("amazon")) {
      const products: Item[] = [];
      for (const q of plan.amazonQueries.slice(0, 3)) products.push(...(await c.amazonSearch(q)).added);
      const top = uniqBy(products, (p) => p.key).sort((a, b) => (b.metrics.reviews ?? 0) - (a.metrics.reviews ?? 0)).slice(0, deep);
      for (const p of top) await c.amazonReviews(p.id);
    }

    if (want("tiktok")) for (const q of plan.twitterQueries.slice(0, 2)) await c.tiktok(q);
  })();

  await Promise.all([httpWork, browserWork]);
}

// ---------------------------------------------------------------- entry point

export async function collect(plan: Plan, opts: CollectOptions, runDir: string): Promise<CollectResult> {
  const c = new Collector(plan, runDir, opts.limit);
  const notes: string[] = [];
  let sources = new Set(opts.sources);

  const browserSources = BROWSER_SOURCES.filter((src) => sources.has(src));
  if (browserSources.length && !(await browserBridgeStatus()).connected) {
    c.browserDown = true;
    sources = new Set([...sources].filter((src) => !BROWSER_SOURCES.includes(src)));
    c.errors.push({ task: browserSources.join(", "), site: "browser", kind: "bridge", message: "Browser not connected — browser sources skipped. Run `pnpm check`." });
    log("collect", `browser not connected — skipping ${browserSources.join(", ")}`);
  } else if (browserSources.length) {
    for (const l of await checkLogins(new Set(browserSources))) {
      if (l.loggedIn === false) {
        log("collect", `warning: not logged in to ${l.site} (${l.detail}) — results will be limited or skipped`);
        notes.push(`Not logged in to ${l.site}: results may be limited or fail.`);
      }
    }
  }
  const want = (src: Source) => sources.has(src);

  const demand = await collectDemand(demandSeeds(plan));
  let collected = false;
  if (opts.agent) {
    try {
      const res = await runCollectAgent(c, { sources, deep: opts.deep, notes, demand, traceFile: path.join(runDir, "agent-trace.jsonl") });
      collected = res.okCalls >= 3;
      if (!collected) log("collect", `agent made only ${res.okCalls} successful calls — falling back to the fixed plan`);
    } catch (e) {
      log("collect", `agent failed (${(e as Error).message}) — falling back to the fixed plan`);
    }
  }
  if (!collected) await collectFixed(c, plan, want, opts.deep);

  return { items: c.items, demand, errors: c.errors };
}
