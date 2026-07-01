# ◢ Logica Pilot

**The AI-native browser. Replace Playwright. Save 10–100× tokens.**

A real browser with an embedded autonomous AI copilot. The AI **perceives** pages by semantic intent (not pixel coordinates), **clicks, types, scrolls, and reads** autonomously until the goal is met. Pure CDP engine · zero external dependencies · both headless agent mode and a full-featured desktop browser.

<div align="center">

[![GPL-3.0 License](https://img.shields.io/badge/license-GPL--3.0--or--later-green)](LICENSE)
[![MCP Server](https://img.shields.io/badge/MCP-Server-informational)](https://spec.modelcontextprotocol.io)
[![25 Tools](https://img.shields.io/badge/tools-25-blue)](src/tools.js)
[![Zero-dependency core](https://img.shields.io/badge/core%20engine-0%20deps-success)](src/)
[![Electron](https://img.shields.io/badge/desktop-Electron%2037-informational)](app/)

</div>

---

## Why it beats Playwright + LLM

| Aspect | Playwright + LLM | Logica Pilot |
|--------|------------------|--------------|
| **LLM perception** | Raw HTML or full screenshot (thousands of tokens, brittle) | Compact indexed map: `[0] button "Buy"` (10–100× fewer tokens) |
| **How it acts** | Fragile CSS selectors or pixel coordinates | By index / intention: `"click [0]"` (resilient to layout changes) |
| **Multi-page parallelism** | You orchestrate manually | Native `fanout` (N pages in parallel + synthesis) |
| **Integration** | Library-only | CLI + MCP + programmatic API |
| **Login persistence** | Re-login per script | `session` tool (log in once, reuse cookies) |
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

Logica Pilot exposes **25 tools** as a Model Context Protocol (MCP) server. Any agent can drive a browser token-efficiently and in parallel. CLI and MCP surfaces share **the same registry** — identical tools, defined once.

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

### The 25 Tools (Grouped by Function)

#### Navigation (5 tools)
| Tool | Purpose |
|------|---------|
| **navigate** | Go to URL; return the indexed map of interactive elements |
| **back** | History back; return page map |
| **forward** | History forward; return page map |
| **reload** | Reload the page and return the map |
| **wait** | Wait for text/selector/condition (semantic, no brittle sleeps) |

#### Perception (5 tools)
| Tool | Purpose |
|------|---------|
| **observe** | Get the indexed map of the current page (semantic elements + readable text) |
| **read** | Get readable page content (ads/nav stripped); optionally summarize via AI |
| **extract** | Extract structured data (JSON schema or natural language instruction) |
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

#### Session & Monitoring (2 tools)
| Tool | Purpose |
|------|---------|
| **session** | Manage login sessions (cookies): `save` / `load` / `list` — log in once, reuse forever |
| **watch** | Check a URL and report whether content changed (price, stock, text diffs) |

#### Multi-Agent Recipes (6 tools)
| Tool | Purpose |
|------|---------|
| **fanout** | Run the same task on N URLs in **parallel** (separate headless pages) + optional synthesis |
| **search** | Search the web; return URLs (title + link). Bing default; Brave if `BRAVE_SEARCH_API_KEY` |
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
  mcp-server.js         MCP server (stdio, 25 tools)
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
