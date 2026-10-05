# open-review

Local-first market research reports. Give it a brand, product, or category. It plans the research, sends a
ReAct agent to collect posts, comments, videos, reviews and search data through
[OpenCLI](https://github.com/jackwener/opencli) using your own browser sessions, analyzes everything with a
local LLM through [Ollama](https://ollama.com), and writes a report in which every claim links to the post,
comment or review it came from.

- **Customer voice, not just headlines:** the collection agent opens busy Reddit threads, YouTube comments and
  Amazon reviews, and keeps searching until each brand has coverage.
- **Grounded reports:** numbers are computed by code; the writing agent must cite sources, and citations are
  checked before a section is accepted.
- **Local by default:** collection, analysis and writing run on your machine. Optional Claude synthesis.
- **Inspectable:** every raw response, every agent step (with its reasoning) and every extraction is saved.

## How it works

```
"Liquid Death"
  → plan        LLM + real search autocomplete → brands, competitors, category, search qualifier ("drink"),
                starting queries per platform
  → collect     ReAct agent: reason → call a tool → observe → repeat, steered by a coverage line
                tools: web · news · reddit (search, open threads) · x · youtube (search, comments, transcripts)
                       amazon (search, reviews) · hackernews · substack · tiktok
  → store       projects/<subject>/<run>/raw/*.json  (every raw response) + agent-trace.jsonl
  → analyze     relevance filter → per-item extraction (brands, sentiment, aspects, switching,
                objections, purchase triggers, prices) → deterministic aggregation
  → report      ReAct analyst writes one section at a time: searches the evidence (embeddings + keywords),
                reads items, may fetch more for gaps, submits sections whose citations are validated
                → report.html + report.md, [S12] citations link to the sources list
```

## Requirements

- **Node.js ≥ 20.18.1** and **pnpm**
- **[Ollama](https://ollama.com)** with a model that supports tool calling (default `qwen3.6:35b-a3b`) and
  `qwen3-embedding:0.6b`
- **Google Chrome or Chromium** for the sources that need a browser (Reddit, X, YouTube, Amazon, TikTok, web search)
- **RAM:** about 24–26 GB free for the default model (see [Hardware and models](#hardware-and-models))
- Developed and tested on macOS (Apple Silicon). Linux should work; Windows is untested.
- Optional: Docker, for the SearXNG web-search fallback

OpenCLI is installed as a project dependency; no global install is needed.

## Quick start

```bash
git clone <this repo> && cd open-review
pnpm install
cp .env.example .env                       # optional; defaults work

ollama pull qwen3.6:35b-a3b                # main model: planning, agents, filtering, extraction, writing
ollama pull qwen3-embedding:0.6b           # evidence search for the writing agent

pnpm cli browser login                     # opens a dedicated Chrome profile: sign in, then quit it
pnpm check --headless                      # verifies OpenCLI, browser, logins, models and free memory
pnpm report "Liquid Death" --headless
```

The report opens from `projects/liquid-death/<timestamp>/report.html`.

## Browser and logins

Google Suggest, Google News, Hacker News and Substack work without a browser or login. The other sources run
through Chrome. Pick one setup.

**Option A: dedicated headless Chrome (recommended).** No extension, and your everyday browser is untouched.

```bash
pnpm cli browser login          # opens a separate profile (.browser-profile/) with login pages
pnpm report "<subject>" --headless   # or set BROWSER_MODE=cdp in .env
```

Sign in to the sites you want covered, then quit that window; the sessions stay in the profile. Reports start
headless Chrome on it and stop it afterwards. Sessions expire every few weeks; `pnpm check --headless` shows
which sites are logged in, and running `browser login` again refreshes them.

**Option B: your everyday Chrome with the OpenCLI extension.**

1. Download the extension from the [OpenCLI releases](https://github.com/jackwener/opencli/releases).
2. `chrome://extensions` → enable Developer Mode → **Load unpacked** → select the extension folder.
3. Sign in to reddit.com, x.com, youtube.com and amazon.com in that Chrome, and keep it open during runs.

Which logins matter: Reddit and X searches need a session. YouTube search works logged out. Amazon search works
logged out, but customer reviews need a session.

**Optional SearXNG** (free self-hosted metasearch). Google blocks headless browsers, so web search falls back
to SearXNG, then DuckDuckGo:

```bash
docker compose up -d searxng
```

## Usage

```bash
pnpm report "Liquid Death" --headless
pnpm report "canned water" --competitors "Liquid Death,Mananalu,Proud Source"
pnpm report "Notion" --sources reddit,youtube,hackernews,news --deep 8
pnpm report "Liquid Death" --synth claude        # write the report with Claude (needs ANTHROPIC_API_KEY)
pnpm report --resume projects/liquid-death/20261005-033843   # continue an interrupted run
```

| Option | Default | |
|---|---|---|
| `--sources` | all except tiktok | `news,hackernews,web,reddit,twitter,youtube,amazon,substack,tiktok` |
| `--competitors` | — | seed competitors; the planner adds more |
| `--limit` | 10 | results per query |
| `--deep` | 5 | cap on threads, videos and products opened for comments, transcripts and reviews |
| `--headless` | off | collect through the dedicated headless Chrome (`BROWSER_MODE=cdp`) |
| `--no-agent` | off | fixed collection plan and one-shot writing instead of the ReAct agents |
| `--synth` | `local` | `local` (Ollama) or `claude` |
| `--no-filter` | off | skip the relevance-filter pass |
| `--resume` | — | continue a run; collection, filtering, extraction batches and finished sections are reused |

Other commands: `pnpm check` (health check), `pnpm cli browser login`, `pnpm typecheck`.

### Output

Each run writes to `projects/<subject>/<timestamp>/` (git-ignored):

| File | |
|---|---|
| `report.html`, `report.md` | the report |
| `plan.json` | brands, competitors, qualifier and starting queries |
| `raw/*.json` | every OpenCLI response, untouched |
| `items.json` | normalized, deduplicated items with citation ids (`S1`, `S2`, …) |
| `relevant.json` | items that passed the relevance filter |
| `extraction.jsonl` | per-item extraction, appended per batch |
| `analysis.json` | aggregated numbers behind the report tables |
| `agent-trace.jsonl`, `synth-trace.jsonl` | every agent step: reasoning, tool call, observation |
| `sections.json` | report sections, saved as each is accepted |
| `embeddings.json` | cached evidence embeddings |
| `demand.json`, `errors.json` | search autocomplete; sources that failed or were skipped |

### Report contents

Executive summary · Competitive landscape · What customers love · What customers complain about ·
Switching & churn signals · Pricing & value perception · Customer language & search demand ·
Opportunities & whitespace · Recommended actions · Caveats. Then a data appendix with share of voice and
sentiment per brand, top praise and complaints, switching flows, Amazon listings, creators, autocomplete and
collection gaps, followed by the cited sources.

## Agents

Both agents use Ollama's native tool calling.

**Collection agent.** It starts from the planner's queries and decides each next step from what came back:
it opens threads that name a tracked brand and have many comments, rephrases searches that return little, and
fills gaps. After every observation it sees a coverage line (items per brand, per source, and how much is
customer voice). Guardrails:

- a step budget (`AGENT_MAX_STEPS`, default 30) and per-tool caps;
- repeated queries are rejected;
- only sources allowed by `--sources` are offered;
- it may not finish early while customer voice is thin;
- if the model can't drive tools, the run falls back to the fixed plan.

**Writing agent.** It writes one section at a time with a small, fresh context. Tools:

| Tool | Does |
|---|---|
| `search_evidence` | semantic + keyword search over relevant items |
| `get_items` | read full items before citing them |
| `stats` | exact counts from code |
| `collect_more` | up to `SYNTH_COLLECT_BUDGET` (default 3) new searches per report to fill gaps |
| `write_section` | rejects sections with nonexistent ids, bracketed labels like `[Data]`, or no citations |

The executive summary is written last, from the other sections. A section the agent can't finish within 8
steps falls back to a single call grounded in the top search results.

`--no-agent` (or `SYNTH_AGENT=off`) uses the fixed plan and one-shot writing. `--synth claude` always uses
one-shot writing.

## How it stays trustworthy

- **Numbers come from code, not the LLM.** Mentions, sentiment, aspect counts, switching flows and Amazon
  tables are computed from the extractions. Brand mentions are also detected by exact name match, so a model
  that misses a brand can't erase it from share of voice.
- **Citations are checked.** The writing agent's sections are rejected until every `[S#]` exists; stray labels
  are stripped from the final text; the run log reports any evidence bullets left without a citation.
- **Gaps are visible.** Failed or skipped sources appear under "Collection gaps", and the Caveats section covers
  sample size and source bias. Counts describe the collected sample, not the market.

## Hardware and models

The default model, `qwen3.6:35b-a3b`, is a mixture-of-experts model (~3B active parameters per token, so it's
fast) that occupies about 22 GB. The engine protects the machine:

- **Memory check before every run.** If the model won't fit in free memory, the run stops with a message instead
  of pushing the system into heavy swapping. `pnpm check` shows the same check. Override with
  `SKIP_MEMORY_CHECK=1` at your own risk.
- **One large model at a time.** Filtering reuses the main model. The embedding model is capped at a 512-token
  context (~2 GB; Ollama's default 32k context would take ~6 GB).
- **One context size** (`LLM_NUM_CTX`, default 16k) for every call, since changing it makes Ollama reload the model.

On a 36 GB Mac, quit Docker Desktop and your everyday browser before a run.

With less memory, set `LLM_MODEL` to a smaller Ollama model that supports tool calling. For example,
`qwen3.8:27b` (~18 GB) is dense, so it's slower per token but smaller. Agent quality drops with smaller models;
`--no-agent` uses the fixed plan, which needs no tool calling.

### Speed

Measured for a full "Liquid Death" run (356 items) on an M3 Pro with 36 GB and `qwen3.6:35b-a3b`:

| Stage | Time |
|---|---|
| Collection agent (30 steps) | ~8 min |
| Relevance filter (336 items) | ~3 min |
| Extraction (36 batches) | ~15 min |
| Writing agent (10 sections) | ~13 min |

Browser commands run one at a time with a randomized pause (`BROWSER_DELAY_MS`, default 2.5 s). OpenCLI
responses are cached for `CACHE_TTL_HOURS` (default 24), so re-running a subject is faster.

## Configuration

Copy `.env.example` to `.env`. Main settings:

| Variable | Default | |
|---|---|---|
| `LLM_MODEL` | `qwen3.6:35b-a3b` | main Ollama model (needs tool calling for the agents) |
| `FILTER_MODEL` | `LLM_MODEL` | relevance-filter model |
| `EMBED_MODEL` | `qwen3-embedding:0.6b` | evidence search; keyword-only if not installed |
| `LLM_NUM_CTX` | `16384` | context size for every call |
| `LLM_THINK` | `off` | thinking level for extraction |
| `AGENT_MAX_STEPS` | `30` | collection agent tool-call budget |
| `SYNTH_AGENT` | `on` | section-by-section writing agent |
| `SYNTH_COLLECT_BUDGET` | `3` | extra searches the writing agent may make |
| `SYNTH_PROVIDER` / `CLAUDE_MODEL` | `local` / `claude-opus-5-5` | write the report with Claude instead |
| `BROWSER_MODE` | `extension` | `extension` or `cdp` (dedicated headless Chrome) |
| `CDP_ENDPOINT`, `CHROME_PATH` | `http://127.0.0.1:9333`, auto | dedicated Chrome settings |
| `BROWSER_DELAY_MS` | `2500` | pause between browser commands |
| `CACHE_TTL_HOURS` | `24` | OpenCLI response cache |
| `SEARCH_ORDER`, `SEARXNG_URL` | `google,searxng,duckduckgo` | web-search fallback chain |
| `SKIP_MEMORY_CHECK` | — | `1` to skip the free-memory check |

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Not enough free memory for …` | Quit memory-heavy apps (Docker Desktop, browsers, extra editor windows) and retry, or use a smaller `LLM_MODEL`. |
| `pnpm check` says the browser bridge isn't connected | Load the OpenCLI extension (Option B), or use `--headless` (Option A). |
| A site shows as not logged in | Run `pnpm cli browser login` (Option A) or sign in in your Chrome (Option B). |
| Web search returns nothing in headless mode | Expected for Google. Run SearXNG, or rely on the DuckDuckGo fallback. |
| Amazon products but no reviews | Amazon serves reviews only to signed-in sessions. |
| `browser login` says something is already listening on port 9333 | Another Chrome is using the debugging port, often a headless run or an earlier login window; close it first. |
| A run was interrupted | `pnpm report --resume projects/<subject>/<run>` continues where it stopped. |
| `pnpm doctor` prints nothing | That's pnpm's built-in command; use `pnpm check`. |
| The first step takes ~20 s | Ollama is loading the model; later steps are faster. |

## Known limitations

- Reddit search covers the past year, ranked by relevance.
- Competitor coverage depends on how much people discuss them; thin competitors can show few or zero mentions.
- Extraction quality depends on the local model; comparative statements are occasionally attributed to the
  wrong brand.
- OpenCLI adapters use sites' internal endpoints and can break when a site changes. Headless Chrome can be
  detected, and some sites challenge it.

## Responsible use

open-review reads pages you could read yourself, through your own sessions, at a human pace. It never posts,
likes or messages.

- **Platform terms.** Automated collection, even from your own session, may conflict with the terms of service
  of Reddit, X, YouTube, Amazon and others, and accounts can be restricted. Keep volume modest, and don't resell
  or redistribute collected content.
- **Privacy.** Collected posts include usernames and personal opinions. Everything stays on your machine in
  `projects/` (git-ignored). Don't publish raw data, and remove or anonymize names before sharing a report.
  You are responsible for complying with privacy laws such as the GDPR and CCPA.
- **Claude synthesis** (`--synth claude`) sends aggregated statistics and evidence quotes to the Anthropic API.

This project is not affiliated with OpenCLI, Ollama, Reddit, X, Google, YouTube, Amazon or any other platform
it reads from.

## Project structure

```
src/
  cli.ts            commands: report, check, browser login; pipeline orchestration and resume
  config.ts         settings from .env
  plan.ts           planner: brands, competitors, qualifier, starting queries
  collect.ts        Collector: one method per source, normalization, dedupe, citation ids; fixed plan
  collect-agent.ts  ReAct collection agent: tools, caps, coverage feedback
  agent.ts          shared ReAct loop over Ollama tool calling, with traces
  analyze.ts        relevance filter, extraction, aggregation
  evidence.ts       hybrid embedding + keyword search over collected items
  synth-agent.ts    section-by-section writing agent with citation validation
  report.ts         one-shot synthesis, data tables, citation linking, HTML
  llm.ts            Ollama chat, tool calls and embeddings; Claude client
  opencli.ts        OpenCLI runner: caching, pacing, exit-code handling
  search.ts         web search fallback chain and autocomplete
  browser.ts        dedicated Chrome profile: login window and headless launch
  logins.ts         per-site login checks
  memory.ts         free-memory check before loading the model
  types.ts, util.ts
```

## Acknowledgements

Built on [OpenCLI](https://github.com/jackwener/opencli) for site access, [Ollama](https://ollama.com) for local
models, and the [Qwen](https://github.com/QwenLM) model family.

## License

[MIT](LICENSE)
