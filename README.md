# ◢ Logica Pilot

**The AI-native browser. Replace Playwright. Save 10–100× tokens.**

A real Chromium browser with an embedded autonomous AI copilot. The AI **perceives** pages by semantic intent (not pixel coordinates), **clicks, types, scrolls, and reads** autonomously until the goal is met. Pure Chrome DevTools Protocol (CDP) engine · zero Playwright dependency · both headless agent mode and a real desktop browser.

<div align="center">

[![GPL-3.0 License](https://img.shields.io/badge/license-GPL--3.0--or--later-green)](LICENSE)
[![MCP Server](https://img.shields.io/badge/MCP-Server-informational)](https://spec.modelcontextprotocol.io)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-success)](package.json)
[![Built with Chromium](https://img.shields.io/badge/built--with-Chromium-orange)](https://www.chromium.org)

</div>

---

## Why it beats Playwright + LLM

| Aspect | Playwright + LLM | Logica Pilot |
|--------|------------------|--------------|
| **LLM perception** | Raw HTML or full screenshot (thousands of tokens, brittle) | Compact indexed map: `[0] button "Buy"` (token-efficient) |
| **How it acts** | Fragile CSS selectors or pixel coordinates | By index / intention: `"click [0]"` (resilient to layout changes) |
| **Multi-page parallelism** | You orchestrate manually | Native `fanout` (N pages in parallel + synthesis) |
| **Integration** | Library-only | CLI + MCP + programmatic API |
| **Login persistence** | Re-login per script | `browser_session` (log in once, reuse cookies) |
| **Engine** | Puppeteer/Playwright deps | Zero-dep pure CDP over `--remote-debugging-pipe` |
| **Vision fallback** | Screenshot alone | Screenshot with indexed marks drawn (semantic) |
| **AI brain flexibility** | Your LLM, hardcoded | Any API (Anthropic, local proxy, custom) |

---

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
    │ HEADLESS MODE              │   │ DESKTOP BROWSER (Electron)       │
    │ For agents, scripts, APIs  │   │ Real Chromium window             │
    │ $ logica-pilot run "..."   │   │ Tabs, omnibox, bookmarks, login  │
    │ Fast & cheap               │   │ Full Chrome parity + AI copilot  │
    └────────────────────────────┘   └──────────────────────────────────┘
```

- **Single engine:** the same motor that drives headless agents powers the live browser window (webContents.debugger is the Chrome DevTools Protocol).
- **Two shells:** headless CDP-over-pipe for agents/scripts; Electron browser for interactive use.
- **Zero external deps:** pure Node.js + Electron (which bundles Chromium). No Playwright, no Puppeteer, no extra CLIs.

---

## Quick Start

### Desktop Browser (Real Window)

```bash
npm install
npm run browser
```

Opens a full-featured Chromium browser with tabs, bookmarks, history, downloads, extensions, login persistence, and a **Pilot** copilot panel (⌘K).

**Install Chrome extension:** 🧩 button in toolbar → *Install from folder* (unpacked `manifest.json`) or browse the Chrome Web Store.

### Headless / CLI (for Agents & Scripts)

```bash
# Single goal (autonomous loop)
logica-pilot run "find the MASP museum hours" --vision

# Snapshot a page (indexed map)
logica-pilot open https://example.com

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
logica-pilot compare --urls amazon.com,newegg.com --task "RTX 4090: price, specs, shipping"

# Best deal (price + shipping across stores)
logica-pilot deal "iPhone 15 Pro 256GB"

# Fact-check a claim
logica-pilot factcheck "coffee is bad for health"

# Search (Bing by default; Brave API if BRAVE_SEARCH_API_KEY set)
logica-pilot search "best laptop under $1000"
```

### Programmatic API

```js
const { LogicaPilot } = require('logica-pilot');

const pilot = await new LogicaPilot({ headless: true }).launch();

// Autonomous loop
const res = await pilot.run('compare iPhone 15 and Samsung S24 prices on 3 stores');
console.log(res.result);  // Fully cited answer

// Or step-by-step (manual)
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

Logica Pilot exposes **14 tools** as a Model Context Protocol (MCP) server, so any agent can drive a browser **token-efficiently** and in parallel.

### Configuration

Add to `claude_desktop_config.json` (or your client's MCP config):

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
- Run `logica-pilot` to open the browser → Settings → enter your **Anthropic API key** (`sk-ant-…`), *or*
- Export `ANTHROPIC_API_KEY=sk-ant-…`, *or*
- Run a local LogicaProxy (`:8317`)

### The 14 MCP Tools

| Tool | Purpose |
|------|---------|
| **`browser_navigate`** | Navigate to a URL; return the indexed map of interactive elements |
| **`browser_observe`** | Get the indexed map of the current page (semantic perception) |
| **`browser_act`** | Act by index: `click` / `type` / `press` / `scroll` (no selectors) |
| **`browser_extract`** | Extract structured data (JSON schema or natural language instruction) |
| **`browser_read`** | Get readable page content (ads/nav stripped); optionally summarize |
| **`browser_run`** | Autonomous loop: perceive → decide → act (full goal completion) |
| **`browser_fanout`** | **Multi-agent:** run task on N URLs in parallel; optionally synthesize |
| **`browser_search`** | Search the web; return URLs (title + link) |
| **`browser_research`** | Deep research: search + read multiple sources in parallel + synthesize with citations |
| **`browser_deal`** | Best deal: search for product, extract price/shipping from stores, rank by total cost |
| **`browser_factcheck`** | Fact-check: search for independent sources, synthesize verdict with citations |
| **`browser_watch`** | Monitor a URL; detect changes (price, stock, content diffs) |
| **`browser_session`** | Login once, save session; reuse cookies across tasks (`save` / `load` / `list`) |
| **`browser_screenshot`** | Capture page (with optional indexed marks drawn as visual fallback) |

**Example (Claude):**

```
User: "Find the cheapest RTX 4090 and tell me where and why."

Claude uses:
1. browser_search("RTX 4090 price buy") → [urls]
2. browser_fanout(urls, task: "extract: name, price, shipping, store")
3. Synthesizes → "Best deal: Amazon ($XXX + free shipping)…"
```

---

## Recipes: Multi-Agent AI Features

The core Logica Pilot engine powers 4 **killer recipes** (search + fanout + tuned synthesis):

### Deep Research 🧠

```bash
logica-pilot research "what is Logica Pilot?"
```

1. Searches the web for results.
2. Reads all sources in **parallel** (multi-agent).
3. Synthesizes a complete, **cited answer** with `[1]`, `[2]`, etc. pointing to sources.

### Best Deal 🧠

```bash
logica-pilot deal "MacBook Pro 16GB 512GB"
```

1. Searches for stores selling the product.
2. Extracts **price + shipping + availability** from each (parallel).
3. Ranks by **total cost** (price + shipping) and recommends the best.

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

All recipes are also **MCP tools** (`browser_research`, `browser_deal`, `browser_factcheck`) — call them directly from Claude or any agent.

---

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `ANTHROPIC_API_KEY` | — | Anthropic API key (if calling the API directly instead of LogicaProxy) |
| `LOGICA_PILOT_LLM_URL` | `http://127.0.0.1:8317/v1/messages` | LogicaProxy endpoint (or your custom LLM API) |
| `LOGICA_PILOT_MODEL` | `claude-sonnet-4-6` | Model name (or whatever your proxy supports) |
| `LOGICA_PILOT_BROWSER` / `CHROME_PATH` | auto-discover | Path to Chromium binary (auto-finds Chrome/Edge/Brave/Chromium) |
| `BRAVE_SEARCH_API_KEY` | — | Brave Search API key (for high-reliability web search; fallback is Bing) |
| `LOGICA_PILOT_DEBUG` | — | Set to enable Chrome DevTools Protocol debug logs |
| `LOGICA_PILOT_HEADFUL` | — | Set to `1` to keep MCP browser headful (window visible) |
| `LOGICA_PILOT_SMOKE` | — | Run self-test (Electron + CDP) and exit |

### AI Brain Options

**Option 1: Anthropic API (direct)**
```bash
export ANTHROPIC_API_KEY=sk-ant-…
logica-pilot run "your goal"
```

**Option 2: LogicaProxy (local, ~1ms latency)**
```bash
# In another terminal, run LogicaProxy or your custom LLM API on :8317
# Logica Pilot defaults to it; automatic fallback to Anthropic API if it's down.
logica-pilot run "your goal"
```

**Option 3: Custom LLM API**
```bash
export LOGICA_PILOT_LLM_URL=https://your-api.com/v1/messages
export LOGICA_PILOT_MODEL=gpt-4-turbo  # or whatever
logica-pilot run "your goal"
```

---

## Desktop Browser Features

The Logica Pilot **browser window** (Electron = real Chromium) includes:

- **Tabs** — favicon, audio indicator, loading spinner, tab reopen (⌘⇧T), pinning, numbered shortcuts (⌘1–9)
- **Omnibox** — address bar with search suggestions (history + web search), security lock, progress bar
- **⭐ Bookmarks** — star button, bookmark bar (⌘⇧B), manager
- **🆕 New Tab** — top sites, news feed (customizable)
- **🕘 History** — full browsing history (⌘Y)
- **⬇️ Downloads** — download manager (⌘⇧J)
- **📄 PDF viewer** — native PDF rendering
- **📖 Reader mode** — clean article layout (⌥⌘R)
- **🌐 Translation** — built-in page translation (supports 100+ languages)
- **🔎 Find** — in-page search (⌘F)
- **🔍 Zoom** — page zoom (⌘ +/−/0)
- **🖨️ Print** — native print dialog (⌘P)
- **🔐 Permissions** — camera, microphone, location, notifications (persistent)
- **🕵️ Incognito** — private browsing (⌘⇧N), isolated from main session
- **🧩 Chrome Extensions** — install from Chrome Web Store or local folder; full content script support
- **🌍 UI in 12 languages** — PT-BR, EN, ES, FR, DE, IT, NL, PL, RU, JA, KO, ZH (auto-detected)
- **⌘K Pilot Panel** — enter a goal, watch the AI navigate your page

---

## Architecture & Files

```
src/
  index.js              Public API (LogicaPilot class)
  cdp-pipe.js          Pure CDP over pipe (--remote-debugging-pipe), zero deps
  browser.js           Launch Chromium, manage pages/sessions
  perception.js        Semantic indexing (a11y tree) + visual marks
  actions.js           Click/type/scroll/press by index (real DOM events)
  llm.js               Brain (Messages API via LogicaProxy or Anthropic)
  agent.js             Autonomous loop (perceive → decide → act)
  electron-page.js     Adapter: webContents.debugger → page contract
  mcp-server.js        MCP server (stdio, 14 tools)
  fanout.js            Parallel multi-agent orchestration
  search.js            Web search (Bing default, Brave if key set)
  recipes.js           research / compare / deal / factcheck
  session-store.js     Cookie persistence (browser_session tool)

bin/
  logica-pilot.js      CLI entry point

app/
  main.js              Electron main process
  preload.js           IPC sandbox bridge
  renderer/            UI (React / vanilla JS)
    newtab/            New Tab (top sites, news)
    history/           History manager
    downloads/         Downloads manager
    settings/          Preferences (theme, AI key, search engine)
    bookmarks/         Bookmark manager
    omnibox/           Address bar + suggestions

docs/
  ARCHITECTURE.md      Deep dive into CDP, perception, agent loop
  MCP.md               MCP tools reference
  CHROME-PARITY-SPEC   Feature checklist for browser (100+ items)
```

---

## How It Works (Under the Hood)

1. **Pure CDP over pipe:** Launch Chromium with `--remote-debugging-pipe` (file descriptors 3/4). Zero syscalls, zero JSON parsing overhead. The transport is agnóstic — works identically on headless and Electron (which uses `webContents.debugger`).

2. **Semantic perception:** Inject JavaScript that walks the DOM, indexes interactive elements (`<button>`, `<a>`, `<input>`, ARIA roles), extracts labels (aria-label, placeholder, text content, alt), and returns a compact structure. Fallback to screenshot with marks.

3. **Intent-based action:** Instead of `"click at coordinates (420, 240)"`, the AI says `"click [5]"` — much cheaper, never breaks on layout changes.

4. **Autonomous loop:** Given a goal, the agent repeatedly observes (perception), decides (LLM), and acts (actions). Stops when the goal is met or max steps reached.

5. **Multi-agent orchestration** (`fanout`): Spawn N headless pages in parallel (each with its own CDP pipe), run the same task on each (extract / read / run), collect results, and optionally synthesize via the LLM. Token cost per page is the same; total wall time is `time_per_page / N`.

---

## Why Not Fork Chromium?

Forking Chromium in C++ (like Brave/Edge) requires months of build infra and a dedicated team. Electron ships **real Chromium with full AI control** today, cross-platform (macOS/Windows/Linux), in Node.js. If Logica Pilot becomes a flagship product, we can reevaluate CEF or a fork; for now, Electron is the right call.

---

## LogicaOS Integration

Logica Pilot is exposed as the **`pilot` skill** in the Rovemark LogicaOS suite (replacing the older Playwright skill). Agents call:

```js
const pilot = require('./skills/pilot');
const res = await pilot.run('your goal');
const snap = await pilot.snapshot(url);
const data = await pilot.extract(url, 'instruction');
```

---

## Requirements

- **Node.js:** >=18
- **Chromium:** auto-discovered (Chrome, Edge, Brave, Chromium)
- **Electron:** downloaded on first `npm install` (~150 MB)

## License

GPL-3.0-or-later

---

## Made With

- **Chromium** · the real browser engine (via Electron)
- **Chrome DevTools Protocol** · low-level browser control
- **Node.js** · single codebase, all platforms
- **Electron** · desktop browser shell + web APIs
- **Claude** (Anthropic) · the AI brain

<div align="center">

**Rovemark** · AI Infrastructure ·  [rovemark.com](https://rovemark.com)

Made for the Architect. Open source. Zero compromises.

</div>
