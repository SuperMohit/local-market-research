import { argStr, reactLoop, type LoopResult, type Tool } from "./agent.js";
import { namesAny, qualified, type Collector, type Fetched } from "./collect.js";
import { config } from "./config.js";
import type { Item, SearchDemand, Source } from "./types.js";
import { truncate } from "./util.js";

export interface CollectAgentOptions {
  sources: Set<Source>;
  /** Cap on thread/video/product deep reads per tool. */
  deep: number;
  /** Warnings shown to the agent (e.g. sites not logged in). */
  notes: string[];
  demand: SearchDemand[];
  traceFile: string;
}

const VOICE_KINDS = new Set<Item["kind"]>(["comment", "review", "transcript"]);

function engagementLabel(i: Item): string {
  const m = i.metrics;
  const parts = [
    m.comments !== undefined && `${m.comments} comments`,
    m.score !== undefined && `▲${m.score}`,
    m.likes !== undefined && `${m.likes} likes`,
    m.views !== undefined && `${m.views.toLocaleString()} views`,
    m.reviews !== undefined && `${m.reviews.toLocaleString()} reviews`,
    m.rating !== undefined && `${m.rating}★`,
    m.price !== undefined && `$${m.price}`,
  ].filter(Boolean);
  return parts.join(" · ");
}

const engagement = (i: Item) => (i.metrics.comments ?? 0) * 3 + (i.metrics.score ?? 0) + (i.metrics.likes ?? 0) + (i.metrics.views ?? 0) / 1000 + (i.metrics.reviews ?? 0) / 10;

/**
 * ReAct collection agent: the model decides which source to query next based on what each search
 * returned and on coverage gaps, within a step budget and per-tool caps.
 */
export async function runCollectAgent(c: Collector, o: CollectAgentOptions): Promise<LoopResult> {
  const plan = c.plan;
  const brands = c.brands;
  const used = new Map<string, number>();
  const seen = new Set<string>();
  let finishPushedBack = false;

  const named = (i: Item) => brands.filter((b) => namesAny(`${i.title ?? ""} ${i.text}`, [b]));

  /** Compact observation for a search: what came back, what's new, and the most engaging new items. */
  const searchObs = (label: string, f: Fetched): string => {
    if (f.error && !f.added.length) return `error: ${f.error}`;
    const withBrand = f.added.filter((i) => named(i).length).length;
    const top = [...f.added].sort((a, b) => engagement(b) - engagement(a)).slice(0, 6);
    const lines = top.map((i) => {
      const where = i.source === "reddit" ? (i.url?.match(/\/r\/([^/]+)/)?.[1] ? `r/${i.url.match(/\/r\/([^/]+)/)![1]}` : "reddit") : i.source;
      const names = named(i);
      return `[${i.id}] ${where}${i.author ? ` · ${i.author}` : ""} · ${engagementLabel(i) || "no stats"} · "${truncate((i.title || i.text).replace(/\s+/g, " "), 90)}"${names.length ? ` (names: ${names.join(", ")})` : ""}`;
    });
    return `${label}: ${f.total} results, ${f.added.length} new, ${withBrand} name a tracked brand.${lines.length ? `\nNew, most engaging first:\n${lines.join("\n")}` : ""}`;
  };

  /** Compact observation for a deep read (comments, reviews, transcript). */
  const readObs = (label: string, f: Fetched): string => {
    if (f.error && !f.added.length) return `error: ${f.error}`;
    const samples = f.added.slice(0, 3).map((i) => `  "${truncate(i.text.replace(/\s+/g, " "), 110)}"`);
    return `${label}: ${f.added.length} new items.${samples.length ? `\nSamples:\n${samples.join("\n")}` : ""}`;
  };

  const coverage = (): string => {
    const perBrand = brands.map((b) => `${b} ${c.items.filter((i) => namesAny(`${i.title ?? ""} ${i.text}`, [b])).length}`).join(" · ");
    const perSource = new Map<string, number>();
    for (const i of c.items) perSource.set(i.source, (perSource.get(i.source) ?? 0) + 1);
    const voice = c.items.filter((i) => VOICE_KINDS.has(i.kind)).length;
    return `Coverage: ${c.items.length} items | per brand: ${perBrand} | per source: ${[...perSource].map(([k, v]) => `${k} ${v}`).join(" · ") || "none"} | customer-voice items (comments, reviews, transcripts): ${voice}`;
  };

  /** Enforce per-tool caps and reject repeated queries before calling the source. */
  const guarded = (tool: string, cap: number, key: string, fn: () => Promise<string>): Promise<string> => {
    if ((used.get(tool) ?? 0) >= cap) return Promise.resolve(`error: ${tool} cap (${cap}) reached — use another source or call finish`);
    const k = `${tool}:${key.toLowerCase()}`;
    if (seen.has(k)) return Promise.resolve(`error: already ran ${tool}("${key}") — try different wording`);
    seen.add(k);
    used.set(tool, (used.get(tool) ?? 0) + 1);
    return fn();
  };

  const queryParam = (desc: string) => ({ type: "object", properties: { query: { type: "string", description: desc } }, required: ["query"] });
  const idParam = (desc: string) => ({ type: "object", properties: { id: { type: "string", description: desc } }, required: ["id"] });
  const search = (name: string, source: Source, cap: number, description: string, fn: (q: string) => Promise<Fetched>): Tool => ({
    name,
    description,
    parameters: queryParam("search query, 2–6 words, the way real people phrase it"),
    run: (a) => {
      const q = argStr(a, "query");
      if (!q) return Promise.resolve("error: query is required");
      return guarded(name, cap, q, async () => searchObs(`${name}("${q}")`, await fn(q)));
    },
  });
  const read = (name: string, cap: number, description: string, fn: (id: string) => Promise<Fetched>): Tool => ({
    name,
    description,
    parameters: idParam("citation id from an earlier observation, e.g. S12"),
    run: (a) => {
      const id = argStr(a, "id").replace(/^\[|\]$/g, "");
      if (!id) return Promise.resolve("error: id is required");
      return guarded(name, cap, id, async () => readObs(`${name}(${id})`, await fn(id)));
    },
  });

  const tools: Tool[] = [];
  const has = (s: Source) => o.sources.has(s);
  if (has("reddit")) {
    tools.push(
      {
        ...search("reddit_search", "reddit", 6, "Search Reddit posts from the past year. Best source of candid customer experiences.", (q) => c.redditSearch(q)),
        parameters: {
          type: "object",
          properties: { query: { type: "string", description: "search query, 2–6 words" }, subreddit: { type: "string", description: "optional subreddit name without r/" } },
          required: ["query"],
        },
        run: (a) => {
          const q = argStr(a, "query");
          const sub = argStr(a, "subreddit").replace(/^r\//i, "") || undefined;
          if (!q) return Promise.resolve("error: query is required");
          return guarded("reddit_search", 6, `${q}|${sub ?? ""}`, async () => searchObs(`reddit_search("${q}"${sub ? `, r/${sub}` : ""})`, await c.redditSearch(q, sub)));
        },
      },
      read("reddit_read", o.deep + 2, "Open a Reddit post (by its id, e.g. S12) and collect its top comments. Use on threads that are about a tracked brand and have many comments.", (id) => c.redditRead(id)),
    );
  }
  if (has("twitter")) tools.push(search("twitter_search", "twitter", 4, "Search X/Twitter posts (top results).", (q) => c.twitter(q)));
  if (has("youtube")) {
    tools.push(
      search("youtube_search", "youtube", 4, "Search YouTube videos: reviews, taste tests, comparisons.", (q) => c.youtubeSearch(q)),
      read("youtube_comments", o.deep, "Collect comments on a YouTube video (by id, e.g. S20).", (id) => c.youtubeComments(id)),
      read("youtube_transcript", Math.min(3, o.deep), "Collect a YouTube video's transcript (by id). Use for in-depth reviews.", (id) => c.youtubeTranscript(id)),
    );
  }
  if (has("amazon")) {
    tools.push(
      search("amazon_search", "amazon", 4, "Search Amazon products: prices, ratings, review counts.", (q) => c.amazonSearch(q)),
      read("amazon_reviews", o.deep, "Collect customer reviews for an Amazon product (by id, e.g. S30).", (id) => c.amazonReviews(id)),
    );
  }
  if (has("tiktok")) tools.push(search("tiktok_search", "tiktok", 2, "Search TikTok videos.", (q) => c.tiktok(q)));
  if (has("web")) tools.push(search("web_search", "web", 4, "Web search: market size, industry analyses, pricing pages, comparisons.", (q) => c.web(q)));
  if (has("news")) tools.push(search("news_search", "news", 6, "Google News headlines.", (q) => c.news(q)));
  if (has("hackernews")) tools.push(search("hackernews_search", "hackernews", 2, "Hacker News discussions (tech/startup angle).", (q) => c.hackernews(q)));
  if (has("substack")) tools.push(search("substack_search", "substack", 2, "Substack newsletter posts (industry commentary).", (q) => c.substack(q)));

  const minVoice = 30;
  tools.push({
    name: "finish",
    description: "Stop collecting. Call when every brand has coverage and there is plenty of customer voice, or the budget is nearly used.",
    parameters: { type: "object", properties: { reason: { type: "string", description: "why collection is complete" } }, required: ["reason"] },
    terminal: true,
    run: async () => {
      const voice = c.items.filter((i) => VOICE_KINDS.has(i.kind)).length;
      const calls = [...used.values()].reduce((a, b) => a + b, 0);
      if (!finishPushedBack && voice < minVoice && calls < config.agentMaxSteps / 2) {
        finishPushedBack = true;
        return `error: only ${voice} customer-voice items so far (target ${minVoice}+). Open more threads, comments or reviews before finishing.`;
      }
      return `done: ${c.items.length} items collected.`;
    },
  });

  const rivals = plan.competitors.map((x) => qualified(x, plan));
  const ideas = [
    plan.redditQueries.length && `reddit: ${plan.redditQueries.join(" | ")}`,
    plan.twitterQueries.length && `twitter: ${plan.twitterQueries.join(" | ")}`,
    plan.youtubeQueries.length && `youtube: ${plan.youtubeQueries.join(" | ")}`,
    plan.amazonQueries.length && `amazon: ${plan.amazonQueries.join(" | ")}`,
    plan.webQueries.length && `web: ${plan.webQueries.join(" | ")}`,
    plan.subreddits.length && `subreddits: ${plan.subreddits.join(", ")}`,
  ].filter(Boolean);
  const autocomplete = o.demand.flatMap((d) => d.suggestions.slice(0, 5)).slice(0, 30);

  const system = `You are a market-research data collector. You gather evidence by calling tools; another analyst writes the report later.

Rules:
- Every turn: think briefly about what is missing, then call exactly ONE tool. Never answer in prose.
- Goals, in priority order:
  1. Customer voice: real experiences, taste/quality, price/value, complaints, praise, reasons to buy or quit. Get it by opening busy threads (reddit_read), video comments (youtube_comments) and product reviews (amazon_reviews).
  2. Coverage of every tracked brand, especially direct comparisons with the main brand.
  3. Switching stories ("switched from X to Y") and market context (news, web).
- Read observations carefully: open items that name a tracked brand and have many comments or reviews. Skip off-topic ones (giveaways, memes, unrelated uses of the name).
- If a search returns few new or relevant items, change the wording: use customer language from the autocomplete list, or "X vs Y", "X worth it", "X taste", "switched from X".
- Ambiguous brand names need the qualifier "${plan.qualifier || "(none)"}", e.g. ${rivals.slice(0, 2).map((r) => `"${r}"`).join(", ") || "n/a"}.
- Watch the coverage line after each observation; fill the biggest gap next.
- Call finish when goals are met or the budget is nearly used.`;

  const user = `Research subject: ${plan.subject} (${plan.kind}; category: ${plan.category || "—"}).
Main brand(s): ${plan.brands.join(", ") || "(category study)"}
Competitors: ${plan.competitors.join(", ") || "—"}
Budget: ${config.agentMaxSteps} tool calls.
${o.notes.length ? `\nNotes:\n${o.notes.map((n) => `- ${n}`).join("\n")}\n` : ""}
Planner's starting ideas (use, adapt or ignore):
${ideas.map((i) => `- ${i}`).join("\n") || "- (none)"}

What people type into search (autocomplete): ${autocomplete.join(" | ") || "(none)"}

Begin.`;

  return reactLoop({ label: "agent", system, user, tools, maxSteps: config.agentMaxSteps, traceFile: o.traceFile, footer: coverage });
}
