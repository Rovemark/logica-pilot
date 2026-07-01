# FEATURES

## Automation: Token-First Browser for Agents

Logica Pilot is a token-efficient browser automation layer built on pure Chrome DevTools Protocol (CDP). Instead of shipping raw HTML or full-page screenshots to LLMs (thousands of tokens, brittle selectors), Logica Pilot delivers **compact indexed perception**: `[0] button "Buy" [1] textbox "Search"`. Agents act by index and intention—**10–100× fewer tokens than Playwright + LLM**.

### Core Perception System

- **Indexed element mapping**: Extract interactive elements (buttons, inputs, links) with semantic labels and current values
- **Readable text extraction**: Clean DOM traversal, strips navigation/ads/boilerplate, delivers just the content
- **Compact format**: Typically 200–500 tokens vs. 5,000–50,000 for HTML or screenshot-based flows
- **Visual fallback (screenshot with marks)**: When CSS selectors or DOM inspection isn't enough, paint element indices directly on the page for opaque canvases/maps

### MCP Tools (14 total)

The **MCP Server** (`logica-pilot mcp`) exposes a JSON-RPC 2.0 stdio interface compatible with Claude Desktop, Cursor, Cline, and any MCP-aware agent. Add to your client config:

```json
{
  "mcpServers": {
    "logica-pilot": {
      "command": "logica-pilot",
      "args": ["mcp"]
    }
  }
}
```

#### Navigation & Observation

- **`browser_navigate`**: Load a URL, return the indexed element map + readable text
- **`browser_observe`**: Take a fresh snapshot of the current page (handy when state changes)
- **`browser_screenshot`**: Capture the page as JPEG, optionally with index marks drawn (visual debug/fallback)

#### Acting (By Index)

- **`browser_act`**: Perform an action by element index — no fragile selectors
  - `click(index)` → click an element
  - `type(index, text, [submit])` → type into a textbox, optionally send Enter
  - `press(key)` → press a key (Enter, Tab, Escape, ArrowDown, etc.)
  - `scroll(direction, amount)` → scroll up/down by pixels

#### Data Extraction

- **`browser_extract`**: Extract structured data
  - `instruction` (natural language) + optional `schema` → returns JSON via AI (compact, structured)
  - `query` (CSS selector) → deterministic fallback, returns text content of matches

#### Reading & Summarization

- **`browser_read`**: Return clean, readable page text (ads/nav stripped)
  - `summarize: true` → condense via LLM (useful for long articles)

#### Autonomous Loops

- **`browser_run`**: Multi-step goal as a loop — agent observes → acts → repeats until done
  - `goal` (string): "Find the iPhone 15 price on Google and tell me the cheapest"
  - `maxSteps` (number): prevent infinite loops (default 12)
  - Returns result summary

#### Multi-Agent: Fanout

- **`browser_fanout`**: Run the same task across **N URLs in parallel**, each in its own headless CDP page
  - `urls` (array): pages to process
  - `task` (string): what to do on each
  - `mode` (extract|read|run): extraction type
  - `synthesize` (optional): synthesis instruction (e.g., "compare and rank by value")
  - `concurrency` (number): parallel pages (default 4, max 8)
  - Returns structured results + optional synthesis (cited answer)

#### Search & Research Recipes

- **`browser_search`**: Query the web, return ranked results (title + URL)
  - Uses Bing (0-dependency redirect decode) + optional BRAVE_SEARCH_API_KEY
  
- **`browser_research`**: Deep Research — search → fanout on results → synthesize with citations `[n]`
  - `query` (string): your question
  - `limit` (number): how many sources to check (default 5)

- **`browser_deal`**: Best Deal — find stores selling a product, extract price + shipping, rank by **actual value**
  - `product` (string): what to find
  - `limit` (number): shops to compare

- **`browser_factcheck`**: Fact-Check — search independent sources, return a verdict with citations
  - `claim` (string): the assertion to verify

#### Monitoring

- **`browser_watch`**: Poll a URL, detect if content changed (hash-based diff)
  - Returns `{ url, changed: true|false, firstCheck, title, textPreview }`
  - Use for price/stock/vacancy monitors

#### Session Persistence

- **`browser_session`**: Save/load browser cookies for logged-in flows
  - `action: save | load | list`
  - `name` (string): session identifier
  - Log in once, reuse forever

### CLI Commands

Run Logica Pilot from the terminal. All commands default to headless (CDP over stdio pipe) and auto-detect an installed Chromium.

#### Autonomous Tasks

```bash
# Run a goal autonomously, print the result
logica-pilot run "find the iPhone 15 price on Google and compare with Amazon"

# Options:
#   --url U          start at this URL (default: blank page)
#   --headful        show the browser window (Electron)
#   --model M        LLM model (default: claude-sonnet-4-6, or your configured model)
#   --max-steps N    max iterations (default 12)
#   --json           output JSON instead of prose
#   --vision         attach screenshots to the LLM (more tokens, sees opaque content)
```

#### Snapshot & Observation

```bash
# Print the indexed element map of a URL (no automation)
logica-pilot open https://example.com
# Alias: logica-pilot snapshot https://example.com
```

#### Content Reading

```bash
# Read clean page text (no HTML, no ads)
logica-pilot read https://example.com

# Optionally summarize
logica-pilot read https://example.com --summarize
```

#### Data Extraction

```bash
# Extract structured JSON from a page
logica-pilot extract https://example.com --task "list all product names and prices"
```

#### Search & Multi-Agent

```bash
# Search the web
logica-pilot search "best MacBook for software development" --limit 8

# Fanout: run the same task on multiple URLs (parallel)
logica-pilot fanout \
  --urls https://site1.com,https://site2.com,https://site3.com \
  --task "extract the price and shipping cost" \
  --synthesize "compare the three and rank by total cost" \
  --concurrency 3 \
  --json

# Research (search + fanout + synthesize with citations)
logica-pilot research "How does Claude compare to GPT-4?"

# Best Deal (find shops, extract prices, rank by value)
logica-pilot deal "Sony WH-1000XM5 headphones"

# Fact-Check (search + verify + verdict)
logica-pilot factcheck "The earth is flat"

# Compare (fanout on given URLs with a comparison task)
logica-pilot compare --urls https://a.com,https://b.com --task "which is faster?"
```

#### Browser App

```bash
# Launch the full Electron browser (see "The Browser" section below)
logica-pilot browser
```

### Programmatic API (Node.js)

Use Logica Pilot in your own Node.js scripts:

```javascript
const { LogicaPilot } = require('logica-pilot');

// Create a headless pilot
const pilot = await new LogicaPilot({
  headless: true,
  url: 'https://google.com',
  model: 'claude-sonnet-4-6',
}).launch();

// Autonomous goal
const result = await pilot.run('find the price of the iPhone 15');
console.log(result.result);

// Take a snapshot
const snapshot = await pilot.snapshot({ maxEls: 120 });
const formatted = pilot.format(snapshot);  // IndexedElements
console.log(formatted);

// Raw actions (deterministic, no AI)
await pilot.actions.click(0);      // click element [0]
await pilot.actions.type(1, 'hello', true);  // type into [1], send Enter
await pilot.actions.scroll('down', 600);
const screenshot = await pilot.actions.screenshot({ fullPage: true });

await pilot.close();
```

### LLM Integration

Logica Pilot works out-of-the-box with your own Anthropic API key (set via Settings or `ANTHROPIC_API_KEY` environment variable). It can also use:

- **Local LogicaProxy** (`:8317`): if available, preferred (faster, private)
- **Fallback to Anthropic API**: if proxy is down and a user key exists, calls the Anthropic API directly

Model default: `claude-sonnet-4-6`. Override with `--model` or `model:` config.

### Session Store

Logica Pilot persists browser cookies and session state in `~/.config/logica-pilot/sessions/`. Once you log in to a service, save the session and reuse it for subsequent runs—no re-login needed.

---

## The Browser: Full Chrome-Parity Electron App

Logica Pilot includes a **native Electron browser** that combines:

- **Real Chromium** (via `webContents.debugger` for CDP automation)
- **Full Chrome feature parity** (tabs, bookmarks, history, extensions, etc.)
- **Live Pilot copilot panel** (right sidebar: set an objective, watch the AI navigate)
- **12-language UI** (auto-detected: PT-BR, EN, ES, FR, DE, IT, NL, PL, RU, JA, KO, ZH)
- **Light/dark theme** (auto-detect OS preference or manual toggle)

### Tabs

- **Create tab**: `Cmd+T` (macOS) / `Ctrl+T` (Windows/Linux)
- **New window**: `Cmd+N` / `Ctrl+N`
- **Switch tabs**: `Cmd+1` through `Cmd+9` (or click tab)
- **Close tab**: `Cmd+W` / `Ctrl+W`
- **Reopen closed tab**: `Cmd+Shift+T` / `Ctrl+Shift+T` (stack of ~25)
- **Tab state**: favicon, title, loading spinner, audio indicator (🔊), mute toggle
- **Background tabs**: open in background (useful in scripts)

### Navigation

- **Address bar** (omnibox): click to focus, type URL or search query
- **Search suggestions**: auto-complete from history, bookmarks, search engine
- **Back/Forward**: `Cmd+[` / `Cmd+]` or toolbar buttons
- **Reload**: `Cmd+R` / `Ctrl+R` (soft reload)
- **Hard reload** (bypass cache): `Cmd+Shift+R` / `Ctrl+Shift+R`
- **Stop loading**: `Esc`

### Bookmarks

- **Star a page**: `Cmd+D` / `Ctrl+D` (save to Bookmarks)
- **Bookmarks bar**: `Cmd+Shift+B` / `Ctrl+Shift+B` (toggle visibility)
- **View all bookmarks**: Favorites menu → Bookmarks Manager
- **Sync**: saved in `~/.config/logica-pilot/` (portable, multi-device ready)

### Home Tab (New Tab Page)

- **Top sites**: frecency-ranked (most visited/recent)
- **News feed**: curated headlines from major sources (tech, business, etc.)
- **Quick links**: shortcuts to bookmarks
- **Search bar**: search engine configured in Settings

### History

- **View history**: Menu → History or `Cmd+Y` / `Ctrl+H`
- **Clear history**: Settings → Privacy → Clear browsing data (by date range or all)
- **Stored in**: `~/.config/logica-pilot/history/`

### Downloads

- **Download folder**: `~/Downloads` (configurable)
- **View downloads**: `Cmd+Shift+J` / `Ctrl+Shift+J`
- **Auto-resume**: interrupted downloads continue when the browser restarts
- **Quarantine metadata**: safely cleared on macOS

### Find (Ctrl+F Mode)

- **Find on page**: `Cmd+F` / `Ctrl+F`
- **Find next**: `Enter` or `Cmd+G` / `Ctrl+G`
- **Find previous**: `Shift+Enter` or `Cmd+Shift+G` / `Ctrl+Shift+G`
- **Case-sensitive toggle**: available in find bar
- **Close**: `Esc`
- **Highlights all matches** with position counter (e.g., "1 of 5")

### Reader Mode

- **Toggle**: `Cmd+Alt+R` / `Ctrl+Alt+R` or Menu → View → Reader Mode
- **Purpose**: distraction-free article reading (removes ads, sidebars, comments)
- **Font/size/color controls**: in the reader toolbar
- **Uses Readability.js**: proven algorithm, high-fidelity extraction

### Translate

- **Auto-detect language**: CLD3 (Chromium's model)
- **Translate page**: Menu → View → Translate Page (or `Cmd+Alt+T` / `Ctrl+Alt+T`)
- **Language picker**: choose source/target language
- **Uses Google Translate API** (privacy: full page sent to Google)

### Zoom

- **Increase**: `Cmd+Plus` / `Ctrl+Plus`
- **Decrease**: `Cmd+Minus` / `Ctrl+Minus`
- **Reset to 100%**: `Cmd+0` / `Ctrl+0`
- **Persists per domain** in settings
- **Range**: 25% to 500%

### Print

- **Print to PDF**: `Cmd+P` / `Ctrl+P`
- **System printer selection** (if available)
- **Margins, header/footer, duplex** configurable in print dialog

### Permissions

- **Camera / Microphone / Geolocation / Clipboard**: per-domain prompts
- **Permission manager**: built-in (allow/block per site, remember choice)
- **Permissions stored in**: `~/.config/logica-pilot/` (per partition)

### Incognito (Private Browsing)

- **Open incognito window**: `Cmd+Shift+N` / `Ctrl+Shift+N`
- **Behavior**: no history logged, cookies in-memory only, no downloads saved
- **Badge**: "Anônima" (incognito) label in the top bar
- **Useful for**: testing without leaving a trace, testing privacy-aware sites

### Chrome Extensions

- **Install from Chrome Web Store**: browser recognizes you (cleaned User-Agent)
- **Unpacked local extensions** (dev mode): supported
- **Permission prompts**: per-extension, respect Chrome's model
- **Management**: Menu → Extensions or `chrome://extensions/`
- **Storage**: partition-isolated (`persist:logica-pilot`)

### Settings & Preferences

- **Open Settings**: Menu → Preferences (`Cmd+,` / `Ctrl+,` on macOS)
- **Sections**:
  - **Theme**: System (auto-detect OS), Light, Dark
  - **Search engine**: Google, Bing, DuckDuckGo, custom
  - **Home page**: URL for new tabs
  - **Language**: 12 languages + "Auto" (system locale)
  - **API Key**: your Anthropic API key (for the Pilot panel)
  - **Pilot settings**: model, vision mode toggle, max steps
  - **Privacy**: clear browsing data (cookies, cache, history, downloads)

### Dark/Light Theme

- **Auto-detect**: by default, follows OS preference (macOS: System Preferences, Windows: Settings)
- **Manual toggle**: `Cmd+Shift+L` / `Ctrl+Shift+L` (Menu → View → Toggle Theme)
- **Persistent**: setting saved in `~/.config/logica-pilot/settings.json`
- **Coverage**: all UI elements, pages adapt via `prefers-color-scheme` CSS media query

### Keyboard Shortcuts (Complete)

| Shortcut | Action |
|----------|--------|
| `Cmd+T` / `Ctrl+T` | New tab |
| `Cmd+N` / `Ctrl+N` | New window |
| `Cmd+Shift+N` / `Ctrl+Shift+N` | Incognito window |
| `Cmd+W` / `Ctrl+W` | Close tab |
| `Cmd+Shift+W` / `Ctrl+Shift+W` | Close window |
| `Cmd+Shift+T` / `Ctrl+Shift+T` | Reopen tab |
| `Cmd+1` through `Cmd+9` | Switch to tab 1–9 |
| `Cmd+9` | Jump to last tab |
| `Cmd+Tab` / `Alt+Tab` | Switch app (OS-level) |
| `Cmd+[` / `Alt+Left` | Back |
| `Cmd+]` / `Alt+Right` | Forward |
| `Cmd+R` / `Ctrl+R` | Reload |
| `Cmd+Shift+R` / `Ctrl+Shift+R` | Hard reload |
| `Esc` | Stop loading |
| `Cmd+D` / `Ctrl+D` | Star (bookmark) |
| `Cmd+Shift+B` / `Ctrl+Shift+B` | Toggle bookmarks bar |
| `Cmd+Y` / `Ctrl+H` | History |
| `Cmd+Shift+J` / `Ctrl+Shift+J` | Downloads |
| `Cmd+F` / `Ctrl+F` | Find on page |
| `Cmd+G` / `Ctrl+G` | Find next |
| `Cmd+Shift+G` / `Ctrl+Shift+G` | Find previous |
| `Cmd+Alt+R` / `Ctrl+Alt+R` | Reader mode |
| `Cmd+Alt+T` / `Ctrl+Alt+T` | Translate page |
| `Cmd+Shift+L` / `Ctrl+Shift+L` | Toggle theme |
| `Cmd+,` (macOS only) | Settings |
| `Cmd+Alt+I` / `Ctrl+Shift+I` | DevTools |
| `Cmd+P` / `Ctrl+P` | Print |
| `Cmd++` / `Ctrl++` | Zoom in |
| `Cmd+-` / `Ctrl+-` | Zoom out |
| `Cmd+0` / `Ctrl+0` | Reset zoom |

### UI Localization (12 languages)

The entire browser interface is translated. Switch languages in Settings → Language:

- **Portuguese (Brasil)** — `pt-BR` (default in Brazil)
- **English** — `en`
- **Spanish** — `es`
- **French** — `fr`
- **German** — `de`
- **Italian** — `it`
- **Dutch** — `nl`
- **Polish** — `pl`
- **Russian** — `ru`
- **Japanese** — `ja`
- **Korean** — `ko`
- **Chinese (Simplified)** — `zh`

Or set to **"Auto"** to match your OS locale automatically.

### Pilot Panel (Sidebar)

The **Pilot copilot** is a live control panel on the right:

- **Objective input**: "What do you want me to do?" (placeholder shows example)
- **Vision checkbox**: include screenshots for the LLM (higher cost, sees opaque content)
- **Model selector**: choose LLM (default `claude-sonnet-4-6`)
- **Run button**: `Pilot ▸` — start autonomous navigation
- **Stop button**: `◼` — interrupt the current run
- **Status display**: step count, last action, current observation
- **Empty state hint**: "Give me an objective and I'll navigate alone — click, type, scroll, and read the page by intention, not by pixel."

---

## Technical Stack

- **Engine**: Zero-dependency Chrome DevTools Protocol (CDP) over `--remote-debugging-pipe` (file descriptors 3/4)
- **Browser discovery**: Auto-detects Chrome, Edge, Brave, Chromium (cross-platform)
- **Two shells, one engine**:
  - **Headless CDP** for agents/scripts (CLI, MCP, programmatic)
  - **Electron browser** for interactive use and live copilot
- **MCP server**: JSON-RPC 2.0 stdio (14 tools, 0 dependencies)
- **Search**: Bing (built-in redirect decode) + optional Brave Search API
- **LLM**: Anthropic API (your key) or local LogicaProxy (`:8317`)
- **Database**: SQLite for bookmarks, history, downloads (in `~/.config/logica-pilot/`)
- **UI framework**: Native Electron + vanilla JS (no React, lightweight)
- **Extensions**: Chrome Web Store via `electron-chrome-extensions`

---

## Getting Started

### Installation

```bash
npm install logica-pilot
# or globally:
npm install -g logica-pilot
```

### First Run

```bash
# Set your Anthropic API key
export ANTHROPIC_API_KEY=sk-ant-...

# Test the headless automation
logica-pilot run "find the weather in New York"

# Launch the browser
logica-pilot browser
```

### MCP Setup (for Claude Desktop / Cursor)

1. Open your MCP config (Claude Desktop: `~/Library/Application Support/Claude/claude_desktop_config.json`)
2. Add:
   ```json
   "mcpServers": {
     "logica-pilot": {
       "command": "logica-pilot",
       "args": ["mcp"]
     }
   }
   ```
3. Restart Claude Desktop
4. You now have 14 browser tools available in any conversation

---

**Built for teams and individuals who care about efficiency, privacy, and real browser capability. Open source (GPL-3.0). Part of Rovemark's Logica suite.**
