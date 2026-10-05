import { collectDemand } from "./collect.js";
import { llmJson } from "./llm.js";
import type { Plan, SearchDemand } from "./types.js";
import { log, uniq } from "./util.js";

const strArr = (v: unknown, max: number): string[] =>
  Array.isArray(v) ? uniq(v.map((x) => String(x).trim()).filter(Boolean)).slice(0, max) : [];

function validatePlan(subject: string) {
  return (x: unknown): Plan => {
    const o = x as Record<string, unknown>;
    if (!o || typeof o !== "object") throw new Error("expected an object");
    const kind = ["brand", "category", "product"].includes(String(o.kind)) ? (o.kind as Plan["kind"]) : "brand";
    const plan: Plan = {
      subject,
      kind,
      category: String(o.category ?? "").trim(),
      qualifier: String(o.qualifier ?? "").trim().toLowerCase().split(/\s+/).slice(0, 2).join(" "),
      brands: strArr(o.brands, 4),
      competitors: strArr(o.competitors, 6),
      keywords: strArr(o.keywords, 8),
      subreddits: strArr(o.subreddits, 4).map((s) => s.replace(/^r\//i, "")),
      redditQueries: strArr(o.reddit_queries, 5),
      twitterQueries: strArr(o.twitter_queries, 4),
      youtubeQueries: strArr(o.youtube_queries, 4),
      amazonQueries: strArr(o.amazon_queries, 4),
      webQueries: strArr(o.web_queries, 5),
    };
    if (!plan.brands.length && plan.kind !== "category") throw new Error("brands is empty");
    if (!plan.redditQueries.length) throw new Error("reddit_queries is empty");
    return plan;
  };
}

export async function makePlan(subject: string, hints: { competitors?: string[] } = {}): Promise<{ plan: Plan; preDemand: SearchDemand[] }> {
  // Real autocomplete data grounds competitor discovery in what people actually search for.
  const preDemand = await collectDemand([subject, `${subject} vs`, `${subject} alternative`, `${subject} competitors`].map((x) => x.toLowerCase()));
  log("plan", `autocomplete: ${preDemand.reduce((n, d) => n + d.suggestions.length, 0)} suggestions`);

  const prompt = `You are planning a market research data collection for: "${subject}".

Real search autocomplete for this subject (use it to find competitors and the vocabulary customers use):
${preDemand.map((d) => `- "${d.seed}": ${d.suggestions.slice(0, 10).join(" | ")}`).join("\n") || "(none)"}
${hints.competitors?.length ? `\nThe user specified these competitors — include them: ${hints.competitors.join(", ")}` : ""}

Reply with ONLY JSON in this exact shape:
{
  "kind": "brand" | "category" | "product",
  "category": "short category name, e.g. 'canned water'",
  "qualifier": "1–2 words added to brand names in searches so ambiguous names hit the right thing, e.g. 'drink' (Celsius → 'Celsius drink'), 'app', 'shoes'",
  "brands": ["the subject brand(s) being researched; empty if the subject is a category"],
  "competitors": ["up to 6 direct competitors or leading brands in the category"],
  "keywords": ["up to 8 category/customer-language keywords"],
  "subreddits": ["up to 4 subreddit names without r/ where customers discuss this"],
  "reddit_queries": ["up to 5 Reddit search queries: brand names, 'X vs Y', 'X review', problem phrasing"],
  "twitter_queries": ["up to 4 X/Twitter search queries"],
  "youtube_queries": ["up to 4 YouTube queries: reviews, comparisons, taste tests"],
  "amazon_queries": ["up to 4 Amazon product search queries"],
  "web_queries": ["up to 5 web search queries: market size, comparisons, pricing, industry news"]
}

Rules: prefer short, specific queries real users would type. Include comparison queries ("X vs Y") for the top competitors.`;

  const plan = await llmJson(prompt, { validate: validatePlan(subject), think: "low" });
  if (hints.competitors?.length) plan.competitors = uniq([...hints.competitors, ...plan.competitors]).slice(0, 8);
  return { plan, preDemand };
}
