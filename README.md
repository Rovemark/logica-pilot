<p align="center">
  <img src="docs/media/hero.svg" alt="Logica Pilot — the AI-native browser" width="100%">
</p>

# Logica Pilot

**The AI-native browser. Replace Playwright. 5–185× fewer perception tokens (measured on real sites).**

A real browser with an embedded autonomous AI copilot. The AI **perceives** pages by semantic
intent — not pixel coordinates — then **clicks, types, scrolls and reads** on its own until the
goal is met. Pure CDP engine · zero-dependency core · headless agent mode **and** a full desktop
browser · **CLI and MCP** with the same 39 tools.

<p align="center">
  <img src="docs/media/pilot-run.gif" alt="The Pilot autonomously scrolls, extracts and answers a goal on a live page" width="100%">
  <br><em>A real, unedited run: given a goal, the Pilot <strong>navigates, scrolls, extracts and answers on its own</strong> — steps stream on the right, the answer is formatted and in the browser's language.</em>
</p>

<p align="center">
  <img src="docs/media/screenshot-pilot.png" alt="The Pilot's result: highest-scoring Hacker News story, with steps and a formatted answer" width="100%">
</p>

<p align="center">
  <img src="docs/media/demo.gif" alt="Logica Pilot tour — new tab, a live page, native ad-block" width="100%">
</p>

---

## The Moat: it learns your sites

Token-first perception is easy to copy. **What compounds is memory.** Every task teaches Logica
Pilot which elements matter on a site and which action sequences work — stored **locally, on your
machine**. Repeat visits warm-start from that memory, so the browser gets **cheaper, faster and
more reliable per site the more your agents use it.** A stock Playwright script starts cold on
every single run.

<p align="center">
  <img src="docs/media/flywheel.svg" alt="The Logica Pilot learning flywheel" width="700">
</p>

This isn't a slide — **it ships.** After two clicks on Hacker News, the perception map itself
carries what was learned (no extra prompt, no extra tokens spent re-discovering it):

```console
$ logica-pilot act --url news.ycombinator.com --action click --index 1
$ logica-pilot act --url news.ycombinator.com --action click --index 4
$ logica-pilot observe news.ycombinator.com
  … indexed map …
★ MEMORY (news.ycombinator.com): seen 3× · often used here: "hacker news", "comments"

$ logica-pilot memory
{ "sites": 1, "actions": 2, "recipes": 0 }
```

**Four moats, compounding:**

| Moat | What it means | Status |
|------|---------------|--------|
| 🧠 **Site Memory** | Learns the important elements + recipes per host; repeat tasks warm-start (fewer tokens, known flows). | ✅ ships — `memory` tool |
| 🔐 **Local session vault** | Acts as the *logged-in you*, on *your* machine — what cloud scraping APIs can't do (no credentials, no privacy leak). | ✅ ships — `session` tool |
| 🛠️ **Self-repair memory** | Remembers each failure and its fix per site → converges toward zero breakage. | 🔜 roadmap |
| 🔌 **MCP-native distribution** | The default browser tool across the agent ecosystem (Claude Desktop, Cursor, Cline). | ✅ ships — MCP server |

> Your interaction history is **local and private** — the moat is *your* accumulated data, not a vendor's cloud.

---

## Why it beats Playwright + LLM

| Aspect | Playwright + LLM | Logica Pilot |
|--------|------------------|--------------|
| **LLM perception** | Raw HTML or full screenshot (thousands of tokens, brittle) | Compact indexed map: `[0] button "Buy"` (5–185× fewer tokens, measured) |
| **How it acts** | Fragile CSS selectors or pixel coordinates | By index / intention: `"click [0]"` (resilient to layout changes) |
| **Multi-page parallelism** | You orchestrate manually | Native `fanout` (N pages in parallel + synthesis) |
| **Integration** | Library-only | CLI + MCP + programmatic API |
| **Login persistence** | Re-login per script | `session` tool (log in once, reuse cookies) |
| **Engine** | Puppeteer/Playwright deps | Zero-dep pure CDP over `--remote-debugging-pipe` |
| **Vision fallback** | Screenshot alone | Screenshot with indexed marks drawn (semantic) |
| **AI brain flexibility** | Your LLM, hardcoded | Any API (Anthropic, local proxy, custom) |

---

## Real-World Benchmark

Three tasks — **easy, medium, hard** — run live against real websites with the Logica
Pilot CLI, then compared against the raw HTML a straightforward Playwright agent feeds
the LLM to perceive the same pages.

<p align="center">
  <img src="docs/assets/token-comparison.svg" alt="Perception tokens: Logica Pilot vs Playwright + LLM" width="760">
</p>

> **Methodology (honest & reproducible).** *Logica Pilot* = the tokens of `observe` (an
> indexed element map) or `read` (a bounded clean-text extract). *Playwright + LLM* =
> `page.content()` raw HTML, the common baseline for "let the model see the page". Tokens =
> `characters ÷ 4` (standard GPT approximation — no tokenizer was installed), applied
> identically to both sides and *conservative*, since dense HTML tokenizes higher. Cost uses
> Claude Sonnet input at **$3 / M tokens**. We compare *perception* tokens — the input the
> model reads on every step, which dominates browser-agent cost. Measured, not estimated.

| Task | Logica Pilot | Playwright + LLM (raw HTML) | Gain |
|------|-------------:|----------------------------:|-----:|
| **Easy** · top stories, lean site — `observe` Hacker News | **1,833 tok** · $0.0055 | 8,688 tok · $0.0261 | **4.7×** |
| **Medium** · read a content page — `read` Wikipedia "Coffee" | **901 tok** · $0.0027 | 166,683 tok · $0.500 | **185×** |
| **Hard** · 4-source research — `read` Coffee + Espresso + Caffeine + Production | **3,609 tok** · $0.0108 | 603,365 tok · $1.810 | **167×** |

**Reproduce it — the numbers above came from exactly these commands:**

```bash
logica-pilot observe https://news.ycombinator.com          # easy
logica-pilot read "https://en.wikipedia.org/wiki/Coffee"    # medium
# hard: read the 4 sources, size the HTML baseline with `curl -sL <url> | wc -c`
```

**At scale:** 1,000 four-source research tasks cost **~$11** in perception tokens with
Logica Pilot vs **~$1,810** feeding raw HTML to the same model — a **$1,799 / month** delta
on a single task type.

### Why the gap is real

1. **Perception beats the DOM.** `observe` returns only interactive elements as an indexed
   map; `read` returns a bounded clean-text extract (nav, ads and scripts stripped). A
   Wikipedia article is **600 KB – 1.2 MB** of HTML (~166 K–300 K tokens) — Logica Pilot
   renders the same page as **~900 tokens** of exactly what the model needs.
2. **The gain scales with page weight.** A lean site (Hacker News, 35 KB HTML) is ~5×;
   content-heavy pages (Wikipedia) are 100–185×. Real sites loaded with trackers and
   frameworks sit in between — always in Logica Pilot's favour.
3. **Multi-page compounds it.** `fanout` / `research` extract N pages in parallel and
   synthesize once, so the hard task's four sources total ~3.6 K tokens instead of 600 K
   of raw HTML.
4. **Bounded by design.** Every perception is size-capped, so one runaway page can't blow
   the context window — unlike dumping `page.content()`.

> **Honest caveat:** a hand-tuned Playwright setup *could* run Readability and clean the
> HTML too — but that's exactly the work Logica Pilot does for you, by default, on every
> page. The baseline here is what a straightforward Playwright + LLM agent actually sends.

### Real captured output (live run)

`logica-pilot observe https://news.ycombinator.com` — the indexed map already carries the
scores, so the model answers "what are the top stories?" from ~1.8 K tokens instead of
35 KB of HTML:

```
1574 points · kirushik        · 450 comments
 974 points · marinesebastian · 550 comments
 429 points · Pragmata        · 207 comments
 122 points · reconnecting    ·  17 comments
```

### The autonomous loop is token-efficient too

The benchmark above measures a *single* observation. An autonomous run makes 10–25 of them,
and a naïve agent re-sends its whole history every step — so input cost grows **quadratically**.
Logica Pilot's loop is built so it grows roughly **linearly**:

- **Prompt caching** — the static system + tools prefix and the whole prior conversation are
  marked with `cache_control`, so every step after the first *reads* them at ~0.1× instead of
  re-paying full price. (Verified end-to-end: `usage.cache_read_input_tokens` climbs step over step.)
- **Stale-map pruning** — once you leave a page its element map is dead weight (indices are
  reassigned on every snapshot), so old maps are stubbed to a one-line pointer while the action
  trace is kept intact. This keeps the request small *and* — measured — cheaper than caching alone.
- **Slimmer perception** — shorter element lines (truncated hrefs, a `~` below-fold marker,
  collapsed citation refs, no indentation): **~26% fewer characters per map** with no loss of
  what the model acts on.

**Measured live** on a 10-step Hacker-News run (identical transcript, old loop vs new, token
accounting read back from the model's own `usage`, Sonnet input at $3/M):

| | Full-price input tok | Effective input cost / run |
|---|---:|---:|
| **Old loop** (no cache, full history every step) | ~161,000 | **$0.49** |
| **New loop** (cache + prune + slim) | ~30 | **$0.11** |

**≈77% lower input cost per run** — and the longer the task, the wider the gap (the old loop is
quadratic, the new one linear). This stacks on top of the per-observation savings above.

## The Token-Efficiency Advantage

Instead of sending thousands of tokens of raw HTML or a full screenshot to the LLM:

```html
<html>
  <body>
    <div class="navbar">
      <a href="/">Home</a>
      <a href="/products">Products</a>
      <button onclick="...">Search</button>
      <!-- 2000+ tokens of CSS, scripts, ads… -->
    </div>
    <!-- ... -->
  </body>
</html>
```

**Logica Pilot injects semantic perception and returns:**

```
Page: example.com | Scroll: 0 / 2840px
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[0]  link      "Home"                    href=/
[1]  link      "Products"                href=/products
[2]  button    "Search"                  ph="Find anything"
[3]  textbox   ""                        ph="Find anything"
[4]  link      "Settings"
[5]  link      "Sign in"
───────────────────────────────────────────────────────────────
Page text (readable, ads stripped):
  Welcome to example.com
  The best way to find what you need…
```

**Result:** ~100 tokens instead of 2,000. The AI acts by **index** (`"type 'iPhone' in [3]"`) — no selector breakage, no brittle pixel math.

When the page is opaque (canvas, maps, 3D), it falls back to **screenshot with indexed marks** drawn on the page itself (visual semantics).

---

## Quick Start

### Desktop Browser (Real Window)

```bash
npm install
npm run browser
```

Opens a full-featured browser window with tabs, bookmarks, history, downloads, extensions, login persistence, and a **Pilot** copilot panel (⌘K / Ctrl+K).

**Install browser extension:** Click the 🧩 icon in the toolbar → *Install from folder* (unpacked `manifest.json`).

### Headless / CLI (for Agents & Scripts)

```bash
# Single goal (autonomous loop)
logica-pilot run "find the MASP museum hours" --vision

# Snapshot a page (indexed map)
logica-pilot navigate https://example.com

# Read page (clean text)
logica-pilot read https://example.com --summarize

# Extract structured data (JSON)
logica-pilot extract https://example.com --task "product name, price, rating"

# Multi-agent (parallel pages + synthesis)
logica-pilot fanout --urls shop1.com,shop2.com,shop3.com \
  --task "extract: name, price, stock" \
  --synthesize "rank by best value"

# Deep research (search + multi-agent + cited synthesis)
logica-pilot research "best web framework for 2024"

# Compare products / stores
logica-pilot compare --urls amazon.com,newegg.com,bestbuy.com \
  --task "RTX 4090: price, specs, shipping"

# Best deal (price + shipping across stores)
logica-pilot deal "iPhone 15 Pro 256GB"

# Fact-check a claim
logica-pilot factcheck "coffee is bad for health"

# Web search
logica-pilot search "best laptop under $1000"
```

### Programmatic API

```js
const { LogicaPilot } = require('logica-pilot');

const pilot = await new LogicaPilot({ headless: true }).launch();

// Autonomous loop
const res = await pilot.run('compare iPhone 15 and Samsung S24 prices on 3 stores');
console.log(res.result);  // Fully cited answer

// Step-by-step (manual control)
await pilot.goto('https://example.com');
const snapshot = await pilot.snapshot();
console.log(pilot.format(snapshot));  // Indexed map

// Low-level actions (no AI)
await pilot.actions.click(2);          // Click element [2]
await pilot.actions.type(3, 'query');  // Type in element [3]
await pilot.actions.press('Enter');

await pilot.close();
```

---

## MCP Server (Claude Desktop, Cursor, Cline, etc.)

Logica Pilot exposes **39 tools** as a Model Context Protocol (MCP) server. Any agent can drive a browser token-efficiently and in parallel. CLI and MCP surfaces share **the same registry** — identical tools, defined once.

### Configuration

Add to `claude_desktop_config.json` (or your MCP client config):

```jsonc
{
  "mcpServers": {
    "logica-pilot": {
      "command": "logica-pilot",
      "args": ["mcp"]
    }
  }
}
```

Then set your AI credentials (one time):
- Run `logica-pilot browser` → Settings → enter your **Anthropic API key** (`sk-ant-…`), *or*
- Export `ANTHROPIC_API_KEY=sk-ant-…`, *or*
- Run a local LogicaProxy (`:8317`)

### The 39 Tools (Grouped by Function)

#### Navigation (5 tools)
| Tool | Purpose |
|------|---------|
| **navigate** | Go to URL; return the indexed map of interactive elements |
| **back** | History back; return page map |
| **forward** | History forward; return page map |
| **reload** | Reload the page and return the map |
| **wait** | Wait for text/selector/condition (semantic, no brittle sleeps) |

#### Perception (9 tools)
| Tool | Purpose |
|------|---------|
| **observe** | Get the indexed map of the current page (semantic elements + readable text) |
| **read** | Readable page content — `markdown:true` for **LLM-ready Markdown** (headings/links/tables); paginate with `maxChars`/`offset`; `maxAge` local cache; optional AI summary |
| **extract** | Extract structured data (JSON schema or natural language instruction) |
| **meta** | Page metadata, **deterministic** (no AI): title/description/canonical/favicon, OpenGraph/Twitter, JSON-LD types |
| **images** | All meaningful images (url + alt + size), og:image first, icons skipped — deterministic |
| **product** | **Deterministic product data** from the page's own JSON-LD/microdata/og:price: name, brand, price, availability, rating — fails closed, never guesses |
| **media** | Discover video/audio/direct files/embeds on the page; `download:true` saves direct files to disk (size-capped) |
| **links** | Return all links (text + url), deduped, compact |
| **screenshot** | Capture page; `marks:true` draws indices as visual fallback |

#### Actions (6 tools)
| Tool | Purpose |
|------|---------|
| **act** | Act by index: `click` / `type` / `press` / `scroll` (no selectors, no coordinates) |
| **fill** | Fill multiple form fields at once by index (Form Autopilot) |
| **select** | Select an option in a `<select>` dropdown by index + value |
| **hover** | Hover over an element by index (reveals menus/tooltips) |
| **eval** | Run JavaScript in the page (power tool for devs) |
| **pdf** | Save the current page as PDF |

#### Autonomy (1 tool)
| Tool | Purpose |
|------|---------|
| **run** | Execute a multi-step objective autonomously (observe→decide→act loop) |

#### Session, Memory & Monitoring (5 tools)
| Tool | Purpose |
|------|---------|
| **session** | Manage login sessions (cookies): `save` / `load` / `list` — log in once, reuse forever |
| **memory** | Show what Logica Pilot has **learned** per site (the flywheel): visits, hot elements, recipes |
| **watch** | **Change tracking**: `changeStatus` new/same/changed vs the last snapshot (persisted across sessions), git-style diff of what changed, `tag` for separate histories, `webhook` on change |
| **monitor** | **Scheduled monitors + alerts**: `add` a URL with a cadence + `notify` (telegram/webhook/desktop); a background daemon checks due ones and alerts only on real changes |
| **runs** | **Flight recorder**: browse past autonomous runs — each `run` is saved with steps, token usage and screenshots as a self-contained HTML report |

#### Site (5 tools)
| Tool | Purpose |
|------|---------|
| **map** | **Discover a site's URLs instantly** — robots.txt sitemaps + sitemap.xml (recursive), on-page links fallback; `search` filter |
| **crawl** | **Crawl a whole site/section** breadth-first in parallel: `includePaths`/`excludePaths` regex, `maxDepth`, page limit, robots.txt politeness — compact `{url,title,text}` per page |
| **dataset** | **Living datasets**: scrape/gather output → named local table with dedupe, per-run diff and CSV/JSON export (a free price/stock time series with `monitor`) |
| **batch** | **Async jobs**: start a fanout/crawl in the background (detached, survives the call), then `status`/`get` the results later |
| **llmstxt** | **Generate an llms.txt** for any site: map → read key pages in parallel → standard llms.txt with curated links |

#### Multi-Agent Recipes (8 tools)
| Tool | Purpose |
|------|---------|
| **fanout** | Run the same task on N URLs in **parallel** (separate headless pages) + optional synthesis |
| **search** | Search the web; `content:true` also **reads the top results in parallel** and attaches their text. Bing default; Brave if `BRAVE_SEARCH_API_KEY` |
| **gather** | **Schema in, JSON out**: finds sources (or takes your urls), extracts from each in parallel and **merges into one validated JSON** + sources list |
| **ask** | Ask a question: with `url`, answers **grounded in that page** (quotes the passage); without, searches + reads sources + answers with citations `[n]` |
| **research** | Deep Research: search + read sources in parallel + synthesize with citations `[n]` |
| **compare** | Compare: extract from N URLs in parallel + synthesize comparison table + recommendation |
| **deal** | Best Deal: search stores → extract price/shipping in parallel → rank by total cost |
| **factcheck** | Fact-Check: search independent sources + synthesize verdict with citations |

**Example (Claude asking Pilot to compare products):**

```
User: "Find the cheapest RTX 4090 and tell me where and why."

Claude (via MCP):
1. search("RTX 4090 price buy") → [store URLs]
2. fanout(urls, task: "extract: name, price, shipping, store")
3. Synthesizes → "Best deal: Amazon ($XXX + free shipping)…"
```

---

## Multi-Agent Recipes (Token-Efficient Patterns)

The core Logica Pilot engine powers **4 killer recipes** — each pairs search + fanout + smart synthesis:

### Deep Research 🧠

```bash
logica-pilot research "what is Logica Pilot?"
```

1. Searches the web for results.
2. Reads all sources **in parallel** (multi-agent, token-cheap).
3. Synthesizes a complete, **cited answer** with `[1]`, `[2]`, etc. pointing to sources.

### Best Deal 🧠

```bash
logica-pilot deal "MacBook Pro 16GB 512GB"
```

1. Searches for stores selling the product.
2. Extracts **price + shipping + availability** from each (parallel).
3. Ranks by **total cost** and recommends the best.

### Fact-Check ✓

```bash
logica-pilot factcheck "is coffee bad for your heart?"
```

1. Searches for independent sources.
2. Extracts each source's **position & evidence** (parallel).
3. Synthesizes a **verdict** (true / false / misleading / inconclusive) **with citations**.

### Compare 📊

```bash
logica-pilot compare --urls amazon.com,newegg.com,bestbuy.com \
  --task "RTX 4090: name, price, specs, shipping"
```

1. Extracts the same fields from each URL (parallel).
2. Builds a **comparison table** with recommendation.

All recipes are **MCP tools** too — call them directly from Claude or any agent.

---

## Desktop Browser Features

<p align="center">
  <img src="docs/media/screenshot-home.png" alt="Logica Pilot new-tab page" width="65%">
  &nbsp;
  <img src="docs/media/screenshot-adblock.png" alt="Native ad-block panel — blocked count and per-site allow" width="30%">
</p>

The Logica Pilot browser window (real browser engine) includes:

- **Tabs** — favicon, audio indicator, loading spinner, tab reopen (⌘⇧T), pinning, numbered shortcuts (⌘1–9)
- **Omnibox** — address bar with search suggestions (history + web search), security lock, progress bar
- **⭐ Bookmarks** — star button, bookmark bar (⌘⇧B), manager
- **🆕 New Tab** — top sites, news feed (customizable)
- **🕘 History** — full browsing history (⌘Y)
- **⬇️ Downloads** — download manager (⌘⇧J)
- **📄 PDF viewer** — native PDF rendering
- **📖 Reader mode** — clean article layout (⌥⌘R)
- **🌐 Translation** — built-in page translation (100+ languages)
- **🔎 Find** — in-page search (⌘F)
- **🔍 Zoom** — page zoom (⌘ +/−/0)
- **🖨️ Print** — native print dialog (⌘P)
- **🔐 Permissions** — camera, microphone, location, notifications (persistent)
- **🕵️ Incognito** — private browsing (⌘⇧N), isolated from main session
- **🧩 Extensions** — install from Web Store or local folder; full content script support
- **🌍 UI in 12 languages** — PT-BR, EN, ES, FR, DE, IT, NL, PL, RU, JA, KO, ZH (auto-detected)
- **⌘K Pilot Panel** — enter a goal, watch the AI navigate your page autonomously

---

## Architecture

```
        ┌──────────── LOGICA PILOT ENGINE ───────────────────┐
        │ Semantic perception (a11y tree + vision fallback)   │
        │ Intent-based actions (click/type/scroll by index)   │
        │ Autonomous loop (Claude brain, token-efficient)     │
        └────────┬────────────────────────────────┬───────────┘
    CDP via pipe │                                │ CDP via webContents.debugger
                 ▼                                ▼
    ┌────────────────────────────┐   ┌──────────────────────────────────┐
    │ HEADLESS MODE              │   │ DESKTOP BROWSER                  │
    │ For agents, scripts, APIs  │   │ Real browser window              │
    │ $ logica-pilot run "..."   │   │ Tabs, omnibox, bookmarks, login  │
    │ Fast & cheap               │   │ Full parity + AI copilot         │
    └────────────────────────────┘   └──────────────────────────────────┘
```

- **Single engine:** the same motor drives both headless agents and the live browser window
- **Two shells:** headless CDP-over-pipe for agents/scripts; browser UI for interactive use
- **Zero external deps:** pure Node.js + Electron (which bundles the browser engine)

### How It Works (Under the Hood)

1. **Pure CDP over pipe:** Launch the browser with `--remote-debugging-pipe` (file descriptors 3/4). Zero syscalls, zero JSON parsing overhead. Works identically on headless and desktop (webContents.debugger is the same protocol).

2. **Semantic perception:** Inject JavaScript that walks the DOM, indexes interactive elements (`<button>`, `<a>`, `<input>`, ARIA roles), extracts labels (aria-label, placeholder, text content, alt), and returns a compact structure. Fallback to screenshot with marks.

3. **Intent-based action:** Instead of `"click at coordinates (420, 240)"`, the AI says `"click [5]"` — much cheaper, never breaks on layout changes.

4. **Autonomous loop:** Given a goal, the agent repeatedly observes (perception), decides (LLM), and acts (actions). Stops when the goal is met or max steps reached.

5. **Multi-agent orchestration** (`fanout`): Spawn N headless pages in parallel (each with its own CDP pipe), run the same task on each (extract / read / run), collect results, and optionally synthesize via the LLM. Wall time is `time_per_page / N`.

---

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `ANTHROPIC_API_KEY` | — | Anthropic API key (if calling the API directly instead of LogicaProxy) |
| `LOGICA_PILOT_LLM_URL` | `http://127.0.0.1:8317/v1/messages` | LogicaProxy endpoint (or your custom LLM API) |
| `LOGICA_PILOT_MODEL` | `claude-sonnet-4-6` | Model name (or whatever your proxy supports) |
| `LOGICA_PILOT_BROWSER` / `CHROME_PATH` | auto-discover | Path to browser binary (auto-finds the browser on macOS/Windows/Linux) |
| `BRAVE_SEARCH_API_KEY` | — | Brave Search API key (for high-reliability web search; fallback is Bing) |
| `LOGICA_PILOT_DEBUG` | — | Set to enable CDP debug logs |
| `LOGICA_PILOT_HEADFUL` | — | Set to `1` to keep MCP browser headful (window visible) |
| `LOGICA_PILOT_SMOKE` | — | Run self-test (browser + CDP) and exit |
| `LOGICA_PILOT_PROXY` | — | Bring-your-own proxy for every headless page (falls back to `HTTPS_PROXY`/`HTTP_PROXY`) |
| `LOGICA_PILOT_LOCATION` | — | Country code (`BR`, `US`, …) — emulates timezone, locale and `Accept-Language` |

### Bring your own proxy & location

Every headless surface (`crawl`, `fanout`, `gather`, recipes) accepts a proxy — via env or the
per-call `proxy` parameter. Credentials are answered through CDP (`Fetch.authRequired`), so the
standard `user:pass@host:port` format of every major provider just works:

```bash
# Webshare
export LOGICA_PILOT_PROXY="http://user-rotate:pass@p.webshare.io:80"
# Bright Data / Oxylabs / Smartproxy / IPRoyal — same shape
export LOGICA_PILOT_PROXY="http://customer-USER:PASS@brd.superproxy.io:22225"

# Location emulation (timezone + locale + Accept-Language), no proxy needed:
export LOGICA_PILOT_LOCATION=BR
# or per call: logica-pilot crawl site.com --location '{"country":"US","languages":["en-US"]}'
```

> Proven live: the 407 auth challenge is answered via CDP and pages load through the tunnel;
> with `location: BR` the page sees `America/Sao_Paulo` and `pt-BR`.

**PII redaction** (deterministic, local, free): `read --redactPII` / `crawl --redactPII` masks
emails, phones, CPF/CNPJ, credit cards (Luhn-validated) and IPs **before** the text reaches any
model — `[email]`, `[phone]`, `[cpf]`, `[card]`, `[ip]`.

### AI Brain Options

**Option 1: Anthropic API (direct)**
```bash
export ANTHROPIC_API_KEY=sk-ant-…
logica-pilot run "your goal"
```

**Option 2: LogicaProxy (local, ~1ms latency)**
```bash
# In another terminal, run LogicaProxy or your custom LLM API on :8317
# Logica Pilot defaults to it; automatic fallback to Anthropic API if down.
logica-pilot run "your goal"
```

**Option 3: Custom LLM API**
```bash
export LOGICA_PILOT_LLM_URL=https://your-api.com/v1/messages
export LOGICA_PILOT_MODEL=gpt-4-turbo  # or whatever
logica-pilot run "your goal"
```

---

## Project Structure

```
src/
  index.js              Public API (LogicaPilot class)
  cdp-pipe.js           Pure CDP over pipe (zero deps)
  browser.js            Launch browser, manage pages/sessions
  perception.js         Semantic indexing (a11y tree) + visual marks
  actions.js            Click/type/scroll/press by index (real DOM events)
  llm.js                Brain (Messages API via LogicaProxy or Anthropic)
  agent.js              Autonomous loop (perceive → decide → act)
  electron-page.js      Adapter: webContents.debugger → page contract
  mcp-server.js         MCP server (stdio, 39 tools)
  tools.js              SINGLE REGISTRY (CLI + MCP share this)
  fanout.js             Parallel multi-agent orchestration
  search.js             Web search (Bing default, Brave if key set)
  recipes.js            research / compare / deal / factcheck
  session-store.js      Cookie persistence (session tool)

bin/
  logica-pilot.js       CLI entry point

app/
  main.js               Electron main process
  preload.js           IPC sandbox bridge
  renderer/             UI
    newtab/             New Tab (top sites, news)
    history/            History manager
    downloads/          Downloads manager
    settings/           Preferences (theme, AI key, search engine)
    bookmarks/          Bookmark manager
    omnibox/            Address bar + suggestions
```

---

## Requirements

- **Node.js:** >=18
- **Browser engine:** auto-discovered (real browser; supported on macOS, Windows, Linux)
- **Electron:** downloaded on first `npm install` (~150 MB)

---

## LogicaOS Integration

Logica Pilot is exposed as the **`pilot` skill** in the Rovemark LogicaOS suite. Agents and scripts call:

```js
const pilot = require('./skills/pilot');
const res = await pilot.run('your goal');
const snap = await pilot.snapshot(url);
const data = await pilot.extract(url, 'instruction');
```

---

## License

GPL-3.0-or-later

---

## Made With

- **Browser engine** — the real browser (Electron bundles it)
- **CDP** — low-level browser control
- **Node.js** — single codebase, all platforms
- **Electron** — desktop shell + web APIs
- **Claude** (Anthropic) — the AI brain

<div align="center">

**Rovemark** · AI Infrastructure · [rovemark.com](https://rovemark.com)

Made for the Architect. Open source. Zero compromises.

</div>
