# Logica Pilot — MCP & CLI Guide

**The token-efficient browser automation engine.** Exposed as a single tool registry accessible via **CLI**, **MCP (Model Context Protocol)**, or **programmatic API**. Same 80 tools, three surfaces — zero duplication.

---

## Why Logica Pilot Beats Playwright + LLM

| Aspect | Playwright + LLM | Logica Pilot |
|--------|------------------|-------------|
| **Perception** | Raw HTML / full screenshot (2000–5000 tokens) | Compact indexed map: `[0] button "Buy"` (100–300 tokens) |
| **Actions** | Fragile CSS selectors / pixel coordinates | **By index & intent** — resilient, deterministic |
| **Parallelism** | Manual orchestration | **Native `fanout`** — N pages in parallel, auto-synthesize |
| **Integration** | Library-only (hardcoded in your app) | **CLI + MCP + API** — any agent plugs in |
| **Sessions** | Re-login per script | **`session` tool** — log in once, reuse cookies forever |
| **Engine** | Puppeteer/Playwright deps + Node bloat | **Zero dependencies** — pure CDP over `--remote-debugging-pipe` |

**Result:** 10–100× fewer tokens. Same semantic understanding. Real actions that don't break on layout changes.

---

## MCP Configuration

Add to your client's MCP config (Claude Desktop, Cursor, Cline, etc.):

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

**One-time setup:** Set your AI credentials:
- Export `ANTHROPIC_API_KEY=sk-ant-…`, *or*
- Run `logica-pilot` → Settings → enter your Anthropic API key, *or*
- Run LogicaProxy locally (`:8317` — works with any LLM API)

The engine auto-discovers an installed real browser (any installed browser).

---

## The 80 Tools — Single Registry

All tools are defined once in `src/tools.js`. Both MCP (stdio) and CLI (subcommands) expose the identical interface. MCP tool names are prefixed with `browser_` (e.g., `browser_navigate`); CLI commands are bare (e.g., `logica-pilot navigate`). Saved **Site Adapters** also appear as their own MCP tools, `x_<name>`.

> **[TOOLS.md](TOOLS.md) is the canonical, complete reference** (every tool, its args, and examples). The summary below groups the 80 tools; see TOOLS.md for detail.

| Group | Tools (`browser_<name>` over MCP · `logica-pilot <name>` on the CLI) |
|-------|------|
| **Navigation** (5) | `navigate` · `back` · `forward` · `reload` · `wait` (semantic) |
| **Perception** (14) | `observe` · `read` (markdown/cache/redactPII/`engine:http`·`adaptive`) · `extract` · `meta` · `images` · `product` · `apis` (backend API discovery) · `jsdata` (hydration state) · `locate` (value→path) · `video` · `media` · `links` · `handoff` · `screenshot` |
| **Actions** (12) | `act` · `fill` · `select` · `hover` · `eval` · `pdf` · `upload` · `dialog` · `drag` · `storage` · `permission` · `evalbatch` |
| **Autonomy** (3) | `run` (autonomous loop + flight recorder + self-repair) · `adapter` (site→named tool `x_<name>`) · `workflow` (deterministic replay by label) |
| **Site** (8) | `map` · `crawl` (BFS) · `crawler` (Crawlee-style: queue+pageFunction+dataset+resume) · `actor` (manifest+INPUT schema) · `index` (BM25 offline) · `dataset` · `batch` · `llmstxt` |
| **Multi-Agent** (8) | `fanout` · `search` (`content:true` reads results) · `gather` (schema in, JSON out) · `ask` · `research` · `compare` · `deal` · `factcheck` |
| **Session & Monitoring** (6) | `session` · `persist` (CF-clearance) · `memory` · `watch` · `monitor` · `runs` |
| **Browser Control** (13) | `stealth` · `fingerprint` (realistic+webrtc) · `sessions` (rotating pool) · `device` · `geo` · `tabs` · `wipe` · `health` · `html` · `fast` · `feedback` · `window` · `captcha` |
| **Network** (4) | `block` · `throttle` · `intercept` (mock/headers) · `proxypool` (named pools + local rotating forwarder) |
| **DevTools & Testing** (2) | `inspect` · `assert` (+ screenshot-diff) |
| **HTTP & Storage** (5) | `fetch` (browserless HTTP) · `queue` (durable RequestQueue) · `kvs` (Key-Value Store) · `webhook` (run-lifecycle) · `schedule` (cron) |

**Apify/Crawlee parity** (all local, zero-dep): browserless HTTP tier + adaptive routing, durable RequestQueue + KVS, a **REST API** (`serve` = ScrapingBee/ScraperAPI drop-in), a Crawlee-style `crawler`, realistic fingerprints + rotating `sessions` + local rotating proxy, backend API discovery (`apis`/`jsdata`/`locate`), formal `actor` packaging, `webhook` + `schedule`. Plus **attach to your real browser** (`--attach`), **BYO proxy + geo**, **PII redaction**, **consent-killer**. See [TOOLS.md → Killer capabilities](TOOLS.md#killer-capabilities-what-a-cloud-scraper-cant-do).

---

## CLI Examples

### Single-Page Tools

```bash
# Navigate and see the indexed map
logica-pilot navigate https://example.com

# Observe the current page
logica-pilot observe --url https://example.com

# Read (clean text, no nav/ads)
logica-pilot read https://example.com

# Read + AI summary
logica-pilot read https://example.com --summarize

# Extract structured data (AI-parsed)
logica-pilot extract https://example.com --task "product name, price, rating"

# Extract with JSON schema
logica-pilot extract https://shop.com --schema '{"type":"object","properties":{"price":{"type":"number"},"inStock":{"type":"boolean"}}}'

# Get all links
logica-pilot links https://example.com

# Screenshot with indexed marks drawn
logica-pilot screenshot https://example.com --marks

# Save as PDF
logica-pilot pdf https://example.com --out ~/Downloads/page.pdf

# Act by index (click, type, scroll)
logica-pilot act --action click --index 2
logica-pilot act --action type --index 3 --text "search term" --submit
logica-pilot act --action scroll --direction down --amount 600
logica-pilot act --action press --key Enter

# Fill multiple fields at once
logica-pilot fill --fields '[{"index":1,"text":"John"},{"index":2,"text":"john@example.com","submit":true}]'

# Hover (reveals menus)
logica-pilot hover --index 5

# Run arbitrary JavaScript
logica-pilot eval --expression "document.title"
```

### Autonomous Goals

```bash
# AI navigates on its own (observe → decide → act loop)
logica-pilot run "find the store hours for MASP museum"
logica-pilot run "compare prices for RTX 4090 on 3 stores" --max-steps 15
logica-pilot run "add iPhone 15 Pro to cart and checkout" --url https://apple.com
```

### Sessions (Login Persistence)

```bash
# Log in manually, then save the session
logica-pilot navigate https://gmail.com     # → log in manually
logica-pilot session --action save --name gmail

# Later, reuse the same login (no re-auth)
logica-pilot run "find unread emails" --session gmail
# or: logica-pilot session --action load --name gmail
# then: logica-pilot observe

# List all saved sessions
logica-pilot session --action list
```

### Multi-Page & Research (Multi-Agent)

```bash
# Fanout across 3 URLs in parallel
logica-pilot fanout --urls amazon.com,bestbuy.com,newegg.com \
  --task "find RTX 4090: name, price, availability"

# Fanout + synthesize into a ranked comparison
logica-pilot fanout --urls amazon.com,bestbuy.com,newegg.com \
  --task "extract: name, price, shipping, warranty" \
  --synthesize "rank by best value (price + shipping)"

# Deep research (search + parallel reads + citations)
logica-pilot research "best web framework for 2024"

# Compare products across stores
logica-pilot compare --urls shop1.com,shop2.com,shop3.com \
  --task "MacBook Pro 16GB: specs, price, shipping"

# Find the best deal (search + parallel extraction + ranking)
logica-pilot deal "iPhone 15 Pro 256GB"

# Fact-check a claim with independent sources
logica-pilot factcheck "coffee is bad for your heart"

# Web search (returns URLs for further processing)
logica-pilot search "best laptop under $1000" --limit 10
```

### Monitoring & Change Detection

```bash
# Check if a URL has changed since last check
logica-pilot watch https://example.com/product

# Use in a loop to monitor price
while true; do
  logica-pilot watch https://amazon.com/dp/ASIN123
  sleep 3600  # check every hour
done
```

### Desktop Browser

```bash
# Open the real browser (Electron window)
logica-pilot browser

# Open browser to a specific URL
logica-pilot browser --url https://example.com
```

### Server Mode

```bash
# Start the MCP server (stdio transport)
logica-pilot mcp
```

---

## Programmatic API (Node.js)

```javascript
const { LogicaPilot } = require('logica-pilot');

// Launch
const pilot = await new LogicaPilot({ headless: true }).launch();

// Navigate and observe
await pilot.goto('https://example.com');
const map = await pilot.snapshot();
console.log(pilot.format(map));  // Indexed map

// Extract data
const data = await pilot.extract('find the price and rating');

// Autonomous goal
const result = await pilot.run('find the cheapest RTX 4090 and tell me the store');
console.log(result.result);  // Fully cited answer

// Act by index (no AI)
await pilot.actions.click(2);           // Click element [2]
await pilot.actions.type(3, 'query');   // Type in element [3]
await pilot.actions.press('Enter');     // Press Enter
await pilot.actions.scroll('down', 600);  // Scroll down 600px

// Fanout (parallel multi-agent)
const results = await pilot.fanout({
  urls: ['amazon.com', 'bestbuy.com', 'newegg.com'],
  task: 'extract: name, price, shipping',
  synthesize: 'rank by best value'
});
console.log(results.synthesis);

// Sessions (login persistence)
await pilot.session('save', 'gmail');  // Save cookies
await pilot.session('load', 'gmail');  // Reuse cookies

// Clean up
await pilot.close();
```

---

## Multi-Agent Recipes: The Killer Features

These combine **search + fanout + synthesis** into high-level cognitive tasks. Callable via CLI, MCP, or API:

### `research` — Deep Research

Searches a question, reads all sources **in parallel** (multi-agent), synthesizes a cited answer.

```bash
logica-pilot research "what are the best web frameworks for building REST APIs?"
```

**Returns:**
```
[1] According to the MDN documentation, Express.js is one of the most popular...
[2] Fastify claims to be the fastest JSON server framework...
[3] NestJS provides a full-featured framework with TypeScript support...

Best choice for most teams: Express.js (mature, large ecosystem) or Fastify (performance).
```

### `compare` — Comparison Table

Fanout across multiple URLs, extract specs/prices, synthesize a ranked comparison.

```bash
logica-pilot compare --urls amazon.com,bestbuy.com,newegg.com \
  --task "MacBook Pro 16GB 512GB: price, shipping, warranty"
```

**Returns:**
```
| Store    | Price  | Shipping | Warranty | Total  | Rating |
|----------|--------|----------|----------|--------|--------|
| Amazon   | $2499  | Free     | 1 yr     | $2499  | ★★★★★  |
| Best Buy | $2549  | $19.99   | 1 yr     | $2568  | ★★★★   |
| Newegg   | $2599  | Free     | 2 yr     | $2599  | ★★★★★  |

Recommendation: Amazon (best price + free shipping + 5-star reviews).
```

### `deal` — Best Deal

Searches for a product, extracts price + shipping across vendors, ranks by **total cost**.

```bash
logica-pilot deal "iPhone 15 Pro 256GB"
```

**Returns:**
```
Searched: "iPhone 15 Pro 256GB" — found 8 retailers.

1. Amazon: $999 + Free Shipping = $999 (✓ in stock, 2-day Prime)
2. Apple Store: $999 + $10 Shipping = $1009 (✓ in stock, 1-day)
3. Best Buy: $999 + $29.99 Shipping = $1028.99 (⧖ backorder 5–7 days)

Best deal: Amazon ($999 total, fastest delivery).
```

### `factcheck` — Fact-Check with Verdict

Searches independent sources, aggregates claims, returns a **cited verdict**.

```bash
logica-pilot factcheck "coffee is bad for your heart"
```

**Returns:**
```
VERDICT: ⚠️ PARTIALLY TRUE

• Coffee consumption (3–5 cups/day) is associated with *reduced* heart disease risk [1][2].
• Excessive intake (>5 cups/day) may cause arrhythmias in susceptible individuals [3].
• The "coffee is bad" myth dates from confounding studies (coffee drinkers also smoked) [4].

Conclusion: Moderate coffee consumption is safe for most adults; excess may cause palpitations in sensitive people.

[1] Journal of the American Heart Association (2021)
[2] Harvard T.H. Chan School of Public Health
[3] American Heart Association Study (2017)
[4] Cochrane Review, 2020
```

### `search` — Web Search

Returns raw result URLs (title + url) for further processing. Uses Bing by default (0 dependencies); Brave API preferred if `BRAVE_SEARCH_API_KEY` set.

```bash
logica-pilot search "best laptop under $1000" --limit 10
```

**Returns:**
```json
[
  { "title": "Best Laptops Under $1000 (2024 Guide)", "url": "https://techreview.com/..." },
  { "title": "Top 5 Budget Laptops - PC World", "url": "https://pcworld.com/..." },
  { "title": "Affordable Laptops with Great Performance", "url": "https://example.com/..." }
]
```

---

## Token Efficiency Explained

### The Problem (Playwright + LLM)

1. Take full-page screenshot → 1024×768 JPEG (~50 KB)
2. Encode as base64 → ~100 KB text
3. Send to LLM vision → **2000–5000 tokens consumed**
4. Model clicks at pixel coordinates `(x: 420, y: 240)` → **breaks on layout change**
5. Repeat for every action → 10 actions = 20,000–50,000 tokens per task

### The Logica Pilot Solution

1. Inject JavaScript → walk DOM, **index every interactive element** by role + label
2. Return compact map:
   ```
   [0]  button   "Buy Now"               href=/buy
   [1]  textbox  "Search…"               placeholder="Find products"
   [2]  link     "Contact Us"            href=/contact
   [3]  link     "Shipping Info"         href=/shipping
   ```
3. Model acts by **index**: `"click [0]"` → **10–20 tokens**
4. Fallback to **vision** (screenshot with indices drawn as badges) for opaque canvas/3D maps
5. Result: **100 tokens instead of 2000+**, deterministic, layout-resilient

**Multi-agent amplification:** With `fanout`, run the same task on N pages in parallel. Total wall time is `time_per_page / N`, but token cost per page is the same. So 10 parallel pages = 10 `logica-pilot` calls, each saving 10–100× tokens.

---

## Zero Dependencies

- **Engine:** Pure Node.js + CDP over `--remote-debugging-pipe` (file descriptors 3/4)
- **Browser:** Auto-discovers installed real browser (any installed browser)
- **Desktop:** Electron (ships with real browser engine)
- **No Playwright.** No Puppeteer. No bloat.

The engine works identically on:
- Headless (agents, scripts): CDP over pipe from `--remote-debugging-pipe` flags
- Electron (desktop app): CDP via `webContents.debugger`
- Remote (SSH, Tailscale): CDP over WebSocket if configured

---

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `ANTHROPIC_API_KEY` | — | Anthropic API key (direct calls if LogicaProxy unavailable) |
| `LOGICA_PILOT_LLM_URL` | `http://127.0.0.1:8317/v1/messages` | LogicaProxy endpoint (local brain) or custom LLM API |
| `LOGICA_PILOT_MODEL` | `claude-sonnet-4-6` | Model ID |
| `LOGICA_PILOT_BROWSER` / `CHROME_PATH` | auto-detect | Path to real browser binary |
| `BRAVE_SEARCH_API_KEY` | — | High-reliability web search (Brave API; fallback is Bing) |
| `LOGICA_PILOT_HEADFUL` | — | Set to `1` to launch MCP browser in headful mode (window visible) |
| `LOGICA_PILOT_DEBUG` | — | Verbose CDP logs to stderr |
| `LOGICA_PILOT_SMOKE` | — | Run self-test (engine + Electron) and exit |

---

## How It Works (The Engine)

### Two Shells, One Motor

```
        ┌─────────────── LOGICA PILOT ENGINE ───────────────┐
        │ • Semantic perception (DOM indexing + vision)      │
        │ • Intent-based actions (by index, not selectors)   │
        │ • Autonomous loop (LLM brain, token-efficient)     │
        └──────────────┬──────────────────────┬──────────────┘
     CDP via pipe      │                      │  CDP via webContents.debugger
                       ▼                      ▼
      ┌─────────────────────────┐  ┌──────────────────────────┐
      │ HEADLESS MODE           │  │ DESKTOP BROWSER (Electron) │
      │ • For agents & scripts  │  │ • Real window              │
      │ • Fast & cheap          │  │ • Tabs, omnibox, bookmarks │
      │ • `logica-pilot run ...`│  │ • AI copilot panel (⌘K)    │
      │ • Zero latency          │  │ • Full browser parity       │
      └─────────────────────────┘  └──────────────────────────┘
```

### The Perception Loop

1. **Inject indexing JavaScript** — walks the DOM, tags every interactive element (`<button>`, `<a>`, `<input>`, ARIA roles) with a unique data attribute
2. **Extract labels** — aria-label, placeholder, text content, alt text (prefer semantic hints)
3. **Build compact map** — `[0] button "Buy"`, `[1] textbox "Email"`, etc.
4. **Fallback to vision** — if the page is opaque (canvas, 3D, WebGL), take a screenshot and draw index badges on top

### The Action Model

- **No CSS selectors.** No pixel coordinates. No brittle.
- **Act by index:** `click [5]`, `type [3] "query"`, `press Enter`, `scroll down 600`
- **DOM events:** Simulate realistic user input (not synthetic manipulation)

### The Autonomous Loop

Given a goal (e.g., "find the cheapest RTX 4090"):

1. **Observe** — return indexed map of current page
2. **Decide** — LLM reads map + goal, plans next action
3. **Act** — execute action, wait for page to settle
4. **Repeat** — until goal is met or max steps reached

Token cost per loop: **~500 tokens** (compact map + decision + action), not 2000–5000 (full screenshot).

---

## Browser Features (Electron Desktop App)

The Logica Pilot **window** is a real browser (Electron = real engine). Features include:

- **Tabs** — favicon, audio indicator, loading spinner, reopen closed (⌘⇧T), numbered shortcuts (⌘1–9)
- **Omnibox** — address bar + search suggestions (history + web search), security lock, progress bar
- ⭐ **Bookmarks** — star button, bookmark bar (⌘⇧B), manager
- 🆕 **New Tab** — top sites, news feed
- 🕘 **History** — full browsing history (⌘Y)
- ⬇️ **Downloads** — download manager (⌘⇧J)
- 📄 **PDF Viewer** — native rendering
- 📖 **Reader Mode** — clean article layout (⌥⌘R)
- 🌐 **Translate** — built-in page translation (100+ languages)
- 🔎 **Find** — in-page search (⌘F)
- 🔍 **Zoom** — page zoom (⌘ +/−/0)
- 🖨️ **Print** — native print dialog (⌘P)
- 🔐 **Permissions** — camera, microphone, location, notifications (persistent)
- 🕵️ **Incognito** — private browsing (⌘⇧N), isolated from main session
- 🧩 **Chrome Extensions** — install from Chrome Web Store or unpacked folder
- 🇵🇹 **UI in 12 Languages** — PT-BR, EN, ES, FR, DE, IT, NL, PL, RU, JA, KO, ZH (auto-detected)
- **⌘K Pilot Panel** — enter a goal, watch the AI navigate your page

---

## Quick Start

### Desktop Browser (Real Window)

```bash
npm install
npm run browser
```

Opens a full-featured real browser. Press ⌘K to open the **Pilot** copilot panel, type an objective, and watch the AI navigate in your session (your logins, cookies, history).

### Headless CLI

```bash
# Snapshot a page (indexed map)
logica-pilot navigate https://example.com

# Autonomous goal
logica-pilot run "find the store hours for MASP museum" --vision
```

### As MCP in Claude Desktop / Cursor

Add the config above, then:

> Use `browser_navigate` to go to Amazon, then `browser_search` for "best laptop 2024", then `browser_fanout` across results and `browser_extract` specs with price, then `browser_compare` to recommend the best value.

---

## Integration with LogicaOS

Exposed as the **`pilot` skill** in LogicaOS suite (replacing the old `playwright` skill):

```javascript
const pilot = require('./skills/pilot');

// Autonomous goal
const res = await pilot.run('find all product reviews and summarize them');

// Snapshot (indexed map)
const snap = await pilot.open('https://example.com');

// Extract structured data
const data = await pilot.extract('https://shop.com', 'price, rating, in_stock');

// Fanout multi-agent
const results = await pilot.fanout({
  urls: ['a.com', 'b.com', 'c.com'],
  task: 'extract: name, price, shipping',
  synthesize: 'rank by value'
});
```

---

## Requirements

- **Node.js:** ≥18
- **Real browser:** auto-discovered (any installed browser)
- **Electron:** downloaded on first `npm install` (~150 MB)

---

## License

GPL-3.0-or-later

---

<div style="text-align: center; margin-top: 3rem; opacity: 0.7;">

**Rovemark · AI Infrastructure · Built for the Architect**

</div>
