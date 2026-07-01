# Logica Pilot Architecture

**Logica Pilot** is an AI-native browser and a token-efficient replacement for browser automation frameworks like Playwright. It combines a 0-dependency Chrome DevTools Protocol (CDP) engine with a perception layer that returns compact indexed maps instead of raw HTML, enabling autonomous agents (Claude, Cursor, Cline) to control browsers with 10–100× fewer tokens.

## Core Philosophy

Traditional browser automation + LLM (Playwright → screenshot/HTML → LLM) is token-inefficient and brittle:
- Screenshots: sent as PNG base64, decoded at great token cost, only for visual reference.
- HTML: raw DOM dumps thousands of tokens, fragile selectors, layout-blind.
- Fallback to pixel coordinates: inflexible, breaks on resize.

**Logica Pilot flips the model:** inject a lightweight JavaScript probe, index all interactive elements (a11y-first), return a **compact text map** (`[0] button "Buy" [1] textbox "Email"`), and let the AI act by intent—just "click [0]". The same indices appear as visual badges on an optional screenshot for opaque canvases (maps, images, media). Result: 80–90% token savings + resilience to layout changes.

## System Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                       LOGICA PILOT ARCHITECTURE                     │
└─────────────────────────────────────────────────────────────────────┘

  ╔════════════════════════════════════════════════════════════════╗
  ║                      CHROME PROCESS                            ║
  ║  (Chrome/Edge/Brave/Chromium, auto-discovered cross-platform) ║
  ║                                                                ║
  ║  --remote-debugging-pipe  →  fd 3 (write) / fd 4 (read)       ║
  ║  JSON messages, \0-terminated, no third-party deps            ║
  ╚════════════════════════════════════════════════════════════════╝
              ▲
              │ CDP Protocol (binary pipes)
              │
  ┌─────────────────────────────────────────────────────────────┐
  │          CDPConnection (cdp-pipe.js)                        │
  │  ┌─────────────────────────────────────────────────────────┐│
  │  │ • Bidirectional pipe I/O (fd 3/4)                       ││
  │  │ • JSON framing (NUL-terminated)                         ││
  │  │ • Request/response correlation (id-based)               ││
  │  │ • Event emission (sessionId → Page)                     ││
  │  │ • Promise-based send(method, params, sessionId)         ││
  │  └─────────────────────────────────────────────────────────┘│
  └─────────────────────────────────────────────────────────────┘
              ▲
              │ Browser abstraction
              │
  ┌─────────────────────────────────────────────────────────────┐
  │  Browser + Page (browser.js)                                │
  │  ┌─────────────────────────────────────────────────────────┐│
  │  │ • Launch binary (resolveBrowserBinary)                  ││
  │  │ • Page factory (newPage → sessionId)                    ││
  │  │ • goto(url) / eval(expr) / send(cmd)                    ││
  │  │ • Lifecycle: spawn → attach → close                     ││
  │  └─────────────────────────────────────────────────────────┘│
  └─────────────────────────────────────────────────────────────┘
         ▲                    ▲
         │                    │
    headless            Electron webContents
     pipe mode          (electron-page.js)
         │                    │
    ┌─────────────────────────────────────────────────────────────┐
    │           PERCEPTION LAYER (perception.js)                 │
    │  ┌─────────────────────────────────────────────────────────┐│
    │  │ • snapshot(page, {maxEls}) → compact indexed map       ││
    │  │   - Injects __lp_collect() into page                   ││
    │  │   - Finds interactive a11y elements                    ││
    │  │   - Assigns data-lpilot-id & rectangle (cx, cy)        ││
    │  │                                                         ││
    │  │ • mark(page) → draws visual badges [n] on page         ││
    │  │ • format(snap) → human-readable text (for LLM)         ││
    │  └─────────────────────────────────────────────────────────┘│
    │                                                             │
    │  TOKENS SAVED: raw HTML eliminated, screenshot optional   │
    └─────────────────────────────────────────────────────────────┘
                      ▲
                      │
    ┌─────────────────────────────────────────────────────────────┐
    │           ACTIONS LAYER (actions.js)                       │
    │  ┌─────────────────────────────────────────────────────────┐│
    │  │ • click(page, id)   → real mouse events (move→press)    ││
    │  │ • type(page, id, text) → Input.insertText + events      ││
    │  │ • pressKey(page, key)  → KeyEvent (Enter, Escape, ...)  ││
    │  │ • scroll(page, dir, px) → window.scrollBy()             ││
    │  │ • extract(page, query)  → CSS selector or text          ││
    │  │ • screenshot(page, opts) → base64 (optional vision)     ││
    │  │ • navigate(page, url)   → Page.navigate + settle        ││
    │  └─────────────────────────────────────────────────────────┘│
    │                                                             │
    │  All use data-lpilot-id selector (never fragile CSS)       │
    └─────────────────────────────────────────────────────────────┘
              ▲
              │ function calling
              │
    ┌─────────────────────────────────────────────────────────────┐
    │           AUTONOMOUS AGENT (agent.js)                      │
    │  ┌─────────────────────────────────────────────────────────┐│
    │  │ Loop (perceive → LLM decide → act → repeat):           ││
    │  │                                                         ││
    │  │ 1. snapshot(page) → perceive state                      ││
    │  │ 2. format(snap) → compact text for Claude              ││
    │  │ 3. callClaude(goal, tools) → function call             ││
    │  │ 4. Execute one action (click/type/scroll/...)          ││
    │  │ 5. If done() → exit; else loop (max steps)             ││
    │  │                                                         ││
    │  │ System prompt: "use indices, scroll if not visible,    ││
    │  │  call done() when goal complete"                       ││
    │  └─────────────────────────────────────────────────────────┘│
    │                                                             │
    │  Agnóstic transport: works pipe + Electron webContents     │
    └─────────────────────────────────────────────────────────────┘
              ▲
              │ LLM brain
              │
    ┌─────────────────────────────────────────────────────────────┐
    │           LLM BRAIN (llm.js)                               │
    │  ┌─────────────────────────────────────────────────────────┐│
    │  │ • resolveTarget() → user key (sk-ant-…) or local proxy ││
    │  │ • callClaude(system, messages, tools)                  ││
    │  │ • Fallback chain:                                       ││
    │  │   1. User-configured URL (LOGICA_PILOT_LLM_URL)         ││
    │  │   2. User Anthropic key → api.anthropic.com             ││
    │  │   3. Local LogicaProxy (:8317)                          ││
    │  │   4. If proxy down, fall back to user key               ││
    │  │                                                         ││
    │  │ Model: claude-sonnet-4-6 (configurable)                ││
    │  └─────────────────────────────────────────────────────────┘│
    └─────────────────────────────────────────────────────────────┘
              ▲
              │ stdio JSON-RPC
              │
    ╔════════════════════════════════════════════════════════════════╗
    ║            MCP SERVER (mcp-server.js)                         ║
    ║  ┌──────────────────────────────────────────────────────────┐ ║
    ║  │ stdio JSON-RPC 2.0 (Claude Desktop, Cursor, Cline, ...)  │ ║
    ║  │                                                          │ ║
    ║  │ Tools:                                                   │ ║
    ║  │  • browser_navigate    → go to URL, return map          │ ║
    ║  │  • browser_observe     → read page state (no action)     │ ║
    ║  │  • browser_act         → click/type/press/scroll (index) │ ║
    ║  │  • browser_extract     → structured data (JS inject)     │ ║
    ║  │  • browser_read        → readable text (+ summarize)     │ ║
    ║  │  • browser_run         → autonomous goal (agent loop)    │ ║
    ║  │  • browser_fanout      → multi-agent (N URLs parallel)   │ ║
    ║  │  • browser_search      → web search results             │ ║
    ║  │  • browser_research    → deep research (search+fanout)   │ ║
    ║  │  • browser_deal        → best price across stores        │ ║
    ║  │  • browser_factcheck   → verify claim with sources      │ ║
    ║  │  • browser_watch       → detect page changes (monitor)   │ ║
    ║  │  • browser_session     → save/load login cookies         │ ║
    ║  │  • browser_screenshot  → visual fallback (with marks)    │ ║
    ║  └──────────────────────────────────────────────────────────┘ ║
    ║                                                                ║
    ║  One browser instance (headless), spawned on first call       ║
    ║  Config: { "mcpServers": { "logica-pilot": { ...} } }        ║
    ╚════════════════════════════════════════════════════════════════╝
         ▲
         │ CLI
         │
    ┌─────────────────────────────────────────────────────────────┐
    │                 CLI (bin/logica-pilot.js)                  │
    │  ┌─────────────────────────────────────────────────────────┐│
    │  │ Commands:                                               ││
    │  │  run "goal" [--url U] [--headful] [--model M]           ││
    │  │  open <url>       # show indexed map, exit              ││
    │  │  fanout --urls ... --task "..." [--synthesize ...]      ││
    │  │  research "<q>"   # search + multi-page extract         ││
    │  │  deal "<product>" # price comparison                     ││
    │  │  browser          # launch Electron GUI                  ││
    │  │  mcp              # start stdio MCP server               ││
    │  └─────────────────────────────────────────────────────────┘│
    └─────────────────────────────────────────────────────────────┘
         ▲
         │
    ┌─────────────────────────────────────────────────────────────┐
    │           PROGRAMMATIC API (index.js)                      │
    │  ┌─────────────────────────────────────────────────────────┐│
    │  │ const { LogicaPilot } = require('logica-pilot');        ││
    │  │ const p = await new LogicaPilot().launch();             ││
    │  │ const r = await p.run('goal');                          ││
    │  │ await p.close();                                         ││
    │  │                                                         ││
    │  │ p.actions.click(id), .type(id, text), .screenshot()... ││
    │  └─────────────────────────────────────────────────────────┘│
    └─────────────────────────────────────────────────────────────┘
         ▲
         │
    ┌─────────────────────────────────────────────────────────────┐
    │     MULTI-AGENT FANOUT (fanout.js)                         │
    │  ┌─────────────────────────────────────────────────────────┐│
    │  │ • Spawn N headless browsers (1 per URL, cap 8 parallel) ││
    │  │ • Each: run task (extract/read/run) independently        ││
    │  │ • Collect results                                        ││
    │  │ • Synthesis prompt: "merge [0], [1], [2]... with refs"  ││
    │  │                                                         ││
    │  │ Returns: {count, ok, results, synthesis}                ││
    │  │ Powers: research, compare, deal, factcheck              ││
    │  └─────────────────────────────────────────────────────────┘│
    └─────────────────────────────────────────────────────────────┘
         ▲
         │
    ┌─────────────────────────────────────────────────────────────┐
    │    BROWSER UI — ELECTRON (app/)                            │
    │  ┌─────────────────────────────────────────────────────────┐│
    │  │ • Windows: main window (BrowserWindow)                  ││
    │  │ • Tabs: native UI (favicon, audio, spinner)             ││
    │  │ • WebView: each tab is a <webview> → Chromium context   ││
    │  │ • Omnibox: URL bar + suggestions (search engines)       ││
    │  │ • Sidebar: history, bookmarks, downloads, settings      ││
    │  │ • Copilot panel: tasks, agent status, suggestions       ││
    │  │ • Extensions: Chrome Web Store + unpacked               ││
    │  │ • Features: Find (⌘F), Print, Reader (⌥⌘R), Zoom, etc.  ││
    │  │ • Themes: 12 languages, dark/light (nativeTheme)        ││
    │  │ • I18n: PT-BR, EN, ES, FR, DE, IT, NL, PL, RU, JA, KO, ZH
    │  │                                                         ││
    │  │ Integrates: perception + actions + agent for copilot    ││
    │  │ Each webview gets ElectronPage adapter for CDP control  ││
    │  └─────────────────────────────────────────────────────────┘│
    └─────────────────────────────────────────────────────────────┘
```

---

## Transport: Chrome DevTools Protocol over Pipes

### Why Pipes?

Traditional approaches use WebSocket (heavyweight) or bundled frameworks (Puppeteer, Playwright) that add bloat and dependency risk. Logica Pilot uses **Chrome's native `--remote-debugging-pipe` flag**, which speaks directly over two file descriptors opened by Node:

- **fd 3** (writable): Node → Chrome (commands)
- **fd 4** (readable): Chrome → Node (responses + events)

**Zero dependencies.** The protocol is implemented by hand in ~115 lines of `cdp-pipe.js`.

### Message Format

All messages are JSON, NUL-terminated (`\0`):

```
// Command (request)
{ "id": 1, "method": "Page.navigate", "params": { "url": "https://…" }, "sessionId": "sid_abc" }

// Response (success)
{ "id": 1, "result": { "frameId": "frame_1" } }

// Response (error)
{ "id": 1, "error": { "message": "Protocol error: Page not found" } }

// Event (unsolicited)
{ "method": "Page.loadEventFired", "params": {}, "sessionId": "sid_abc" }
```

### Browser Discovery

`resolveBrowserBinary()` auto-detects an installed Chromium (cross-platform):

- **macOS**: `/Applications/Google Chrome.app`, `/Applications/Edge.app`, Brave, Canary
- **Windows**: `C:\Program Files\Google\Chrome`, `C:\Program Files\Microsoft\Edge`, Brave
- **Linux**: `/usr/bin/google-chrome`, `/usr/bin/chromium`, `/snap/bin/chromium`
- **Fallback**: Reuse Playwright's cached binaries (if installed), respect `LOGICA_PILOT_BROWSER` / `CHROME_PATH` env

### Launch & Lifecycle

```javascript
const child = spawn(binary, [
  '--remote-debugging-pipe',
  '--user-data-dir=…',
  '--headless=new',       // or removed for headful
  '--disable-blink-features=AutomationControlled', // stealth
  '…other flags…',
  'about:blank'
], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });

const conn = new CDPConnection(child.stdio[3], child.stdio[4]);
await conn.send('Target.setDiscoverTargets', { discover: true });
```

The browser closes automatically when the Node process exits or `await browser.close()` is called.

---

## Perception Layer: Compact Indexed Maps

### Core Problem Solved

Instead of:
- Sending raw HTML (2000–5000 tokens) → LLM parses tags
- Sending screenshot (base64, 1000+ tokens) → LLM reads pixel coordinates

We inject a **tiny JavaScript probe** that:
1. Finds all interactive elements (a11y + ARIA roles)
2. Filters by visibility + interactivity
3. Assigns numeric indices
4. Returns structured JSON (no HTML, no image)

```javascript
// Result: 50–200 tokens per page (vs 2000–5000)
[
  { id: 0, tag: 'button', name: 'Buy Now', cx: 400, cy: 150, inView: true },
  { id: 1, tag: 'input', type: 'text', placeholder: 'Email', cx: 300, cy: 200 },
  { id: 2, tag: 'a', href: '/cart', name: 'Cart (3)', cx: 800, cy: 50 }
]
```

### JavaScript Injection (`perception.js`)

#### `__lp_collect(maxEls)`

Injected into the page via `page.eval()`. Runs entirely in-browser (no round-trip per element):

```javascript
function __lp_collect(maxEls) {
  // Selectors: interactive a11y + semantic HTML + ARIA roles
  const SEL = 'a[href], button, input:not([type=hidden]), textarea, select, [role=button], [role=link], …';
  
  // Filter: visible + not-disabled + has rect
  function rectOf(el) {
    const r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) return null;  // invisible
    if (visibility === 'hidden' || display === 'none' || opacity === 0) return null;
    if (el.disabled) return null;
    return r;
  }
  
  // Label extraction (priority: aria-label → placeholder → innerText → title → name)
  function labelOf(el) { … }
  
  // Collect & assign data-lpilot-id
  const out = [];
  for (el of document.querySelectorAll(SEL)) {
    const r = rectOf(el);
    if (!r) continue;
    el.setAttribute('data-lpilot-id', String(i));
    out.push({
      id: i, tag, type, role, name, value, placeholder, href, cx, cy, inView
    });
  }
  
  return { url, title, scrollY, scrollH, viewportH, count, elements: out, text: bodyText };
}
```

**Why ARIA-first?** Screen readers and accessibility tools already solve element labeling. We reuse that semantic work.

### Visual Fallback: Set-of-Marks (`mark()`)

For opaque content (maps, images, canvas):

```javascript
function __lp_mark() {
  // Create fixed overlay div
  const box = document.createElement('div');
  box.id = '__lpilot_marks';
  box.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;';
  
  // Draw badge for each [data-lpilot-id] element
  for (el of document.querySelectorAll('[data-lpilot-id]')) {
    const id = el.getAttribute('data-lpilot-id');
    const r = el.getBoundingClientRect();
    // Draw rectangle + label (colored borders + numbered badge)
    // Colors cycle: red, green, blue, orange, purple, …
  }
  
  document.documentElement.appendChild(box);
}
```

The badges are drawn on top of the page, then a screenshot is taken. The LLM sees the same indices in both text map and visual marks.

### Text Extraction

Also returned: cleaned visible text (innerText + collapse whitespace), max 3500 chars. Used for reading articles, prices, product names without needing DOM parsing.

### API

```javascript
const snap = await perception.snapshot(page, { maxEls: 120 });
// → { url, title, scrollY, scrollH, viewportH, count, elements, text }

const formatted = perception.format(snap);
// → human-readable string for LLM

const markedCount = await perception.mark(page);
// → draws badges, returns count

await perception.unmark(page);
// → cleans up overlay
```

---

## Action Layer: By Intent, Not Pixel

### All actions use `data-lpilot-id` selector, never fragile CSS.

#### `click(page, id)`

1. Find element: `document.querySelector('[data-lpilot-id="0"]')`
2. Scroll into view: `element.scrollIntoView({ block: 'center' })`
3. Get real coordinates: `getBoundingClientRect()` → center point
4. Dispatch real input events:
   - `Input.dispatchMouseEvent` type='mouseMoved' → type='mousePressed' → type='mouseReleased'
5. Wait for side effects (180ms)

**Result:** Real click that fires `mousedown`, `mouseup`, `click` events. Indistinguishable from user input.

#### `type(page, id, text, submit)`

1. Focus element (clear value if input)
2. `Input.insertText` (character-by-character via CDP, not simulated)
3. Fire `input` + `change` events (triggers React/Vue/etc reactivity)
4. Optional: `pressKey('Enter')` if submit=true

#### `pressKey(page, key)`

Supports: Enter, Tab, Escape, Backspace, ArrowUp/Down/Left/Right, PageUp/Down. Each fires proper KeyEvent (keyDown + keyUp).

#### `scroll(page, direction, amount)`

`window.scrollBy({ top, left, behavior: 'instant' })` (no animation lag).

#### `extract(page, query)`

- If query looks like a CSS selector, extract text from matches
- Else, return full visible text (from `document.body.innerText`)

#### `screenshot(page, opts)`

`Page.captureScreenshot` (base64 JPEG or PNG). Optional: full-page capture.

#### `navigate(page, url)`

`Page.navigate` + wait for load event + settle (500ms for JS).

### Agnóstic Transport

All actions receive a `page` object exposing:
- `page.send(method, params)` → CDP command
- `page.eval(expression)` → Runtime.evaluate
- `page.goto(url)` → navigation

This abstraction means the same `actions.js` works both on headless (pipe) and Electron (webContents.debugger).

---

## Autonomous Agent Loop

### System Prompt

```
You are Logica Pilot — an autonomous browser agent.

Each step, you receive:
  - Page URL and title
  - List of interactive elements indexed [0], [1], ...
  - Visible text of the page
  - Optional: screenshot with colored badges showing the indices

Your job: fulfill the goal using one tool per turn.

Rules:
  • Use indices, never invent them.
  • If your target is off-screen, scroll first.
  • For forms: type in the right field, then submit.
  • Observe the result before acting again.
  • Call done(success=true, result="…") when the goal is complete.
  • If stuck (paywall, captcha, login wall), call done(success=false, reason="…").
  • Be efficient: minimum steps.
```

### Loop (in `agent.js`)

```javascript
async function run(page, goal, opts = {}) {
  const tools = [ /* navigate, click, type, press, scroll, extract, screenshot, wait, done */ ];
  let step = 0;
  const maxSteps = opts.maxSteps || 10;
  
  while (step < maxSteps) {
    // 1. Perceive
    const snap = await perception.snapshot(page, { maxEls: 120 });
    const state = perception.format(snap);
    
    // 2. Decide (LLM with function calling)
    const resp = await llm.callClaude({
      system: SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: `Goal: ${goal}\n\n${state}` }
      ],
      tools,
      model: opts.model || 'claude-sonnet-4-6'
    });
    
    // 3. Check for done()
    if (resp.stop_reason === 'tool_use') {
      const tool = resp.content.find(c => c.type === 'tool_use');
      if (tool.name === 'done') {
        return {
          success: tool.input.success,
          result: tool.input.result,
          steps: step
        };
      }
      
      // 4. Execute action
      const result = await executeAction(page, tool.name, tool.input);
      
      // 5. Add to conversation for next turn
      messages.push({ role: 'assistant', content: resp.content });
      messages.push({ role: 'user', content: `Tool result: ${result}` });
    }
    
    step++;
  }
  
  return { success: false, result: 'Max steps reached', steps: step };
}
```

The LLM sees the full **conversation history**, so it learns from previous actions and can recover from mistakes.

---

## LLM Brain (llm.js)

### Target Resolution

The brain supports three tiers:

1. **User Key** (sk-ant-…): Direct to api.anthropic.com
   - Set via Settings/UI or `ANTHROPIC_API_KEY` env
   - Fully user-controlled, private

2. **Local LogicaProxy** (http://127.0.0.1:8317)
   - Part of LogicaOS ecosystem
   - Used in enterprise/dev settings
   - Internal key: `LOGICA_PILOT_KEY` (default "logicaos-internal")

3. **Fallback chain**:
   - Try primary (user config or LogicaProxy)
   - If primary fails AND user has key → fallback to Anthropic API
   - If both fail → error with helpful hint

### Configuration

```javascript
llm.configure({
  apiKey: 'sk-ant-…',    // user key (from Settings)
  url: 'http://…',       // custom LLM endpoint
  model: 'claude-sonnet-4-6' // model override
});
```

### callClaude()

Standard Anthropic Messages API:

```javascript
const resp = await llm.callClaude({
  system: 'You are Logica Pilot…',
  messages: [
    { role: 'user', content: 'Goal: find the price of X' },
    { role: 'assistant', content: 'I'll click the search box…' },
    { role: 'user', content: 'Tool result: search box focused' }
  ],
  tools: [ /* navigate, click, type, … */ ],
  model: 'claude-sonnet-4-6',
  maxTokens: 2048,
  temperature: 0
});
```

**Fallback retry:** If the primary target is unreachable and fallback is available, a second attempt is made silently.

---

## MCP Server (mcp-server.js)

### Overview

Exposes Logica Pilot as an **MCP server** (Model Context Protocol, stdio JSON-RPC 2.0). Works with Claude Desktop, Cursor, Cline, or any MCP-compatible agent.

### Configuration (Claude Desktop)

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

### Tool Catalog

#### Core Navigation & Perception

| Tool | Purpose |
|------|---------|
| `browser_navigate(url)` | Go to URL, return indexed map + text |
| `browser_observe({maxElements})` | Read current page state (no action) |
| `browser_screenshot({fullPage, marks})` | Visual snapshot (optional: with index badges) |

#### Actions (by Index)

| Tool | Purpose |
|------|---------|
| `browser_act(action, index, text, key, …)` | click / type / press / scroll (all by index, no CSS) |
| `browser_extract(instruction, schema, query)` | Structured data (JS inject + LLM, or CSS selector) |
| `browser_read({summarize})` | Readable page text (+ optional LLM summary) |

#### Autonomous

| Tool | Purpose |
|------|---------|
| `browser_run(goal, maxSteps)` | Autonomous agent loop (perceive → decide → act) |

#### Multi-Agent (Fanout)

| Tool | Purpose |
|------|---------|
| `browser_fanout(urls, task, mode, schema, synthesize, concurrency)` | Run task on N URLs in parallel, optionally synthesize |

#### Recipes (High-Level)

| Tool | Purpose |
|------|---------|
| `browser_search(query, limit)` | Web search results (title + URL, via Bing) |
| `browser_research(query, limit)` | Deep research: search → fanout (read/extract) + synthesis |
| `browser_deal(product, limit)` | Price comparison: search + fanout (extract price) + ranking |
| `browser_factcheck(claim, limit)` | Fact-check: search sources + fanout + veredict |

#### Session & Monitoring

| Tool | Purpose |
|------|---------|
| `browser_session(action, name)` | save / load / list (cookies for login reuse) |
| `browser_watch(url)` | Detect changes (content hash diff) — base for monitors |

### Recipes Deep-Dive

#### Deep Research

```json
{
  "method": "browser_research",
  "params": {
    "query": "latest AI regulations in Brazil 2025",
    "limit": 5
  }
}
```

Flow:
1. `browser_search(query, 5)` → returns 5 URLs
2. `browser_fanout(urls, "Extract the main points about regulations", mode: 'extract', concurrency: 4)`
   - Each URL processed independently
   - Structured JSON extracted per page
3. `synthesize({ instruction: "Merge all sources into a coherent timeline with citations [0], [1], …" })`
   - LLM reads all structured results
   - Returns synthesized answer with `[n]` references

**Token cost:** ~200–300 tokens per page (not 2000+) because we send only the indexed map + text, not HTML/screenshots.

#### Best Deal

```json
{
  "method": "browser_deal",
  "params": {
    "product": "MacBook Air M3 13in",
    "limit": 8
  }
}
```

Flow:
1. `browser_search("MacBook Air M3 13in site:price.com OR site:amazon.com.br OR …", 8)`
2. `browser_fanout(urls, "Extract: product name, price, shipping cost, discount %", schema: {price, shipping, discount}, concurrency: 4)`
3. Synthesis: rank by **real value** (price + shipping - discount), return sorted list with sources

#### Fact-Check

```json
{
  "method": "browser_factcheck",
  "params": {
    "claim": "Brazil's GDP grew 4% in 2024",
    "limit": 5
  }
}
```

Flow:
1. `browser_search("Brazil GDP 2024 growth", 5)`
2. `browser_fanout(urls, "What does this source say about Brazil's 2024 GDP growth?", mode: 'read')`
3. Synthesis: compare sources, veredict ("Confirmed: most sources agree", "Disputed: sources disagree on exact %", etc.)

### MCP Lifecycle

1. Server starts: `logica-pilot mcp` (stdio process)
2. Client connects: Claude Desktop, Cursor, etc.
3. Client calls `tools/list` → server returns TOOLS schema
4. Client invokes tool → server dispatches, one browser instance spawned on first tool call
5. Subsequent calls reuse the browser
6. Process exits → browser closes

---

## Two Shells, One Engine: Headless + Electron

### Headless (CDP over Pipes)

**Use case:** Automation, API, scripts, CI/CD, servers.

```bash
logica-pilot run "find the price of iPhone 15"
logica-pilot fanout --urls a.com,b.com --task "extract price"
logica-pilot open https://example.com
```

- Pure pipes, no GUI
- Spawns process, talks CDP, closes
- **Lightweight**, server-friendly

### Electron Browser

**Use case:** Interactive browsing with copilot overlay, dev/testing, visual tasks.

```bash
logica-pilot browser
# or
npm run browser
```

**Features:**
- **Real browser window** (Chromium parity)
- **Tabs** (favicon, audio indicator, spinner, reopen ⌘⇧T, ⌘1–9)
- **Omnibox** (URL bar + search suggestions from configurable engines)
- **Sidebar**: History, Bookmarks, Downloads, Settings
- **Copilot panel** (right side): Task input, agent status, suggestions
- **Extensions**: Chrome Web Store integration + unpacked extensions
- **Native UI**: Find (⌘F), Print (⌘P), Reader mode (⌥⌘R), Zoom, Translate
- **12 languages** (auto-detected): PT-BR, EN, ES, FR, DE, IT, NL, PL, RU, JA, KO, ZH
- **Dark/Light theme** (system-aware via `nativeTheme`)

#### Electron Integration

**Main process** (`app/main.js`):
- Registers protocol handlers (pilot://)
- Builds Application Menu
- Manages window lifecycle
- IPC handlers for UI commands

**Preload** (`app/preload.js`):
- Exposes safe IPC to renderer (ipcRenderer + contextBridge)
- Prevents direct `require()` in renderer (security)

**Renderer** (`app/renderer/renderer.js`):
- DOM rendering (tabs, sidebar, omnibox)
- Event listeners (click, input, keyboard)
- Communicates with main via IPC

**WebView Manager** (`app/main/webview-manager.js`):
- Attaches to each `<webview>` after creation
- Registers context menu handlers
- Bridges opener/target relationships
- Lifecycle: did-attach → did-finish-load → did-fail-load

**Extensions Manager** (`app/main/extensions-manager.js`):
- Loads Chrome Web Store extension list
- Manages unpacked extensions (security scanning)
- Handles extension permissions

#### CDP in Electron

Each tab's `<webview>` has an underlying `WebContents` object. The **ElectronPage adapter** (`electron-page.js`) bridges:

```javascript
class ElectronPage {
  async send(method, params) {
    return this.wc.debugger.sendCommand(method, params);
  }
  
  async eval(expression) {
    return this.wc.executeJavaScript(expression, true);
  }
  
  async goto(url) {
    await this.wc.loadURL(url);
    await new Promise(resolve => {
      this.wc.once('did-finish-load', resolve);
      setTimeout(resolve, timeout);
    });
  }
}
```

This means **the agent, perception, and action layers work identically** whether running headless or in Electron. The UI just adds visual control.

---

## File Map

```
logica-pilot/
├── bin/
│   └── logica-pilot.js              CLI entry point (run, open, fanout, browser, mcp, …)
│
├── src/
│   ├── index.js                     Public API (LogicaPilot class, launch/close/run)
│   ├── cdp-pipe.js                  CDP protocol client (fd 3/4, JSON framing, events)
│   ├── browser.js                   Browser launch & lifecycle, Page factory
│   ├── perception.js                snapshot() + mark() + format() (indexed map)
│   ├── actions.js                   click, type, press, scroll, extract, screenshot (by index)
│   ├── agent.js                     Autonomous loop (perceive → LLM → act)
│   ├── llm.js                       Anthropic API client (user key / proxy fallback)
│   ├── mcp-server.js                Stdio JSON-RPC 2.0 MCP server (14 tools)
│   ├── fanout.js                    Multi-agent orchestrator (N pages parallel + synthesis)
│   ├── search.js                    Web search (Bing, optional BRAVE_SEARCH_API_KEY)
│   ├── recipes.js                   High-level flows (research, deal, factcheck, watch)
│   ├── session-store.js             Cookie persistence (login reuse)
│   └── electron-page.js             WebContents → page adapter (Electron only)
│
├── app/
│   ├── main.js                      Electron main process (window, menu, IPC)
│   ├── preload.js                   Secure context bridge (ipcRenderer)
│   │
│   ├── main/
│   │   ├── webview-manager.js       Attach handlers to <webview> elements
│   │   ├── extensions-manager.js    Chrome Web Store + unpacked extensions
│   │   ├── menu.js                  Application Menu (File, Edit, View, …)
│   │   ├── history-store.js         Persistent history DB
│   │   ├── bookmarks-store.js       Bookmarks bar persistence
│   │   ├── downloads-store.js       Download tracker
│   │   ├── settings.js              User preferences (theme, search engine, …)
│   │   ├── search-engines.js        Omnibox search (Google, Bing, DuckDuckGo, …)
│   │   ├── news.js                  New Tab page (RSS feed integration)
│   │   └── view-registry.js         WebContentsView tracking (future WCV migration)
│   │
│   └── renderer/
│       ├── renderer.js              Main UI render loop (tabs, sidebar, omnibox)
│       ├── tabs.js                  Tab management DOM logic
│       ├── omnibox.js               URL bar + suggestions
│       ├── findbar.js               Find-in-page (⌘F)
│       ├── theme.js                 Dark/light mode, i18n loader
│       └── [i18n]/                  Translations (en.js, pt.js, es.js, …)
│
├── docs/
│   ├── ARCHITECTURE.md              This file
│   ├── MCP.md                       MCP tools documentation
│   ├── CHROME-PARITY-SPEC.md        Browser feature checklist
│   ├── ROADMAP.md                   Future direction
│   └── REVIEW-FIXES.md              Known issues & fixes
│
├── package.json                     Dependencies (Electron, electron-chrome-extensions, …)
└── README.md                        User guide & quick start
```

---

## Token Efficiency: The Numbers

### Typical Page Comparison

**Traditional (Playwright + LLM):**
- Raw HTML: 2000–4000 tokens
- Screenshot (base64): 1000–2000 tokens
- **Total per page: 3000–6000 tokens**
- Brittle: layout changes → broken selectors

**Logica Pilot:**
- Indexed map (text): 50–150 tokens
- Optional screenshot (visual aid): 500–800 tokens (rarely needed)
- **Total per page: 50–800 tokens (typically 100–200)**
- Resilient: indices don't change, only content

### Multi-Agent Fanout (Deep Research, 5 URLs)

**Traditional:** 5 pages × 4000 tokens = **20,000 tokens** (just perception)
**Logica Pilot:** 5 pages × 150 tokens = **750 tokens** + synthesis (~500) = **1250 tokens**

**→ 16× fewer tokens for the same task.**

---

## Security & Sandboxing

### Process Isolation

- Each headless browser is a **separate child process** (via `spawn()`)
- Runs with `--user-data-dir` (temp directory, no persistence by default)
- Disabled features: sync, updates, crash reporting, safe browsing
- Stealth flag: `--disable-blink-features=AutomationControlled`

### Electron App

- Preload script (enabled) + context isolation (enabled) → renderer can't access `require()`
- Main process validates all IPC messages
- Extensions sandboxed (Chrome Web Store + permission model)

### Session Storage

Cookies are **optionally** saved to disk if the user calls `browser_session('save', name)`. Otherwise, ephemeral per-tab.

---

## Extensibility

### Adding a New Tool

Edit `mcp-server.js`, add to `TOOLS` array and implement handler:

```javascript
{
  name: 'my_tool',
  description: 'Does something cool',
  inputSchema: { type: 'object', properties: { arg1: { type: 'string' } } }
}

// In handler:
if (toolName === 'my_tool') {
  const result = await myTool(pilot.page, input.arg1);
  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
}
```

### Custom Perception

Replace `perception.snapshot()` to return different element types, metrics, or labels. The indexed map format stays the same.

### Custom LLM

Override `llm.callClaude()` to call a different model or endpoint. The system prompt and function-calling interface remain compatible.

---

## Performance & Limits

| Metric | Value | Notes |
|--------|-------|-------|
| Pages per fanout | 4–8 concurrent | Cap 8 (resource limit) |
| Elements per page | 120 (configurable) | More = higher cost, not necessarily more useful |
| Agent steps | 10 (configurable) | Max iterations per goal |
| Screenshot size | ~50 KB JPEG | Downscaled to ~1280×720 |
| Typical task | 1–3 seconds | Headless; Electron may add UI lag |
| Multi-agent (fanout 4 URLs) | 8–12 seconds | Total time (parallel workers) |
| LLM latency | 500 ms – 2s | Network dependent |

---

## Deployment

### As CLI

```bash
npm install -g logica-pilot
logica-pilot run "goal"
logica-pilot browser
logica-pilot mcp  # for Claude Desktop
```

### As Library

```bash
npm install logica-pilot
```

```javascript
const { LogicaPilot } = require('logica-pilot');
const pilot = await new LogicaPilot().launch();
const result = await pilot.run('find price of X');
await pilot.close();
```

### As MCP Server

```json
{
  "mcpServers": {
    "logica-pilot": {
      "command": "node",
      "args": ["/path/to/node_modules/logica-pilot/bin/logica-pilot.js", "mcp"]
    }
  }
}
```

### Docker

Embed in a container with Chromium pre-installed:

```dockerfile
FROM node:20-alpine
RUN apk add --no-cache chromium
COPY logica-pilot /app
WORKDIR /app
RUN npm install
ENTRYPOINT ["node", "bin/logica-pilot.js"]
```

---

## Future Roadmap

- **WebContentsView Migration** (Electron): Replace `<webview>` with WebContentsView for better performance & lifecycle control
- **Vision Mode**: Full-page screenshot + visual grounding (for UI components, images, layout)
- **Persistent Sessions**: Save/restore login state, session data, tabs across restarts
- **Performance Profiling**: Built-in metrics (LLM tokens, page load time, memory)
- **Plugin System**: Extend perception, actions, recipes without modifying core
- **Mobile Simulation**: Device emulation (iOS/Android viewport, touch events)
- **JavaScript Execution**: `eval()` mode for deterministic scripts (no LLM needed)

---

## References

- [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/)
- [Anthropic Messages API](https://docs.anthropic.com/messages/reference)
- [Model Context Protocol (MCP)](https://modelcontextprotocol.io/)
- [Electron Documentation](https://www.electronjs.org/docs)

---

**Logica Pilot** © 2025, Rovemark. Licensed under GPL-3.0.
