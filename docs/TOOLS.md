# Logica Pilot — Tool Reference (80 tools)

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

## Perception (14) — token-first perception

| Tool | Purpose | Args |
|------|---------|------|
| **observe** | The indexed map (`[n] type "label"` + text) — replaces HTML/screenshot | `url`, `maxElements` |
| **read** | Readable content; `markdown` = LLM-ready Markdown; `maxChars`/`offset` pagination; `maxAge` cache; `redactPII`; `summarize`; **`engine`** = `browser`\|`http`\|`adaptive` (http = fetch+parse without a browser, 10-50× cheaper; adaptive auto-escalates) | `url`, `markdown`, `maxChars`, `offset`, `maxAge`, `redactPII`, `summarize`, `engine`, `proxy` |
| **extract** | Structured JSON (`instruction`/`schema`) or CSS-matched text (`query`) | `url`, `instruction`, `schema`, `query` |
| **meta** | Deterministic metadata (0 tokens): title/description/canonical/favicon, OpenGraph/Twitter, JSON-LD types | `url` |
| **images** | Meaningful images (url+alt+size), og:image first, icons skipped | `url`, `max` |
| **product** | Deterministic product data (JSON-LD → microdata → og:price): name/brand/price/availability/rating — **fails closed**, never guesses | `url` |
| **apis** | **Backend API discovery** — find the private JSON APIs a page calls (`discover`) and re-fire them (`replay`, carries live session/auth). Hit the data source, not the HTML | `url`, `action`, `duration`, `on`, `method`, `params`, `body` |
| **jsdata** | Surface in-page JS hydration state (`__NEXT_DATA__`, `__NUXT__`, `__APOLLO_STATE__`, …) + every `application/json`/`ld+json` script — clean data before it's rendered | `url` |
| **locate** | **Reverse-lookup** — paste a value you see on the page, get the exact JSON-path + source (hydration blob / JSON-LD / discovered API) that yields it | `url`, `value*`, `regex` |
| **video** | Token-first video understanding: extract sources/duration/platform, fetch caption tracks into a transcript, optionally sample keyframes (`frames`) and LLM-summarize (`describe`) | `url`, `describe`, `frames`, `index` |
| **media** | Discover video/audio/direct files/embeds; `download` saves direct files (size-capped) | `url`, `download`, `dir`, `maxMB` |
| **links** | All links (text+url), deduped, compact | `url` |
| **handoff** | **Human handoff** — detect a login/captcha/Cloudflare/payment wall; `wait` pauses for you to resolve it, then continues | `action`, `url`, `timeout` |
| **screenshot** | Capture (visual fallback); `marks` draws the indices | `url`, `fullPage`, `marks` |

## Actions (12) — act by index, no selectors

| Tool | Purpose | Args |
|------|---------|------|
| **act** | Act by index: `click` / `type` / `press` / `scroll` | `action*`, `index`, `text`, `submit`, `key`, `direction`, `amount` |
| **fill** | Fill many fields at once (Form Autopilot) | `fields*` |
| **select** | Choose a `<select>` option by index + value | `index*`, `value*` |
| **hover** | Hover an element by index (reveals menus/tooltips) | `index*` |
| **eval** | Run JavaScript in the page (power tool) | `expression*` |
| **pdf** | Save the page as PDF | `out` |
| **upload** | Upload file(s) to an `<input type="file">` by index or CSS selector | `target*`, `files*`, `url` |
| **dialog** | Auto-handle native dialogs (alert/confirm/prompt/beforeunload): `accept`, optional `promptText`; set before the triggering action | `accept`, `promptText` |
| **drag** | Drag and drop from one element index to another | `from*`, `to*`, `url` |
| **storage** | Read/write localStorage or sessionStorage (`get`/`set`/`remove`/`clear`) | `action*`, `type`, `key`, `value`, `url` |
| **permission** | Grant browser permissions (geolocation/notifications/camera/mic/clipboard…) via CDP; `reset` clears | `permissions`, `reset` |
| **evalbatch** | Run several JS expressions in one round-trip; each result/error returned in order | `expressions*`, `url` |

## Autonomy (6)

| Tool | Purpose | Args |
|------|---------|------|
| **run** | Execute a multi-step objective autonomously (observe→decide→act). Saved by the flight recorder; **learns fixes + recipes** per site; `shots` captures a screenshot per step | `goal*`, `url`, `maxSteps`, `shots` |
| **adapter** | **Site Adapters** — a site task becomes a named, parameterized tool (`save`/`run`); saved adapters appear as their own MCP tools `x_<name>` | `action*`, `name`, `host`, `goal`, `params` |
| **workflow** | **Autopilot Recorder** — save concrete steps, `replay` deterministically **by label** (no LLM); AI fallback on a miss | `action*`, `name`, `steps`, `params`, `fallback` |
| **actor** | **Formal Actor packaging** — a versioned, self-describing unit = manifest + typed INPUT schema + entry (crawler/tool) + engine. `init`/`list`/`get`/`run`/`remove`; `run` validates+coerces input, writes a dataset + INPUT/OUTPUT to the run KVS; REST-callable | `action*`, `name`, `input`, `schema`, `entry`, `engine` |
| **crawler** | **Crawlee-style structured crawler** — durable queue + a `pageFunction` on every matched page → rows into a dataset; auto link-enqueue (`strategy`/`globs`), concurrency, retry, **resume**; `engine` http/browser/adaptive; `sessionPool` to rotate identities | `url`, `name`, `pageFunction`, `engine`, `strategy`, `globs`, `maxDepth`, `maxRequests`, `maxConcurrency`, `resume`, `sessionPool` |
| **sessions** | **Rotating identity pool** with health scoring (SessionPool): sticky fingerprint+proxy+cookies per session; `borrow` least-used, `good`/`bad` scoring, auto-retire burned identities; feed `crawler --sessionPool` | `action*`, `name`, `id`, `maxPoolSize`, `pool` |

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

## Session, Memory & Monitoring (6)

| Tool | Purpose | Args |
|------|---------|------|
| **session** | Login sessions (cookies): `save`/`load`/`list` — log in once, reuse forever | `action*`, `name`, `url` |
| **persist** | Domain-keyed cookie persistence tuned for **Cloudflare clearance** (`save`/`load`/`list`/`clear`); load BEFORE navigating so `cf_clearance` carries over | `action`, `domain`, `url` |
| **memory** | What the Pilot **learned** per site (flywheel): visits, hot elements, recipes, fixes | `domain` |
| **watch** | Change tracking: `new`/`same`/`changed` vs the last snapshot (persisted), git-style diff, `tag`, `webhook` | `url*`, `tag`, `diff`, `webhook` |
| **monitor** | Scheduled monitors + alerts: `add` a URL with a cadence + `notify` (telegram/webhook/desktop); daemon checks due ones | `action*`, `url`, `every`, `notify` |
| **runs** | Flight recorder: browse past runs (steps + tokens + screenshots) as HTML reports | `action`, `id` |

## Browser Control (13)

| Tool | Purpose | Args |
|------|---------|------|
| **stealth** | Anti-fingerprint (`regular`/`stealth`/`undetected`): patches `navigator.webdriver`, `chrome.runtime`, permissions, plugins/WebGL/languages. **Opt-in**; for CAPTCHAs prefer `handoff` over bypass | `mode` |
| **fingerprint** | **Realistic, internally-consistent fingerprint** (vs stealth's static patches): coherent UA + UA-CH + platform + screen + webgl + languages + hardware, weighted by market share; `browser`/`os` filter, `seed` = sticky, `webrtc` blocks IP leak | `browser`, `os`, `seed`, `webrtc`, `url` |
| **sessions** | **Rotating identity pool** with health scoring (SessionPool): sticky fingerprint+proxy+cookies per session; `borrow` least-used, `good`/`bad` scoring, auto-retire burned identities; feed `crawler --sessionPool` | `action*`, `name`, `id`, `maxPoolSize`, `pool` |
| **device** | Emulate a mobile device (`iphone`/`ipad`/`android`/`reset`) or custom viewport+UA; `list` returns profiles | `device`, `list`, `url` |
| **geo** | Override GPS geolocation (`lat`+`lon`+`accuracy`), or `clear` | `lat`, `lon`, `accuracy`, `clear`, `url` |
| **tabs** | Multi-tab & iframe management: `list`/`new`/`switch`/`close`/`frames` | `action`, `targetId`, `url` |
| **wipe** | Per-task hygiene: clear cookies/storage/cache (optionally only `olderThanDays`) | `cookies`, `storage`, `cache`, `olderThanDays`, `url` |
| **health** | Browser health: alive, tab count, memory, recent crashes | — |
| **html** | Raw HTML of the page (or a `selector`) — prefer `read`/`observe` unless you need raw markup | `selector`, `outer`, `url` |
| **fast** | Fast mode: reduce per-command auto-wait + disable animations | `on` |
| **feedback** | Visual overlay (cursor trail, click ripples, keystroke/toast) so a human watching a headful run sees what the agent does; `off` removes | `off`, `cursor`, `ripples`, `keystrokes`, `toast`, `glow`, `url` |
| **window** | Control the real window: `normal`/`minimized`/`maximized`/`fullscreen`/`offscreen`, or set bounds (headful only) | `state`, `left`, `top`, `width`, `height` |
| **captcha** | CAPTCHA/bot-wall handling: `detect` (read-only) / `solve` (**opt-in** via `LOGICA_PILOT_CAPTCHA` + solver key, else recommends `handoff`); reCAPTCHA/hCaptcha/Turnstile | `action`, `url` |

## Network (4)

| Tool | Purpose | Args |
|------|---------|------|
| **block** | Block requests by preset (`images`/`fonts`/`media`/`ads`) or URL patterns — leaner scraping; `off` disables | `what`, `off`, `url` |
| **throttle** | Simulate network (`slow3g`/`fast3g`/`offline`) or `off` | `profile`, `url` |
| **intercept** | Request interception: `mock` (canned response) / `headers` (inject) / `clear` | `action`, `pattern`, `response`, `headers` |
| **proxypool** | Named proxy pools with rotation: `list`/`pick`/`add`/`remove`/`presets`; strategies round-robin/sticky/random (sticky keyed by `session`); `pick` returns a proxy for `--proxy` | `action`, `name`, `proxies`, `strategy`, `geo`, `session` |

## DevTools (1)

| Tool | Purpose | Args |
|------|---------|------|
| **inspect** | DevTools inspection: `console`/`network` capture (`duration` ms), `perf` metrics, `eval` with a stack trace | `kind`, `duration`, `filter`, `expression`, `url` |

## Testing (1)

| Tool | Purpose | Args |
|------|---------|------|
| **assert** | Assertions (title/url is/contains, text_visible, element_exists/count/text/value/visible, has_cookie, screenshot_match); one `{type,expected,selector?}` or an `assertions` array | `type`, `expected`, `selector`, `index`, `name`, `assertions`, `url` |

## HTTP & Storage (5) — Apify/Crawlee parity

| Tool | Purpose | Args |
|------|---------|------|
| **fetch** | **Raw HTTP fetch, no browser** (Crawlee's cheap path): GET/POST a URL or JSON API; redirects, gzip/br, cookie jar, proxy via CONNECT, `fingerprint` headers; `as` json/text. 10-50× faster for static/SSR pages & APIs | `url*`, `method`, `headers`, `body`, `proxy`, `as`, `fingerprint`, `maxBytes` |
| **queue** | **Durable RequestQueue** — persisted, deduped, resumable frontier (a crawl killed mid-run resumes; per-URL retry → dead-letter). `add`/`stats`/`next`/`failed`/`list`/`drop` | `action`, `name`, `urls`, `url`, `label`, `clear` |
| **kvs** | **Key-Value Store** — arbitrary blobs/records (screenshots, PDFs, Actor INPUT/OUTPUT, checkpoints, RAG payloads). JSON/text/`{base64,contentType}`. `set`/`get`/`list`/`delete`/`stores`/`drop` | `action`, `store`, `key`, `value`, `contentType` |
| **webhook** | **Run-lifecycle webhooks** — subscribe to `run.succeeded`/`failed`/… → POST on the event ("job done → pull the dataset"). `add`/`list`/`remove`/`fire` | `action`, `event`, `url`, `actor`, `id`, `data` |
| **schedule** | **Cron scheduling of Actors** — 5-field cron (step/range/list). `add`/`list`/`remove`/`enable`/`run-due` | `action`, `cron`, `actor`, `input`, `id`, `enabled` |

> **Serve it as an API:** `logica-pilot serve` exposes the whole registry over HTTP — `GET /?url=…&render_js=&markdown=&screenshot=&extract=` (ScrapingBee/ScraperAPI drop-in), `POST /v1/tools/:name`, `POST /v1/actors/:name/runs`, `GET /v1/datasets/:name/items`, `GET /v1/key-value-stores/:store/records/:key`. Token auth via `LOGICA_PILOT_API_KEY`.

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
