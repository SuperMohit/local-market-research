export type Source =
  | "reddit"
  | "twitter"
  | "youtube"
  | "amazon"
  | "tiktok"
  | "hackernews"
  | "news"
  | "substack"
  | "web";

export const ALL_SOURCES: Source[] = ["news", "hackernews", "web", "reddit", "twitter", "youtube", "amazon", "substack", "tiktok"];
/** TikTok is opt-in: noisy for most categories and aggressive about bot detection. */
export const DEFAULT_SOURCES: Source[] = ALL_SOURCES.filter((s) => s !== "tiktok");

export interface Item {
  /** Citation id assigned after dedupe, e.g. "S12". */
  id: string;
  /** Stable dedupe key, e.g. "reddit:post:abc123". */
  key: string;
  source: Source;
  kind: "post" | "comment" | "video" | "transcript" | "product" | "review" | "article" | "result";
  url?: string;
  title?: string;
  text: string;
  author?: string;
  createdAt?: string;
  /** Engagement numbers: score, likes, views, comments, reviews, rating, price… */
  metrics: Record<string, number>;
  /** ISO currency for metrics.price, e.g. "USD". */
  currency?: string;
  /** The query that surfaced this item. */
  query: string;
  parentKey?: string;
}

export interface Plan {
  subject: string;
  kind: "brand" | "category" | "product";
  category: string;
  /** 1–2 words that disambiguate brand names in search, e.g. "drink" for "Celsius". */
  qualifier: string;
  brands: string[];
  competitors: string[];
  keywords: string[];
  subreddits: string[];
  redditQueries: string[];
  twitterQueries: string[];
  youtubeQueries: string[];
  amazonQueries: string[];
  webQueries: string[];
}

export interface SearchDemand {
  seed: string;
  suggestions: string[];
}

export interface CollectError {
  task: string;
  site: string;
  kind: string;
  message: string;
}

export interface Extraction {
  id: string;
  relevant: boolean;
  brands: string[];
  sentiment: "positive" | "negative" | "mixed" | "neutral";
  aspects: { brand: string; aspect: string; polarity: "positive" | "negative" }[];
  switch: { from: string; to: string } | null;
  prices: string[];
  objections: string[];
  triggers: string[];
  quote: string;
}
