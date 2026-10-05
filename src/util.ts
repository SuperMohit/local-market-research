import { createHash } from "node:crypto";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

export const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "project";

export const timestamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");

export const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

export const chunk = <T>(xs: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

export const uniq = <T>(xs: T[]) => [...new Set(xs)];

export const log = (step: string, msg: string) => process.stderr.write(`[${step}] ${msg}\n`);

/** Parse numbers like "1.2K", "3,400", "12M views". Returns undefined when nothing numeric is present. */
export function toNumber(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v !== "string") return undefined;
  const m = v.replace(/,/g, "").match(/([\d.]+)\s*([kmb])?/i);
  if (!m) return undefined;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[m[2]?.toLowerCase() as "k" | "m" | "b"] ?? 1;
  const n = parseFloat(m[1]) * mult;
  return Number.isFinite(n) ? n : undefined;
}

/** Pull the first JSON object/array out of a model response (tolerates code fences and preamble). */
export function extractJson(text: string): unknown {
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // fall through to bracket scan
  }
  const start = cleaned.search(/[[{]/);
  if (start < 0) throw new Error("no JSON found in model output");
  const open = cleaned[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  for (let i = start; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return JSON.parse(cleaned.slice(start, i + 1));
  }
  throw new Error("unterminated JSON in model output");
}
