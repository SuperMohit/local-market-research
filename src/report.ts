import { marked } from "marked";
import type { Analysis, Counted } from "./analyze.js";
import { config } from "./config.js";
import { claudeText, ollamaChat } from "./llm.js";
import type { CollectError, Item, Plan, SearchDemand } from "./types.js";
import { log, truncate } from "./util.js";

const ids = (c: Counted, n = 4) => c.ids.slice(0, n).join(", ");
const countedLines = (xs: Counted[]) => xs.map((c) => `  - ${c.label} ×${c.count} [${ids(c)}]`).join("\n");

/** Compact numbers-only overview of the analysis, given to the synthesis agent at the start of every section. */
export function analysisBrief(plan: Plan, a: Analysis, demand: SearchDemand[]): string {
  const brand = (b: Analysis["brands"][number]) =>
    `- ${b.brand}: ${b.mentions} mentions (${Object.entries(b.bySource).map(([s, n]) => `${s} ${n}`).join(", ") || "none"}); +${b.sentiment.positive}/−${b.sentiment.negative}/mixed ${b.sentiment.mixed}; praised: ${b.praise.slice(0, 4).map((c) => `${c.label} ×${c.count}`).join(", ") || "—"}; complaints: ${b.complaints.slice(0, 4).map((c) => `${c.label} ×${c.count}`).join(", ") || "—"}`;
  return `SUBJECT: ${plan.subject} — ${plan.kind}, category "${plan.category}". Brands: ${plan.brands.join(", ") || "(category study)"}; competitors: ${plan.competitors.join(", ")}
DATA: ${a.totals.items} items, ${a.totals.relevant} relevant. By source: ${Object.entries(a.totals.bySource).map(([s, n]) => `${s} ${n}`).join(", ")}
BRANDS:
${a.brands.map(brand).join("\n")}
SWITCHING: ${a.switches.slice(0, 6).map((s) => `${s.from}→${s.to} ×${s.count}`).join(", ") || "none detected"}
OBJECTIONS: ${a.objections.slice(0, 6).map((c) => `${c.label} ×${c.count}`).join(", ") || "none"}
TRIGGERS: ${a.triggers.slice(0, 6).map((c) => `${c.label} ×${c.count}`).join(", ") || "none"}
PRICES MENTIONED: ${a.prices.slice(0, 8).map((p) => p.text).join("; ") || "none"}
AMAZON: ${a.amazon.slice(0, 5).map((p) => `${truncate(p.title, 50)} ${p.price ?? "?"}${p.currency ? ` ${p.currency}` : ""}, ${p.rating ?? "?"}★, ${p.reviews ?? "?"} reviews`).join(" | ") || "none"}
AUTOCOMPLETE: ${demand.slice(0, 8).map((d) => `"${d.seed}": ${d.suggestions.slice(0, 5).join(" | ")}`).join("; ") || "none"}`;
}

/** Bracketed labels that aren't citations, e.g. [Data] or [Search autocomplete]. Links ([text](url)) are excluded. */
export const NON_CITATION_LABEL = /\s?\[(?!S\d+(?:\s*[,;]\s*S\d+)*\])([^\]\[\n]{1,40})\](?!\()/g;

function synthesisContext(plan: Plan, a: Analysis, items: Item[], demand: SearchDemand[]): string {
  const byId = new Map(items.map((i) => [i.id, i]));
  const cited = new Set<string>();
  const cite = (c: Counted[]) => c.forEach((x) => x.ids.slice(0, 4).forEach((id) => cited.add(id)));

  const brandBlocks = a.brands.map((b) => {
    cite(b.praise);
    cite(b.complaints);
    return `### ${b.brand}: ${b.mentions} relevant mentions (${Object.entries(b.bySource).map(([s, n]) => `${s} ${n}`).join(", ") || "none"}); sentiment +${b.sentiment.positive} / −${b.sentiment.negative} / mixed ${b.sentiment.mixed} / neutral ${b.sentiment.neutral}
- praised:\n${countedLines(b.praise) || "  - (none)"}
- complaints:\n${countedLines(b.complaints) || "  - (none)"}`;
  });
  cite(a.switches);
  cite(a.objections);
  cite(a.triggers);
  a.prices.forEach((p) => cited.add(p.id));
  a.topItems.slice(0, 10).forEach((t) => cited.add(t.id));

  const news = items.filter((i) => i.source === "news").slice(0, 12);
  news.forEach((n) => cited.add(n.id));

  const quoteLines = [...cited]
    .map((id) => {
      const item = byId.get(id);
      const q = a.quotes[id] ?? truncate(item?.text ?? "", 200);
      return item ? `[${id}] (${item.source}${item.author ? `, ${item.author}` : ""}) "${q.replace(/\s+/g, " ")}"` : "";
    })
    .filter(Boolean)
    .slice(0, 80);

  return `SUBJECT: ${plan.subject} — ${plan.kind}, category "${plan.category}"
BRANDS: ${plan.brands.join(", ") || "(category study)"}; COMPETITORS: ${plan.competitors.join(", ")}
DATA: ${a.totals.items} items collected, ${a.totals.relevant} relevant after filtering. By source: ${Object.entries(a.totals.bySource).map(([s, n]) => `${s} ${n}`).join(", ")}

## Per-brand signals
${brandBlocks.join("\n\n")}

## Other brands customers mentioned
${a.otherBrands.map((o) => `- ${o.label} ×${o.count}`).join("\n") || "(none)"}

## Switching (from → to)
${a.switches.map((s) => `- ${s.from} → ${s.to} ×${s.count} [${ids(s)}]`).join("\n") || "(none detected)"}

## Objections (reasons not to buy / churn)
${countedLines(a.objections) || "(none)"}

## Purchase triggers
${countedLines(a.triggers) || "(none)"}

## Price mentions
${a.prices.map((p) => `- ${p.text} [${p.id}]`).join("\n") || "(none)"}

## Amazon listings (top by review count)
${a.amazon.slice(0, 10).map((p) => `- [${p.id}] ${truncate(p.title, 90)} — price ${p.price ?? "?"}${p.currency ? ` ${p.currency}` : ""}, rating ${p.rating ?? "?"}, ${p.reviews ?? "?"} reviews`).join("\n") || "(none)"}

## Search autocomplete (what people type)
${demand.slice(0, 15).map((d) => `- "${d.seed}": ${d.suggestions.slice(0, 8).join(" | ")}`).join("\n")}

## Recent news
${news.map((n) => `- [${n.id}] ${n.title} (${n.author ?? ""})`).join("\n") || "(none)"}

## Evidence quotes (cite these ids)
${quoteLines.join("\n")}`;
}

export const CITATION_RULES = `Citations: after each claim, cite evidence ids exactly like [S12] or [S3, S9] — only ids that appear in the data.
Never put anything else in square brackets: no [Data], [Search autocomplete], [Stats] or similar labels. For counts or autocomplete,
say so in prose ("in this sample", "search autocomplete shows") without brackets. Never invent statistics.`;

export const SYSTEM = `You are a senior market research analyst writing a report from collected social, search, and commerce data.
Ground every claim in the provided data. ${CITATION_RULES}
Be specific and decision-oriented. Point out where evidence is thin.`;

export interface Section {
  title: string;
  guide: string;
  /** Sections that synthesize rather than report evidence may go without citations. */
  citationsOptional?: boolean;
}

export const SECTIONS: Section[] = [
  { title: "Executive summary", guide: "5–7 bullets, the most decision-relevant findings" },
  { title: "Competitive landscape", guide: "who owns the conversation, how each brand is positioned and perceived" },
  { title: "What customers love", guide: "specific praised aspects, with who says it" },
  { title: "What customers complain about", guide: "specific complaints, with who says it" },
  { title: "Switching & churn signals", guide: "who moves between brands and why; reasons people quit" },
  { title: "Pricing & value perception", guide: "price points mentioned, value-for-money opinions" },
  { title: "Customer language & search demand", guide: "what the autocomplete and the wording people use reveal" },
  { title: "Opportunities & whitespace", guide: "unmet needs, under-served segments, weak spots of competitors" },
  { title: "Recommended actions", guide: "concrete, prioritized", citationsOptional: true },
  { title: "Caveats", guide: "sample size, source bias, gaps", citationsOptional: true },
];

const SECTIONS_PROMPT = `Write the report body in Markdown with exactly these sections:
${SECTIONS.map((s) => `## ${s.title}  (${s.guide})`).join("\n")}
Do not add a title; do not add a sources list (it is appended automatically).`;

export async function synthesize(plan: Plan, a: Analysis, items: Item[], demand: SearchDemand[]): Promise<string> {
  const context = synthesisContext(plan, a, items, demand);
  const prompt = `${context}\n\n---\n${SECTIONS_PROMPT}`;
  if (config.synthProvider === "claude") {
    log("report", `synthesizing with ${config.claudeModel}`);
    return claudeText(SYSTEM, prompt);
  }
  log("report", `synthesizing with ${config.model} (local)`);
  return ollamaChat(prompt, { system: SYSTEM, think: config.think === "off" ? "medium" : config.think, temperature: 0.3 });
}

/** Turn [S12] / [S3, S9] into links to the sources appendix; drop ids that don't exist. */
function linkCitations(md: string, valid: Set<string>): { md: string; invalid: string[] } {
  const invalid: string[] = [];
  const out = md.replace(/\[((?:S\d+)(?:\s*[,;]\s*S\d+)*)\]/g, (_, group: string) => {
    const parts = group.split(/\s*[,;]\s*/).filter((id) => {
      if (valid.has(id)) return true;
      invalid.push(id);
      return false;
    });
    return parts.length ? parts.map((id) => `[${id}](#${id.toLowerCase()})`).join(" ") : "";
  });
  return { md: out, invalid };
}

const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "–");
const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n+/g, " ");

function tables(a: Analysis, demand: SearchDemand[], errors: CollectError[]): string {
  const totalMentions = a.brands.reduce((n, b) => n + b.mentions, 0);
  const out: string[] = ["## Data appendix", ""];

  out.push("### Share of voice & sentiment", "", "| Brand | Mentions | Share | Positive | Negative | Mixed | Net sentiment |", "|---|---:|---:|---:|---:|---:|---:|");
  for (const b of a.brands) {
    const s = b.sentiment;
    const scored = s.positive + s.negative + s.mixed;
    out.push(`| ${b.brand} | ${b.mentions} | ${pct(b.mentions, totalMentions)} | ${s.positive} | ${s.negative} | ${s.mixed} | ${scored ? Math.round(((s.positive - s.negative) / scored) * 100) : "–"} |`);
  }

  out.push("", "### Top praise and complaints by brand", "");
  for (const b of a.brands.filter((b) => b.praise.length || b.complaints.length)) {
    out.push(`**${b.brand}**`, "");
    out.push(`- Praised: ${b.praise.slice(0, 5).map((c) => `${c.label} (${c.count}) [${ids(c, 3)}]`).join("; ") || "—"}`);
    out.push(`- Complaints: ${b.complaints.slice(0, 5).map((c) => `${c.label} (${c.count}) [${ids(c, 3)}]`).join("; ") || "—"}`, "");
  }

  if (a.switches.length) {
    out.push("### Switching flows", "", "| From | To | Count | Evidence |", "|---|---|---:|---|");
    for (const s of a.switches.slice(0, 15)) out.push(`| ${esc(s.from)} | ${esc(s.to)} | ${s.count} | [${ids(s, 5)}] |`);
    out.push("");
  }

  if (a.amazon.length) {
    const currency = a.amazon.find((p) => p.currency)?.currency;
    out.push("### Amazon listings", "", `| Product | Price${currency ? ` (${currency})` : ""} | Rating | Reviews |`, "|---|---:|---:|---:|");
    for (const p of a.amazon.slice(0, 15)) out.push(`| [${esc(truncate(p.title, 80))}](${p.url}) [${p.id}] | ${p.price ?? "–"} | ${p.rating ?? "–"} | ${p.reviews?.toLocaleString() ?? "–"} |`);
    out.push("");
  }

  if (a.creators.length) {
    out.push("### Creators & accounts in the conversation", "", "| Name | Platform | Items | Reach (views/likes) |", "|---|---|---:|---:|");
    for (const c of a.creators) out.push(`| ${esc(c.name)} | ${c.source} | ${c.items} | ${Math.round(c.reach).toLocaleString()} |`);
    out.push("");
  }

  if (a.otherBrands.length) {
    out.push("### Other brands mentioned (possible competitors not in the plan)", "", a.otherBrands.map((o) => `${o.label} (${o.count})`).join(", "), "");
  }

  if (demand.length) {
    out.push("### Search autocomplete", "");
    for (const d of demand) out.push(`- **${d.seed}** → ${d.suggestions.slice(0, 10).join(" · ")}`);
    out.push("");
  }

  if (errors.length) {
    out.push("### Collection gaps", "", "These sources failed or were skipped, so the report does not reflect them:", "");
    for (const e of errors.slice(0, 30)) out.push(`- \`${e.task}\` — ${e.kind}: ${esc(e.message.split("\n")[0]).slice(0, 200)}`);
    out.push("");
  }
  return out.join("\n");
}

function sourcesList(items: Item[], used: Set<string>): string {
  const lines = ["## Sources", ""];
  for (const i of items.filter((i) => used.has(i.id))) {
    const label = esc(truncate(i.title || i.text, 140));
    const link = i.url ? `[${label}](${i.url})` : label;
    lines.push(`- <a id="${i.id.toLowerCase()}"></a>**${i.id}** · ${i.source}${i.kind !== "post" ? ` ${i.kind}` : ""}${i.author ? ` · ${esc(i.author)}` : ""} · ${link}`);
  }
  return lines.join("\n");
}

export function buildReport(args: {
  plan: Plan;
  analysis: Analysis;
  items: Item[];
  demand: SearchDemand[];
  errors: CollectError[];
  narrative: string;
  generatedWith: string;
}): { md: string; html: string; invalidCitations: string[]; uncitedBullets: number } {
  const { plan, analysis, items, demand, errors } = args;
  const narrative = args.narrative.replace(NON_CITATION_LABEL, "");
  const valid = new Set(items.map((i) => i.id));
  const body = `${narrative.trim()}\n\n${tables(analysis, demand, errors)}`;
  const { md: linked, invalid } = linkCitations(body, valid);
  const used = new Set([...linked.matchAll(/\]\(#(s\d+)\)/g)].map((m) => m[1].toUpperCase()));

  const header = `# Market research: ${plan.subject}

*Generated ${new Date().toISOString().slice(0, 10)} · ${analysis.totals.relevant} relevant of ${analysis.totals.items} collected items · sources: ${Object.keys(analysis.totals.bySource).join(", ")} · ${args.generatedWith}*

**Brands:** ${plan.brands.join(", ") || "—"} · **Competitors:** ${plan.competitors.join(", ") || "—"} · **Category:** ${plan.category || "—"}
`;
  const md = `${header}\n${linked}\n\n${sourcesList(items, used)}\n`;
  return { md, html: toHtml(`Market research: ${plan.subject}`, md), invalidCitations: [...new Set(invalid)], uncitedBullets: uncitedBullets(narrative) };
}

/** Bullets in evidence sections that carry no [S#] citation (Recommended actions and Caveats are exempt). */
function uncitedBullets(narrative: string): number {
  let count = 0;
  let exempt = false;
  for (const line of narrative.split("\n")) {
    const h = line.match(/^##\s+(.+)/);
    if (h) exempt = SECTIONS.some((s) => s.citationsOptional && h[1].trim().startsWith(s.title));
    else if (!exempt && /^\s*(?:[-*]|\d+\.)\s+\S/.test(line) && !/\[S\d+/.test(line)) count++;
  }
  return count;
}

function toHtml(title: string, md: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title.replace(/</g, "&lt;")}</title>
<style>
:root { --bg:#fbfaf8; --fg:#1d1d1f; --muted:#6b6b70; --line:#e4e2dd; --accent:#2f5bd3; --code:#f1efea; }
@media (prefers-color-scheme: dark) { :root { --bg:#151517; --fg:#e8e6e3; --muted:#9a9aa0; --line:#2c2c30; --accent:#86a8ff; --code:#212124; } }
body { background:var(--bg); color:var(--fg); font:16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin:0; padding:32px 16px; }
main { max-width:860px; margin:0 auto; }
h1 { font-size:2rem; line-height:1.2; } h2 { margin-top:2.4em; padding-bottom:.3em; border-bottom:1px solid var(--line); } h3 { margin-top:1.8em; }
a { color:var(--accent); } em { color:var(--muted); }
table { border-collapse:collapse; width:100%; display:block; overflow-x:auto; font-size:.9rem; }
th, td { border-bottom:1px solid var(--line); padding:6px 10px; text-align:left; vertical-align:top; }
code { background:var(--code); padding:1px 5px; border-radius:4px; font-size:.85em; }
li { margin:.25em 0; }
</style>
</head>
<body><main>
${marked.parse(md, { async: false }) as string}
</main></body>
</html>`;
}
