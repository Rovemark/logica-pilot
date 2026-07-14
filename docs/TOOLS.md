# Logica Pilot — Tool Reference (43 tools)

The complete, authoritative reference for every Logica Pilot capability. **One
registry, three surfaces** — each tool is identical across:

- **CLI** — `node bin/logica-pilot.js <tool> [args]`
- **MCP** — `browser_<tool>` (`{ "mcpServers": { "logica-pilot": { "command": "logica-pilot", "args": ["mcp"] } } }`)
- **Programmatic** — `require('logica-pilot')` (or the LogicaOS `pilot` skill's `tool(name, args)`)

Everything is **token-first** (compact indexed perception, never raw HTML),
**zero-dependency** (pure CDP, no Playwright/Puppeteer), and **local** (your data
never leaves the machine).

> Args marked `*` are required. Full schemas are in [`src/tools.js`](../src/tools.js).

---

## Navigation (5)

| Tool | Purpose | Args |
|------|---------|------|
| **navigate** | Go to a URL, return the indexed map | `url*` |
| **back** / **forward** | History nav, return the map | — |
| **reload** | Reload, return the map | `url` |
| **wait** | Semantic wait (text/selector/timeout — no brittle sleeps) | `text`, `selector`, `timeout` |

## Perception (10) — token-first perception

| Tool | Purpose | Args |
|------|---------|------|
| **observe** | The indexed map (`[n] type "label"` + text) — replaces HTML/screenshot | `url`, `maxElements` |
| **read** | Readable content; `markdown` = LLM-ready Markdown; `maxChars`/`offset` pagination; `maxAge` cache; `redactPII`; `summarize` | `url`, `markdown`, `maxChars`, `offset`, `maxAge`, `redactPII`, `summarize` |
| **extract** | Structured JSON (`instruction`/`schema`) or CSS-matched text (`query`) | `url`, `instruction`, `schema`, `query` |
| **meta** | Deterministic metadata (0 tokens): title/description/canonical/favicon, OpenGraph/Twitter, JSON-LD types | `url` |
| **images** | Meaningful images (url+alt+size), og:image first, icons skipped | `url`, `max` |
| **product** | Deterministic product data (JSON-LD → microdata → og:price): name/brand/price/availability/rating — **fails closed**, never guesses | `url` |
| **media** | Discover video/audio/direct files/embeds; `download` saves direct files (size-capped) | `url`, `download`, `dir`, `maxMB` |
| **links** | All links (text+url), deduped, compact | `url` |
| **handoff** | **Human handoff** — detect a login/captcha/Cloudflare/payment wall; `wait` pauses for you to resolve it, then continues | `action`, `url`, `timeout` |
| **screenshot** | Capture (visual fallback); `marks` draws the indices | `url`, `fullPage`, `marks` |

## Actions (6) — act by index, no selectors

| Tool | Purpose | Args |
|------|---------|------|
| **act** | Act by index: `click` / `type` / `press` / `scroll` | `action*`, `index`, `text`, `submit`, `key`, `direction`, `amount` |
| **fill** | Fill many fields at once (Form Autopilot) | `fields*` |
| **select** | Choose a `<select>` option by index + value | `index*`, `value*` |
| **hover** | Hover an element by index (reveals menus/tooltips) | `index*` |
| **eval** | Run JavaScript in the page (power tool) | `expression*` |
| **pdf** | Save the page as PDF | `out` |

## Autonomy (3)

| Tool | Purpose | Args |
|------|---------|------|
| **run** | Execute a multi-step objective autonomously (observe→decide→act). Saved by the flight recorder; **learns fixes + recipes** per site; `shots` captures a screenshot per step | `goal*`, `url`, `maxSteps`, `shots` |
| **adapter** | **Site Adapters** — a site task becomes a named, parameterized tool (`save`/`run`); saved adapters appear as their own MCP tools `x_<name>` | `action*`, `name`, `host`, `goal`, `params` |
| **workflow** | **Autopilot Recorder** — save concrete steps, `replay` deterministically **by label** (no LLM); AI fallback on a miss | `action*`, `name`, `steps`, `params`, `fallback` |

## Site (6) — whole-site capabilities

| Tool | Purpose | Args |
|------|---------|------|
| **map** | Discover a site's URLs instantly (robots.txt sitemaps + sitemap.xml, on-page links fallback); `search` filter | `url*`, `search`, `limit` |
| **crawl** | Crawl a site/section BFS in parallel: `includePaths`/`excludePaths` regex, `maxDepth`, robots.txt; compact `{url,title,text}` | `url*`, `limit`, `maxDepth`, `includePaths`, `excludePaths`, `proxy`, `location`, `redactPII` |
| **index** | **Local BM25 search** — crawl once, then query **offline (0 tokens, 0 network)** | `action*`, `name`, `url`, `q`, `k`, `limit` |
| **dataset** | **Living datasets** — scrape/gather output → named table with dedupe, per-run diff, CSV/JSON export | `action*`, `name`, `rows`, `key`, `format` |
| **batch** | **Async jobs** — start a fanout/crawl detached, then `status`/`get` | `action*`, `kind`, `id`, … |
| **llmstxt** | Generate the standard `llms.txt` for a site | `url*`, `limit` |

## Multi-Agent (8) — parallel orchestration

| Tool | Purpose | Args |
|------|---------|------|
| **fanout** | Run a task on N URLs in parallel + optional synthesis | `urls*`, `task*`, `mode`, `schema`, `synthesize` |
| **search** | Web search (Bing/Brave); `content` also reads the top results in parallel | `query*`, `limit`, `content` |
| **gather** | **Schema in, JSON out** — find sources (or take urls), extract in parallel, merge into one validated JSON + sources; optional `dataset` | `instruction*`, `schema`, `urls`, `dataset` |
| **ask** | Answer grounded in a `url` (quotes the passage) or from web sources with citations `[n]` | `question*`, `url`, `limit` |
| **research** | Deep Research: search + parallel reads + cited synthesis | `query*`, `limit` |
| **compare** | Extract from N URLs + comparison table + recommendation | `urls*`, `task` |
| **deal** | Find stores → parallel price/shipping → rank by total cost | `product*`, `limit` |
| **factcheck** | Independent sources + verdict with citations | `claim*`, `limit` |

## Session, Memory & Monitoring (5)

| Tool | Purpose | Args |
|------|---------|------|
| **session** | Login sessions (cookies): `save`/`load`/`list` — log in once, reuse forever | `action*`, `name`, `url` |
| **memory** | What the Pilot **learned** per site (flywheel): visits, hot elements, recipes, fixes | `domain` |
| **watch** | Change tracking: `new`/`same`/`changed` vs the last snapshot (persisted), git-style diff, `tag`, `webhook` | `url*`, `tag`, `diff`, `webhook` |
| **monitor** | Scheduled monitors + alerts: `add` a URL with a cadence + `notify` (telegram/webhook/desktop); daemon checks due ones | `action*`, `url`, `every`, `notify` |
| **runs** | Flight recorder: browse past runs (steps + tokens + screenshots) as HTML reports | `action`, `id` |

---

## Killer capabilities (what a cloud scraper can't do)

### Attach to YOUR browser
Drive an already-running Chrome/Edge/Brave — your real profile, logins, extensions —
via a zero-dependency WebSocket CDP client. `close()` only detaches, never kills it.
```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222
logica-pilot run "reply to my latest email" --attach 9222
# MCP: LOGICA_PILOT_ATTACH=9222
```

### Bring your own proxy + location
Any provider in `user:pass@host:port` form (Webshare, Bright Data, Oxylabs, Smartproxy…).
```bash
export LOGICA_PILOT_PROXY="http://user:pass@p.webshare.io:80"
export LOGICA_PILOT_LOCATION=BR   # timezone + locale + Accept-Language
logica-pilot crawl loja.com --location '{"country":"BR"}'
```

### PII redaction (deterministic, local, free)
`read --redactPII` / `crawl --redactPII` masks emails, phones, CPF/CNPJ, credit cards
(Luhn-validated), IPs — **before** the text reaches any model.

### Consent-killer
Cookie/consent walls are auto-dismissed right after navigation, before perception —
a cleaner map, fewer tokens, unblocked content. Automatic on every navigation.

### Self-repair
Every failure and the fix that worked are remembered **per host** and surfaced as a
`⚠️ LEARNED ON THIS SITE` note on the map — the browser converges toward zero breakage.

### Token efficiency
Prompt caching + stale-map pruning = **~77% lower input cost** per autonomous run;
perception is **5–185× smaller** than raw HTML (see the [README benchmark](../README.md#real-world-benchmark)).

---

## Examples

```bash
# Perception & extraction
logica-pilot observe https://news.ycombinator.com
logica-pilot read "https://en.wikipedia.org/wiki/Coffee" --markdown --maxChars 4000
logica-pilot product --url https://kabum.com.br/produto/123     # deterministic, 0 tokens

# Whole-site
logica-pilot map docs.stripe.com --search webhook
logica-pilot crawl docs.stripe.com --limit 20 --includePaths '["^/payments"]'
logica-pilot index build --name stripe --url docs.stripe.com --limit 25
logica-pilot index query --name stripe --q "webhook retry"      # offline, 0 tokens

# Multi-agent
logica-pilot search "melhor notebook custo beneficio" --content
logica-pilot gather "price of RTX 4090" --schema '{"products":[{"name":"string","price":"number"}]}'
logica-pilot research "what is Model Context Protocol?"

# Automation & memory
logica-pilot run "find the CEP of Av. Paulista 1000" --shots
logica-pilot adapter save --name amz --host amazon.com.br --goal 'search {q}, return top 5 with price'
logica-pilot workflow replay --name login-gmail
logica-pilot monitor add --url loja.com/produto --every 2h --notify '{"telegram":true}'
logica-pilot monitor-daemon                                      # background daemon

# Drive your real browser
logica-pilot observe --attach 9222
```
