import fs from "node:fs/promises";
import { config } from "./config.js";
import { ollamaEmbed, ollamaModels } from "./llm.js";
import type { Extraction, Item } from "./types.js";
import { log, truncate } from "./util.js";

const STOP = new Set("the a an and or of to in on for with is are was were be it this that what how why who which about from by as at vs".split(" "));
const tokens = (s: string) => s.toLowerCase().split(/[^a-z0-9$]+/).filter((t) => t.length > 2 && !STOP.has(t));

const cosine = (a: number[], b: number[]) => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na * nb) || 1);
};

/**
 * Hybrid (embedding + keyword) search over relevant collected items, used by the synthesis agent.
 * Falls back to keyword-only search when the embedding model isn't installed.
 */
export class Evidence {
  private vectors = new Map<string, number[]>();
  private docs: Item[] = [];
  private embeddings = true;

  constructor(
    private readonly extractions: Map<string, Extraction>,
    private readonly cacheFile: string,
  ) {}

  private docText = (i: Item) => truncate(`${i.title ? i.title + "\n" : ""}${i.text}`, 1500);

  async init(items: Item[]) {
    try {
      const installed = await ollamaModels();
      this.embeddings = installed.includes(config.embedModel) || installed.includes(`${config.embedModel}:latest`);
      if (!this.embeddings) log("evidence", `${config.embedModel} not installed — keyword search only`);
      const cached = JSON.parse(await fs.readFile(this.cacheFile, "utf8")) as Record<string, number[]>;
      for (const [id, v] of Object.entries(cached)) this.vectors.set(id, v);
    } catch {
      // no cache yet
    }
    await this.add(items);
  }

  /** Index more items (e.g. ones collect_more just fetched). */
  async add(items: Item[]) {
    this.docs.push(...items.filter((i) => !this.docs.some((d) => d.id === i.id)));
    if (!this.embeddings) return;
    const missing = items.filter((i) => !this.vectors.has(i.id));
    if (!missing.length) return;
    try {
      const vecs = await ollamaEmbed(missing.map(this.docText));
      missing.forEach((i, n) => this.vectors.set(i.id, vecs[n]));
      await fs.writeFile(this.cacheFile, JSON.stringify(Object.fromEntries(this.vectors)));
      log("evidence", `embedded ${missing.length} items`);
    } catch (e) {
      this.embeddings = false;
      log("evidence", `embedding failed (${(e as Error).message}) — keyword search only`);
    }
  }

  async search(query: string, opts: { source?: string; limit?: number } = {}): Promise<Item[]> {
    const pool = this.docs.filter((d) => !opts.source || d.source === opts.source);
    if (!pool.length) return [];

    // Keyword score: idf-weighted overlap.
    const q = new Set(tokens(query));
    const df = new Map<string, number>();
    for (const d of pool) for (const t of new Set(tokens(this.docText(d)))) df.set(t, (df.get(t) ?? 0) + 1);
    const kw = new Map(
      pool.map((d) => {
        const dt = new Set(tokens(this.docText(d)));
        let score = 0;
        for (const t of q) if (dt.has(t)) score += Math.log(1 + pool.length / (df.get(t) ?? 1));
        return [d.id, score];
      }),
    );
    const maxKw = Math.max(...kw.values(), 1e-9);

    let sem = new Map<string, number>();
    if (this.embeddings) {
      try {
        // Qwen3 embeddings expect an instruction on the query side only.
        const [qv] = await ollamaEmbed([`Instruct: Given a market research question, retrieve customer posts, reviews and articles that answer it\nQuery: ${query}`]);
        sem = new Map(pool.filter((d) => this.vectors.has(d.id)).map((d) => [d.id, cosine(qv, this.vectors.get(d.id)!)]));
      } catch {
        sem = new Map();
      }
    }
    const score = (d: Item) => (sem.size ? 0.7 * (sem.get(d.id) ?? 0) + 0.3 * ((kw.get(d.id) ?? 0) / maxKw) : (kw.get(d.id) ?? 0) / maxKw);
    return pool
      .map((d) => [d, score(d)] as const)
      .filter(([, s]) => s > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, opts.limit ?? 8)
      .map(([d]) => d);
  }

  /** One line per item for observations: id, source, sentiment, and the most informative quote. */
  line(i: Item): string {
    const e = this.extractions.get(i.id);
    const text = e?.quote || i.title || i.text;
    const tags = [i.source, i.kind !== "post" ? i.kind : "", e?.sentiment && e.sentiment !== "neutral" ? e.sentiment : "", e?.brands.length ? e.brands.slice(0, 3).join("/") : ""].filter(Boolean).join(" · ");
    return `[${i.id}] ${tags}${i.author ? ` · ${i.author}` : ""} · "${truncate(text.replace(/\s+/g, " "), 220)}"`;
  }
}
