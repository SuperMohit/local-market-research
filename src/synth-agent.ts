import fs from "node:fs/promises";
import path from "node:path";
import { argList, argStr, reactLoop, type Tool } from "./agent.js";
import { aggregate, extract, type Analysis } from "./analyze.js";
import type { Collector, Fetched } from "./collect.js";
import { config } from "./config.js";
import { Evidence } from "./evidence.js";
import { ollamaChat } from "./llm.js";
import { CITATION_RULES, NON_CITATION_LABEL, SECTIONS, analysisBrief, type Section } from "./report.js";
import type { Extraction, Item, Plan, SearchDemand, Source } from "./types.js";
import { log, truncate } from "./util.js";

export interface SynthContext {
  plan: Plan;
  /** The collector holding every item; collect_more adds to it. */
  collector: Collector;
  extractions: Map<string, Extraction>;
  analysis: Analysis;
  demand: SearchDemand[];
  runDir: string;
  sources: Set<Source>;
}

export interface SynthResult {
  narrative: string;
  analysis: Analysis;
  extractions: Map<string, Extraction>;
}

const SYSTEM = `You are a senior market research analyst writing ONE section of a report at a time from collected evidence.
Work like this: search the evidence from a few angles, read the most relevant items, then write the section.
Rules:
- Call exactly one tool per turn. Never answer in prose: the section text goes in write_section.
- Every claim must come from evidence you retrieved. ${CITATION_RULES}
- Exact numbers only from the stats tool or the brief, and say "in this sample".
- Be specific: name brands, quote short phrases, say who says what. If evidence is thin, say so instead of guessing.
- 3–7 bullets, each 1–2 sentences. No heading (it is added automatically).
- You have at most 8 steps per section. Once you have 3–6 relevant items, write; call write_section by step 6 at the latest.`;

const CITE = /\[(S\d+(?:\s*[,;]\s*S\d+)*)\]/g;

/** Returns an error message for the model, or null if the section is acceptable. */
function validate(md: string, section: Section, validIds: Set<string>): string | null {
  if (md.trim().length < 60) return "the section is too short; write 3–7 bullets";
  const labels = [...md.matchAll(NON_CITATION_LABEL)].map((m) => m[0].trim());
  if (labels.length) return `remove non-citation brackets ${[...new Set(labels)].join(", ")}; only [S#] ids may appear in brackets`;
  const ids = [...md.matchAll(CITE)].flatMap((m) => m[1].split(/\s*[,;]\s*/));
  const invalid = [...new Set(ids.filter((id) => !validIds.has(id)))];
  if (invalid.length) return `these ids do not exist: ${invalid.join(", ")}. Cite only ids returned by search_evidence or get_items`;
  if (!section.citationsOptional && !ids.length) return "no citations; back the claims with [S#] ids from the evidence";
  return null;
}

const stripHeading = (md: string) => md.replace(/^\s*#{1,6}\s+[^\n]*\n+/, "").trim();

/** Section-by-section ReAct synthesis with evidence retrieval and a small budget for filling gaps. */
export async function runSynthAgent(ctx: SynthContext): Promise<SynthResult> {
  const { plan, collector } = ctx;
  let extractions = ctx.extractions;
  let analysis = ctx.analysis;
  const traceFile = path.join(ctx.runDir, "synth-trace.jsonl");
  const byId = () => new Map(collector.items.map((i) => [i.id, i]));
  const relevantItems = () => {
    const m = byId();
    return analysis.relevantIds.map((id) => m.get(id)).filter((i): i is Item => !!i && i.kind !== "product");
  };

  const evidence = new Evidence(extractions, path.join(ctx.runDir, "embeddings.json"));
  await evidence.init(relevantItems());
  let collectBudget = config.synthCollectBudget;

  const collectFns: Partial<Record<Source, (q: string) => Promise<Fetched>>> = {
    reddit: (q) => collector.redditSearch(q),
    twitter: (q) => collector.twitter(q),
    youtube: (q) => collector.youtubeSearch(q),
    amazon: (q) => collector.amazonSearch(q),
    web: (q) => collector.web(q),
    news: (q) => collector.news(q),
    hackernews: (q) => collector.hackernews(q),
    substack: (q) => collector.substack(q),
    tiktok: (q) => collector.tiktok(q),
  };
  const collectSources = (Object.keys(collectFns) as Source[]).filter((s) => ctx.sources.has(s));

  // Accepted sections are saved as they're written so an interrupted run resumes where it stopped.
  const sectionsFile = path.join(ctx.runDir, "sections.json");
  const written = new Map<string, string>(Object.entries(await fs.readFile(sectionsFile, "utf8").then(JSON.parse, () => ({}))));
  if (written.size) log("synth", `resuming: ${written.size} sections already written`);
  const save = () => fs.writeFile(sectionsFile, JSON.stringify(Object.fromEntries(written), null, 2));
  const order = [...SECTIONS.filter((s) => s.title !== "Executive summary"), SECTIONS.find((s) => s.title === "Executive summary")!];

  for (const section of order) {
    if (written.has(section.title)) continue;
    const isSummary = section.title === "Executive summary";
    const tools: Tool[] = [
      {
        name: "search_evidence",
        description: "Search collected posts, comments, reviews and articles by meaning. Returns ids with the key quote.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "what you are looking for, e.g. 'complaints about price' or 'LaCroix taste compared'" },
            source: { type: "string", description: "optional: limit to one source (reddit, twitter, youtube, amazon, news, web…)" },
          },
          required: ["query"],
        },
        run: async (a) => {
          const q = argStr(a, "query");
          if (!q) return "error: query is required";
          const hits = await evidence.search(q, { source: argStr(a, "source") || undefined, limit: 8 });
          return hits.length ? `${hits.length} matches:\n${hits.map((h) => evidence.line(h)).join("\n")}` : "no matches; try other words";
        },
      },
      {
        name: "get_items",
        description: "Read the full text of up to 5 items by id before citing them.",
        parameters: { type: "object", properties: { ids: { type: "array", items: { type: "string" }, description: "ids like S12" } }, required: ["ids"] },
        run: async (a) => {
          const m = byId();
          const ids = argList(a, "ids").map((x) => x.replace(/^\[|\]$/g, "")).slice(0, 5);
          const found = ids.map((id) => m.get(id)).filter((i): i is Item => !!i);
          if (!found.length) return `error: none of ${ids.join(", ")} exist`;
          return found.map((i) => `[${i.id}] ${i.source} ${i.kind}${i.author ? ` · ${i.author}` : ""}${i.url ? ` · ${i.url}` : ""}\n${truncate(`${i.title ? i.title + "\n" : ""}${i.text}`, 900)}`).join("\n\n");
        },
      },
      {
        name: "stats",
        description: "Exact counts computed from the data: per brand (mentions, sentiment, praised/complained aspects with ids) or, without a brand, switching/objections/triggers/prices.",
        parameters: { type: "object", properties: { brand: { type: "string", description: "optional brand name" } } },
        run: async (a) => {
          const name = argStr(a, "brand").toLowerCase();
          const b = name ? analysis.brands.find((x) => x.brand.toLowerCase() === name) : undefined;
          if (name && !b) return `error: unknown brand; tracked: ${analysis.brands.map((x) => x.brand).join(", ")}`;
          const counted = (xs: { label: string; count: number; ids: string[] }[]) => xs.slice(0, 8).map((c) => `${c.label} ×${c.count} [${c.ids.slice(0, 3).join(", ")}]`).join("; ") || "none";
          if (b) {
            return `${b.brand}: ${b.mentions} mentions (${Object.entries(b.bySource).map(([s, n]) => `${s} ${n}`).join(", ")}); sentiment +${b.sentiment.positive}/−${b.sentiment.negative}/mixed ${b.sentiment.mixed}/neutral ${b.sentiment.neutral}
praised: ${counted(b.praise)}
complaints: ${counted(b.complaints)}`;
          }
          return `switching: ${analysis.switches.slice(0, 8).map((s) => `${s.from}→${s.to} ×${s.count} [${s.ids.slice(0, 3).join(", ")}]`).join("; ") || "none"}
objections: ${counted(analysis.objections)}
triggers: ${counted(analysis.triggers)}
prices: ${analysis.prices.slice(0, 10).map((p) => `${p.text} [${p.id}]`).join("; ") || "none"}`;
        },
      },
      ...(collectBudget > 0 && collectSources.length
        ? [
            {
              name: "collect_more",
              description: `Fetch NEW evidence when what was collected cannot support this section (budget: ${collectBudget} calls for the whole report).`,
              parameters: {
                type: "object",
                properties: { source: { type: "string", enum: collectSources }, query: { type: "string", description: "search query, 2–6 words" } },
                required: ["source", "query"],
              },
              run: async (a: Record<string, unknown>) => {
                if (collectBudget <= 0) return "error: collect_more budget used up";
                const src = argStr(a, "source") as Source;
                const fn = collectFns[src];
                const q = argStr(a, "query");
                if (!fn || !ctx.sources.has(src)) return `error: source must be one of ${collectSources.join(", ")}`;
                if (!q) return "error: query is required";
                collectBudget--;
                const f = await fn(q);
                if (f.error && !f.added.length) return `error: ${f.error}`;
                const fresh = f.added.filter((i) => i.kind !== "product");
                if (fresh.length) {
                  extractions = await extract(plan, fresh, ctx.runDir);
                  analysis = aggregate(plan, collector.items, extractions);
                  const rel = new Set(analysis.relevantIds);
                  await evidence.add(fresh.filter((i) => rel.has(i.id)));
                }
                const rel = new Set(analysis.relevantIds);
                const useful = f.added.filter((i) => rel.has(i.id));
                return `${f.added.length} new items, ${useful.length} relevant (budget left: ${collectBudget}).${useful.length ? `\n${useful.slice(0, 8).map((i) => evidence.line(i)).join("\n")}` : ""}`;
              },
            } satisfies Tool,
          ]
        : []),
      {
        name: "write_section",
        description: `Submit the markdown body of "${section.title}" (bullets, no heading). Rejected with a reason if citations are invalid.`,
        parameters: { type: "object", properties: { markdown: { type: "string", description: "section body" } }, required: ["markdown"] },
        terminal: true,
        run: async (a) => {
          const md = stripHeading(argStr(a, "markdown"));
          const problem = validate(md, section, new Set(collector.items.map((i) => i.id)));
          if (problem) return `error: ${problem}. Fix it and call write_section again.`;
          written.set(section.title, md);
          await save();
          return `accepted "${section.title}".`;
        },
      },
    ];

    const prior = order
      .filter((s) => written.has(s.title))
      .map((s) => (isSummary ? `## ${s.title}\n${truncate(written.get(s.title)!, 1500)}` : `- ${s.title}: ${truncate(written.get(s.title)!.split("\n")[0], 160)}`));
    const user = `${analysisBrief(plan, analysis, ctx.demand)}

${prior.length ? `${isSummary ? "Sections already written (summarize the most decision-relevant findings across them, keeping their citations):" : "Sections already written (don't repeat them):"}\n${prior.join("\n")}\n` : ""}
Now write the section "## ${section.title}" (${section.guide}).
Steps: search_evidence 2–4 times from different angles, get_items on the most promising ids, then write_section.`;

    log("synth", `section: ${section.title}`);
    await reactLoop({
      label: `synth`,
      system: SYSTEM,
      user,
      tools,
      maxSteps: 8,
      traceFile,
      footer: () => `"${section.title}" is not written yet — call write_section once you have enough evidence`,
    });

    if (!written.has(section.title)) {
      log("synth", `"${section.title}" not written by the agent — falling back to a single grounded call`);
      const hits = await evidence.search(`${section.title} ${section.guide} ${plan.subject}`, { limit: 12 });
      const draft = stripHeading(
        await ollamaChat(
          `${analysisBrief(plan, analysis, ctx.demand)}\n\nEvidence:\n${hits.map((h) => evidence.line(h)).join("\n")}\n\nWrite the body of the section "## ${section.title}" (${section.guide}) as 3–7 bullets. ${CITATION_RULES}`,
          { think: "low" },
        ),
      ).replace(NON_CITATION_LABEL, "");
      written.set(section.title, draft || "_Not enough evidence to write this section._");
      await save();
    }
  }

  const narrative = SECTIONS.map((s) => `## ${s.title}\n\n${written.get(s.title) ?? "_Not enough evidence to write this section._"}`).join("\n\n");
  return { narrative, analysis, extractions };
}
