# Logica Pilot — MCP & CLI Guide

Logica Pilot is a **pure CDP (Chrome DevTools Protocol) browser automation engine** exposed via **CLI** and **MCP**, designed to **save tokens** with AI. Instead of sending raw HTML or full screenshots to the model, it delivers **compact semantic perception** (indexed map: `[0] button "Buy"`) and acts **by index** — 10–100× fewer tokens. Built-in multi-agent support (`fanout`).

## Why Logica Pilot Beats Playwright + LLM

| Aspect | Playwright + LLM | Logica Pilot |
|---|---|---|
| What the model sees | Raw HTML / full screenshot (thousands of tokens) | Indexed semantic map + readable text (compact) |
| How it acts | Fragile CSS selectors / pixel coordinates | **By index & intention** |
| Parallelism | You orchestrate manually | **Native `fanout`** (N pages in parallel + synthesis) |
| Access | Library only | **CLI + MCP** (any agent plugs in) |
| Sessions | Re-login per script | **`session`** (login once, reuse cookies) |

## MCP Setup — Plug into Claude Desktop / Cursor / Cline

Add this to your MCP configuration:

```jsonc
// claude_desktop_config.json (or your client's mcp.json)
{
  "mcpServers": {
    "logica-pilot": {
      "command": "logica-pilot",
      "args": ["mcp"]
    }
  }
}
```

> Set your AI key once: run `logica-pilot` (opens the browser) → Settings → "AI Key", **or** export `ANTHROPIC_API_KEY`, **or** run LogicaProxy locally (`:8317`).

### The 14 MCP Tools

| Tool | What it does (token-first) |
|---|---|
| `browser_navigate` | Navigate to URL and return the **indexed semantic map** (interactive elements + readable text) |
| `browser_observe` | Get the indexed semantic map of current page (compact perception replacing HTML/screenshot) |
| `browser_act` | Act on page **by index** (from `browser_observe`): `click`, `type`, `press`, `scroll` |
| `browser_extract` | Extract **structured data → JSON** (via instruction/schema) or CSS selector text |
| `browser_read` | **Readable content** (readability) + optional AI summary |
| `browser_run` | Execute a **multi-step autonomous goal** (AI loops observe → act → repeat) |
| `browser_fanout` | **MULTI-AGENT**: run task on N URLs in parallel + optionally synthesize results |
| `browser_search` | Search the web and return result URLs (title + url) |
| `browser_research` | **🧠 Deep Research**: search, read sources in parallel (multi-agent), synthesize with citations |
| `browser_deal` | **🧠 Best Deal**: find product vendors, extract price + shipping in parallel, rank by real value |
| `browser_factcheck` | **🧠 Fact-Check**: search independent sources for claim, return verdict with citations |
| `browser_watch` | Check if URL **changed** since last check (content diff). Base for monitors (price/stock/openings) |
| `browser_session` | Manage login sessions (cookies): `save` / `load` / `list`. Login once, reuse forever |
| `browser_screenshot` | Capture screen (visual fallback when a11y isn't enough). With `marks:true` draws indices on page |

## CLI Commands

```bash
# MCP server (stdio transport)
logica-pilot mcp

# Autonomous loop (AI navigates on its own)
logica-pilot run "<objective>" [--url U] [--headful] [--vision] [--model M] [--max-steps N] [--json]

# Snapshot the page (print indexed map)
logica-pilot open <url>
logica-pilot snapshot <url>          # alias

# Read readable content (with optional summary)
logica-pilot read <url> [--summarize]

# Extract structured data (JSON) from a page
logica-pilot extract <url> --task "product name, price, rating"

# Parallel extraction on multiple URLs
logica-pilot fanout --urls a.com,b.com,c.com --task "..." [--synthesize "..."] [--mode extract|read|run]

# Web search (returns URLs)
logica-pilot search "<query>" [--limit N]

# Multi-agent recipes (search + fanout + tuned synthesis)
logica-pilot research "what's the best web framework in 2024?"       # Deep Research
logica-pilot compare --urls shop1,shop2,shop3 --task "price & specs" # Comparison table
logica-pilot deal "iPhone 15 Pro 256GB"                              # Best price ranked
logica-pilot factcheck "is coffee bad for your health?"              # Verdict with sources

# Open the Electron browser (real window, full Chrome parity)
logica-pilot browser [--url U]

# Show version
logica-pilot version
```

## Multi-Agent Recipes

The "killer features" = `search` + `fanout` + tuned synthesis. Callable directly from CLI **and** as MCP tools:

### `research` — Deep Research
Searches a question, reads all source pages **in parallel** (multi-agent), synthesizes a cited answer.
```bash
logica-pilot research "best framework for building a REST API?"
```
Returns a synthesis with citations like: `[1] According to X... [2] Also mentioned on Y...`

### `compare` — Comparison Table
Fanout across multiple URLs, extracts specs/prices, synthesizes a ranked comparison.
```bash
logica-pilot compare --urls shop1.com,shop2.com,shop3.com --task "price, shipping, warranty"
```

### `deal` — Best Deal
Searches for a product, extracts price + shipping across vendors, ranks by **real value** (price + shipping + return time).
```bash
logica-pilot deal "MacBook Pro 14 2024 1TB"
```

### `factcheck` — Fact-Check with Verdict
Searches independent sources, aggregates claims, returns a cited verdict: **TRUE** / **FALSE** / **PARTIALLY TRUE** / **UNVERIFIABLE**.
```bash
logica-pilot factcheck "humans use only 10% of their brain"
```

### `search` — Web Search URLs
Returns raw result URLs (title + url) for further processing. Uses Bing (0-dep, decodes redirects).  
For high-reliability search, set `BRAVE_SEARCH_API_KEY=<key>` (free tier available).

## Token Efficiency Explained

**The Problem (Playwright + LLM):**
- Take screenshot → 1024×768 JPEG (~50 KB, millions of pixels)
- Send to LLM vision → 2000–5000 tokens
- Model clicks at pixel coordinates → breaks on layout change

**The Logica Pilot Solution:**
- Inject JS → index **every interactive element** by role + label (a11y-aware)
- Return compact map: `[0] button "Buy"  [1] textbox "Search"  [2] link "Contact"`
- Model acts by **index** (`click [0]`) → resilient, deterministic, cheap
- Fallback to **vision** (screenshot with indices drawn as badges) for opaque canvas/maps
- Result: **10–100× fewer tokens**, same semantic understanding

## Zero Dependencies

Discovers installed Chromium (Chrome / Edge / Brave / Chromium) and speaks CDP via `--remote-debugging-pipe`.  
No Playwright. No Puppeteer. No npm bloat.

## Programmatic API

```js
const { LogicaPilot } = require('logica-pilot');

const pilot = await new LogicaPilot({ headless: true }).launch();

// Simple snapshot (indexed map)
const snap = await pilot.snapshot();
console.log(pilot.format(snap));

// Autonomous goal
const result = await pilot.run('find the cheapest RTX 4090 and tell me the shop');
console.log(result.result);

// Raw actions (no AI)
await pilot.actions.click(0);
await pilot.actions.type(1, 'search term', true); // type + submit
await pilot.actions.scroll('down', 500);

await pilot.close();
```

## Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Call Anthropic API directly (if LogicaProxy unavailable) |
| `LOGICA_PILOT_LLM_URL` | `http://127.0.0.1:8317/v1/messages` | LogicaProxy endpoint (local brain) |
| `LOGICA_PILOT_MODEL` | `claude-sonnet-4-6` | LLM model ID |
| `LOGICA_PILOT_BROWSER` / `CHROME_PATH` | auto-detect | Chromium binary path |
| `BRAVE_SEARCH_API_KEY` | — | High-reliability web search (preferred over Bing) |
| `LOGICA_PILOT_HEADFUL` | — | Launch browser in headful mode by default |
| `LOGICA_PILOT_DEBUG` | — | Verbose logs (stderr) |

## How the Browser Works

**Two shells, one engine:**

```
        ┌─────────── LOGICA PILOT MOTOR ─────────────┐
        │ Perception (a11y + vision)                  │
        │ Actions by index (click/type/scroll)        │
        │ Autonomous loop (Claude via LogicaProxy)    │
        └──────────┬───────────────────┬──────────────┘
     CDP via pipe  │                   │  CDP via webContents.debugger
                   ▼                   ▼
         ┌──────────────────┐  ┌──────────────────────┐
         │ HEADLESS MODE    │  │ BROWSER (Electron)   │
         │ For agents       │  │ Real window, tabs,   │
         │ Scraping / Auto  │  │ omnibox, Pilot panel │
         └──────────────────┘  └──────────────────────┘
```

The Electron app **is** real Chromium. `webContents.debugger` **is** Chrome DevTools Protocol.  
Same motor that runs headless drives the real window — AI has full control because it speaks CDP to embedded Chromium.

## Full Browser Features (Electron App)

- **Tabs** with favicon, audio indicator, spinner, reopen closed (⌘⇧T), ⌘1–9
- **Omnibox** with suggestions (history + search), security lock, progress bar
- ⭐ **Bookmarks** — star button, bar (⌘⇧B), manager
- 🆕 **New Tab** with most visited + news feed · 🕘 **History** · ⬇️ **Downloads**
- 📄 **Native PDF** · 📖 **Reader mode** (⌥⌘R) · 🌐 **Translate**
- 🔎 **Find in page** (⌘F) · 🔍 **Zoom** (⌘ +/−/0) · 🖨️ **Print** (⌘P)
- 🔐 **Permissions** (camera/mic/location) · 🕵️ **Incognito** (⌘⇧N)
- 🧩 **Chrome extensions** — install from Web Store or unpacked folder

> **Tech detail:** Chromium's `<webview>` paints above all HTML overlays. So menus (⋮ menu, Settings, permissions, Find, omnibox suggestions) are **frameless OS windows** — OS-level layer, styled to blend seamlessly.

## Integration with LogicaOS

Exposed as skill `pilot` in `LogicaOS/skills/pilot/` with the standard contract `{ ok, data | error }`.  
Replaces the old `playwright` skill.

```js
const pilot = require('./skills/pilot');
await pilot.run('find and summarize all product reviews');
await pilot.open('https://example.com');  // returns indexed map
const data = await pilot.extract('https://shop.com', 'price, rating, in_stock');
```

## Quick Start

### Run the Browser (Real Window)

```bash
npm install                # downloads Electron runtime
npm run browser            # opens Logica Pilot window
```

Navigate normally. Press ⌘K to open the **Pilot panel**, type an objective, and watch AI navigate — *in your session* (your logins/cookies).

### Headless CLI

```bash
# Navigate and print the indexed map
logica-pilot open https://example.com

# Run an autonomous task
logica-pilot run "find the store hours for MASP museum" --vision
```

### As an MCP Tool in Claude Desktop

Add the config above, then in Claude:

> Use the `browser_navigate` tool to go to `https://amazon.com`, then `browser_search` to find "best laptop 2024", then `browser_fanout` across the results and `browser_extract` product specs with price.

---

<div style="text-align: center; margin-top: 3rem; opacity: 0.7; font-size: 0.9rem;">

**Rovemark · AI Infrastructure · built for the Architect.**

</div>
