# Contributing to Logica Pilot

Welcome! Logica Pilot is an open-source browser automation engine built with zero dependencies and token-first design. We appreciate contributions of all kinds: bug fixes, features, tests, docs, and feedback.

## Development Setup

### Prerequisites

- **Node.js** ≥ 18
- **npm** (bundled with Node)
- A Chromium-based browser installed on your system (Chrome, Edge, Brave, or Chromium itself)

### Getting Started

1. **Clone the repository:**
   ```bash
   git clone https://github.com/Rovemark/logica-pilot.git
   cd "logica-pilot"
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```
   This downloads the Electron runtime (used for the browser GUI) and any dev tools.

3. **Verify setup with smoke test:**
   ```bash
   npm run smoke
   ```
   This runs a quick headless test against `example.com` and exits. If it prints an indexed map of the page, you're ready.

## Running Locally

### Headless Mode (CLI & MCP)

```bash
# Print the indexed map of a page (perception)
node bin/logica-pilot.js open https://example.com

# Run an autonomous task
node bin/logica-pilot.js run "find the price of an iPhone 15" --vision

# Start the MCP server (stdio JSON-RPC 2.0)
node bin/logica-pilot.js mcp

# Multi-agent fanout across 3 URLs
node bin/logica-pilot.js fanout --urls a.com,b.com,c.com --task "extract price and model" --synthesize "compare them"

# Read and summarize a page
node bin/logica-pilot.js read https://example.com --summarize

# Search the web
node bin/logica-pilot.js search "best Node.js web frameworks"
```

### Browser Mode (Electron GUI)

```bash
npm run browser
```

This launches the full Logica Pilot browser window with:
- Tabs, omnibox, favorites, history, downloads
- A live **Pilot** copilot panel (⌘K) to run autonomous tasks in your session
- Support for Chrome extensions (content scripts, Web Store, unpacked folders)
- Dark/light/system theme detection
- Multi-language UI (12 languages auto-detected)

## Project Layout

```
src/
  cdp-pipe.js         — CDP transport over --remote-debugging-pipe (0-dep)
  browser.js          — discovers & launches Chromium, manages pages/sessions
  perception.js       — indexed map of elements (a11y + vision badges)
  actions.js          — click/type/scroll/press/extract by index
  agent.js            — autonomous loop (observe → decide → act)
  llm.js              — LLM calls (Messages API via proxy or Anthropic)
  electron-page.js    — adapter: webContents.debugger → page contract
  index.js            — public API (LogicaPilot class)
  mcp-server.js       — MCP server (stdio, JSON-RPC 2.0)
  fanout.js           — multi-agent: N pages in parallel + synthesis
  search.js           — web search (Bing fallback, Brave API optional)
  recipes.js          — high-level recipes (research, compare, deal, factcheck)
  session-store.js    — login session persistence (cookies)

bin/
  logica-pilot.js     — CLI entry point

app/
  main.js             — Electron main process (window, CDP bridge, extensions)
  preload.js          — preload script (IPC to renderer)
  renderer/           — UI (tabs, omnibox, favorite, history, settings, pilot panel)

docs/
  MCP.md              — MCP tools & configuration
  ROADMAP.md          — future features
  CHROME-PARITY-SPEC.md — browser feature checklist

package.json          — manifest, scripts, dependencies
```

## Code Style

We follow **zero-dependency ethos** and **plain JavaScript** (no TypeScript, no transpilers):

- **No external libraries** except:
  - `electron` (browser GUI only)
  - `electron-chrome-extensions`, `electron-chrome-web-store` (extension support)
  - All automation logic uses **native Node.js + Chrome DevTools Protocol**

- **Plain JS conventions:**
  - `'use strict';` at the top of every file
  - No `async/await` in top-level module scope (use IIFE or explicit promises for init)
  - Comments over the code, not javadoc style (see `perception.js` for examples)
  - Avoid arrow functions in deeply nested contexts; use `function` for clarity
  - Variable names are descriptive (`pilot`, `snap`, `elements`; avoid `x`, `el`)

- **File structure:**
  - Each module exports a clear public API at the bottom
  - One logical concern per file
  - Heavy use of closures for encapsulation (e.g., `CDPPipe` in `cdp-pipe.js`)

- **Example comment style:**
  ```js
  /**
   * Short description of what this function does.
   * 
   * Use plain language. Links to docs if needed.
   */
  async function doThing(arg1, arg2) {
    // Explain non-obvious steps here.
    const result = await someOp();
    return result;
  }
  ```

## Adding a New MCP Tool

All MCP tools are defined in `src/mcp-server.js`.

### 1. Add a tool definition to the `TOOLS` array (near the top):

```js
{
  name: 'browser_myfeature',
  description: 'Does something cool. Returns a result.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'target URL' },
      mode: { type: 'string', enum: ['fast', 'thorough'] },
    },
    required: ['url'],
  },
}
```

### 2. Add the implementation in the `callTool()` function:

```js
case 'browser_myfeature': {
  const pilot = await P(); // get the shared browser instance
  await pilot.goto(opts.url);
  const mode = opts.mode || 'fast';
  
  // Your logic here
  const result = await someOperation(pilot, mode);
  
  return {
    ok: true,
    result,
  };
}
```

### 3. Test it:

```bash
# Interactive: connect Claude Desktop to your MCP server
node bin/logica-pilot.js mcp
# In Claude Desktop settings, add this tool config and ask Claude to test it

# Or via CLI smoke test
node bin/logica-pilot.js open "https://example.com"
```

## Adding a New CLI Command

CLI commands live in `bin/logica-pilot.js`.

### 1. Add a handler function (e.g., `async function cmdMyfeature(args) { ... }`):

```js
async function cmdMyfeature(args) {
  const url = args._[1] || args.url;
  if (!url) {
    console.error(`Usage: logica-pilot myfeature <url>`);
    process.exit(1);
  }

  banner();
  const pilot = new LogicaPilot({ headless: true });
  await pilot.launch();
  try {
    // Your command logic
  } finally {
    await pilot.close();
  }
}
```

### 2. Add a case in the `main()` switch statement:

```js
case 'myfeature':
  return await cmdMyfeature(args);
```

### 3. Test it:

```bash
node bin/logica-pilot.js myfeature https://example.com
```

## Testing

### Smoke Tests (automated)

```bash
npm run smoke
# Runs: logica-pilot open https://example.com
# Validates CDP connection, perception, and format output
# Should complete in < 5 seconds
```

### UI Tests (Electron)

```bash
LOGICA_PILOT_SMOKE=1 npm run smoke:electron
# Launches the Electron browser in smoke mode
# Opens a test page, verifies tab creation and content rendering
# Auto-closes after validation
```

### Manual Testing

```bash
# Test headless mode
node bin/logica-pilot.js run "find the current time" --url https://example.com

# Test browser mode
npm run browser
# Manually navigate, open Pilot panel (⌘K), type a goal, observe the loop

# Test MCP server
node bin/logica-pilot.js mcp
# In Claude Desktop, try: "Open https://example.com and tell me the title"
```

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `LOGICA_PILOT_LLM_URL` | `http://127.0.0.1:8317/v1/messages` | Brain endpoint (LogicaProxy) |
| `LOGICA_PILOT_MODEL` | `claude-sonnet-4-6` | LLM model ID |
| `LOGICA_PILOT_BROWSER` / `CHROME_PATH` | auto-detect | Path to Chromium binary |
| `ANTHROPIC_API_KEY` | — | Anthropic API key (fallback if proxy is down) |
| `BRAVE_SEARCH_API_KEY` | — | Brave Search API for high-confidence search |
| `LOGICA_PILOT_DEBUG` | — | Enable Chrome DevTools Protocol logs (stderr) |
| `LOGICA_PILOT_SMOKE` | — | Enable smoke test mode (auto-close after validation) |
| `LOGICA_PILOT_HEADFUL` | — | Run in headful mode (not headless) |
| `LOGICA_PILOT_UITEST` | — | Enable UI test mode (Electron) |

## Commit & PR Conventions

### Commit Messages

We use conventional commits (loosely; not strict):

- **fix:** bug fixes → `fix: CDP pipe hang on Chromium 130`
- **feat:** new features → `feat: add browser_watch tool for price monitoring`
- **refactor:** code cleanup → `refactor: simplify perception.js element collection`
- **docs:** documentation → `docs: add MCP tool integration guide`
- **test:** tests/smoke → `test: add fanout synthesis smoke test`

Examples:
```
feat: add browser_research tool with multi-agent synthesis

- Integrate search.js + fanout.js into recipes.js
- Add research() recipe to CLI
- Expose as browser_research MCP tool
- Include citation marks in synthesis

Closes #42
```

### Pull Request Process

1. **Fork & branch:** Create a feature branch off `main`
   ```bash
   git checkout -b feat/browser-watch
   ```

2. **Make changes:** Follow code style guidelines (see above).

3. **Test locally:**
   ```bash
   npm run smoke
   node bin/logica-pilot.js run "test goal" --url https://example.com
   ```

4. **Commit & push:**
   ```bash
   git commit -m "feat: add browser_watch tool"
   git push origin feat/browser-watch
   ```

5. **Open PR:** Include:
   - Clear title: "Add browser_watch tool for price monitoring"
   - Description of what changed and why
   - Testing steps you took
   - Link any related issues

6. **Review:** Address feedback, update tests if needed.

## License

Logica Pilot is licensed under **GPL-3.0-or-later**. All contributions are also released under this license. By submitting a PR, you agree to license your work under GPL-3.0-or-later.

For questions about the license or want to use Logica Pilot under a different license, contact Rovemark.

## Questions or Issues?

- **Bug report:** Open a GitHub issue with reproduction steps and environment info.
- **Feature request:** Describe the use case and why it matters.
- **Security issue:** Please do NOT open a public issue. Email security@rovemark.com.
- **Architecture question:** Ping the team or open a discussion.

## Architecture & Design Rationale

### Why No Playwright?

Playwright sends raw HTML or full screenshots to the LLM, which is expensive (thousands of tokens) and fragile (breaks on layout changes). Logica Pilot injects **semantic perception** into the page:

```js
[0] button "Buy Now"           // what the model sees
[1] textbox "Search"
[2] link "About"
```

The model acts **by index**, not by pixel or selector. It's 10–100× cheaper and resilient.

### Why Pure CDP?

- **Zero dependencies:** Removes bloat and security surface
- **Real Chromium:** Electron IS Chromium; `webContents.debugger` IS the Chrome DevTools Protocol
- **Cross-platform:** Works on macOS, Linux, Windows, no forks needed
- **Local-first:** Can run completely offline once the browser is discovered

### Why Electron for the GUI?

- **Same engine as headless:** The Electron browser runs the same CDP code as the CLI
- **Full feature parity:** Tabs, extensions, dev tools, login sessions—all native
- **Frameless popups:** Menu/settings/find are OS-level windows, not HTML overlays (clean rendering)
- **Integration:** The Pilot copilot panel lives in the same process, with instant access to browser state

## Inspirations & Related Work

- **Playwright:** Standard browser automation (but expensive + LLM-unaware)
- **Puppeteer:** Lower-level CDP client (good, but no perception layer)
- **Anthropic's Computer Use:** Pixel-and-click approach (which we improve upon with indexing)
- **Browser extensions:** How we inject perception and handle events

The Pilot differentiator is **semantic perception baked into the motor**, making IA/agents dramatically more capable per token.
