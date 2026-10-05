import { opencli, opencliRaw } from "./opencli.js";
import type { Source } from "./types.js";

export interface LoginStatus {
  site: Source;
  loggedIn: boolean | undefined;
  detail: string;
}

/** OpenCLI site names for the sources whose built-in `auth status` probe we trust. */
const AUTH_SITES: Partial<Record<Source, string>> = { reddit: "reddit", youtube: "youtube", amazon: "amazon", tiktok: "tiktok" };

/**
 * OpenCLI's X probe looks for a profile link on x.com/home and reports "not logged in" for sessions
 * where search works fine. X only serves search to signed-in users, so a one-result search is the real test.
 */
async function xLogin(): Promise<LoginStatus> {
  try {
    const rows = await opencli({ site: "twitter", cmd: "search", args: ["news"], opts: { limit: 1 }, browser: true, cache: false });
    return rows.length ? { site: "twitter", loggedIn: true, detail: "search works" } : { site: "twitter", loggedIn: undefined, detail: "search returned nothing" };
  } catch (e) {
    const msg = (e as Error).message;
    return { site: "twitter", loggedIn: /not logged in|auth/i.test(msg) ? false : undefined, detail: msg.split("\n")[0] };
  }
}

export async function checkLogins(sources: Set<Source>): Promise<LoginStatus[]> {
  const out: LoginStatus[] = [];
  const sites = Object.entries(AUTH_SITES).filter(([src]) => sources.has(src as Source));
  if (sites.length) {
    const { code, out: raw } = await opencliRaw(["auth", "status", "--site", sites.map(([, s]) => s).join(","), "--full", "-f", "json"], 120_000);
    let rows: { site: string; logged_in: boolean; status: string; identity?: string; error?: string }[] = [];
    try {
      rows = JSON.parse(raw.slice(raw.indexOf("[")));
    } catch {
      // fall through: report as unknown below
    }
    for (const [src, site] of sites) {
      const r = rows.find((x) => x.site === site);
      out.push(
        r
          ? { site: src as Source, loggedIn: r.status === "unknown" || r.status === "error" ? undefined : r.logged_in, detail: r.logged_in ? `as ${r.identity || "unknown user"}` : r.error || r.status }
          : { site: src as Source, loggedIn: undefined, detail: code === 0 ? "no result" : raw.trim().split("\n").pop() ?? "check failed" },
      );
    }
  }
  if (sources.has("twitter")) out.push(await xLogin());
  return out;
}
