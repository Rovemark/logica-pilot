# Security Model — Logica Pilot

## Overview

Logica Pilot is an AI-native browser that couples a real Chromium engine (via Chrome DevTools Protocol) with an autonomous agent loop. This document describes the security posture, responsible-use guidelines, and known considerations.

**Core principle:** Logica Pilot gives an AI agent real control over a browser instance in your session. This is powerful for automation, and requires informed use.

---

## Architecture & Trust Boundaries

### The Autonomous Agent

Logica Pilot runs an LLM-driven agent loop that:
- **Observes** the page via accessibility tree + optional vision fallback (screenshot with indexed marks)
- **Decides** what action to take (click, type, scroll, extract)
- **Acts** on the page via Chrome DevTools Protocol

The agent operates **in your browser session**, with access to:
- Active tabs and all their content (HTML, DOM, JavaScript context)
- Cookies and local/session storage (you are logged in)
- Form data, passwords stored in the browser
- Downloads, bookmarks, history (if accessed programmatically)
- Extensions and their content scripts

**You should supervise sensitive actions** — large financial transfers, password changes, credential entry to unfamiliar services. Consider:
- Running Logica Pilot in **incognito mode** (⌘⇧N) for untrusted tasks
- Testing automation on non-production accounts first
- Reviewing the agent's goal before executing

### Browser Engine (Chromium)

Logica Pilot bundles **real Chromium** (via Electron). This means:
- Full **Chrome security model**: same-origin policy, content-security-policy, site isolation
- **Chrome extensions** can be installed (from Web Store or unpacked). They run with their declared permissions; review them as you would in normal Chrome
- **Native permissions** (camera, microphone, location) use OS dialogs and your browser grants
- **Incognito isolation** (⌘⇧N) creates a separate, ephemeral session with no cookies/cache

### The LLM (Claude)

The agent uses **your LLM credential** to think. Two routing options:

#### Option A: Your Anthropic API Key (Recommended for production)
- Set your Anthropic key in **Settings → Pilot** (`sk-ant-…`)
- Stored locally in `~/.logica-pilot/settings.json` (plain text on disk; see "API Keys" below)
- Sent directly to `api.anthropic.com` with HTTPS
- You control usage and can rotate/revoke the key at any time

#### Option B: Local LogicaProxy (LogicaOS only)
- If running inside LogicaOS, an internal proxy at `:8317` is used by default
- Falls back to your Anthropic key if the proxy is unavailable
- No external API calls in this mode

**API usage**: each agent step makes a Claude API call. Monitor your usage on the Anthropic dashboard.

---

## Credentials & Data Storage

### Sensitive Data Locations

| Item | Location | Format | Notes |
|------|----------|--------|-------|
| **Anthropic API Key** | `~/.logica-pilot/settings.json` | Plain text JSON | Guarded by OS file permissions; recommend env var for CI/CD |
| **Session Cookies** | `~/.logica-pilot/sessions/<name>.json` | JSON (CDP format) | Loaded on-demand via `--session <name>` flag; includes HttpOnly flag info |
| **Browser Profile** | Electron `userData` dir | Chromium profile | Standard browser cache, history, extensions, bookmarks (not encrypted) |
| **History** | `userData/history.db` | SQLite | Stored locally; used by omnibox autocomplete |
| **Downloads** | `userData/downloads.json` | JSON metadata | Records file names, URLs, timestamps (not the actual files) |

### Securing API Keys

**For development/testing:**
```bash
export ANTHROPIC_API_KEY=sk-ant-xxx
logica-pilot run "your goal"
```
The CLI reads `ANTHROPIC_API_KEY` without persisting it.

**For the browser (GUI):**
- Open **Settings → Pilot** (or panel ⌘K → ⚙️)
- Paste your Anthropic key; it's saved to `settings.json`
- Delete it from settings to stop using it

**Best practice for CI/CD & servers:**
- Never paste keys into the GUI
- Use environment variables (`ANTHROPIC_API_KEY`)
- Rotate keys regularly
- Use least-privilege keys (if Anthropic supports key scoping)

### Session Cookies

If you log into a service (e.g., GitHub, Gmail) while the agent is running, you can **persist the session**:

```bash
logica-pilot session save my-github
```

This saves all cookies to `~/.logica-pilot/sessions/my-github.json`. **Anyone with file access can steal these cookies.** Treat this directory like `.ssh`:

```bash
chmod 600 ~/.logica-pilot/sessions/*.json
```

Reuse the session later:
```bash
logica-pilot run "check my repos" --session my-github
```

**Do not commit session files to version control.** Add to `.gitignore`:
```
.logica-pilot/
```

---

## MCP Server (Multi-Agent Access)

### Local stdio Protocol

The MCP server runs **locally over stdio** (standard input/output), meaning:
- **No network exposure** — Claude Desktop, Cursor, Cline communicate via pipes/sockets
- **No remote API** — all processing happens on your machine
- Requests are **limited to your machine's tools** (the browser, file system, etc.)

### MCP Configuration

In Claude Desktop, Cursor, or Cline, add:

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

The MCP server is a **child process** of the agent's session; it shares:
- The same browser instance
- The same LLM configuration (API key)
- The same local file system access

### Multi-Agent Fanout

The `browser_fanout` tool runs **the same task on multiple URLs in parallel**, each in its own headless page. Results are extracted as JSON and optionally synthesized.

- Each page is **isolated** (separate CDP connection, no cookie sharing between URLs)
- Synthesis uses the **same LLM** (your key) to combine results
- Useful for price comparison, research, fact-checking

**Responsible use:**
- Respect `robots.txt` and site ToS
- Do not fanout over 10+ sites without understanding the load impact
- Do not extract data from sites that prohibit scraping

---

## Responsible Use

### Do

✅ Automate your own accounts and workflows  
✅ Test automation on non-production data first  
✅ Review the agent's goal before running it  
✅ Use incognito (⌘⇧N) for untrusted or test tasks  
✅ Monitor API usage and agent behavior  
✅ Rotate API keys periodically  

### Don't

❌ Use the agent to bypass access controls or authentication  
❌ Automate large-scale scraping or DDoS-like fanout  
❌ Leave the agent running unattended with sensitive actions  
❌ Share session files (cookies) with others  
❌ Rely solely on the agent for financial/legal decisions — humans must review  
❌ Install untrusted Chrome extensions  

---

## Known Gaps & Guardrails Roadmap

### Current State

- **No domain allowlist** — the agent can navigate to any URL
- **No confirmation step** — sensitive actions (e.g., form submission, button click) happen automatically
- **No audit log** — actions are not recorded to disk by default

### Planned Mitigations

**Domain allowlist** (phase 2)
- Allow-list domains in settings (e.g., only run on `github.com`, `notion.so`)
- Agent refuses to navigate outside the list
- Fallback mode: warn on first navigation outside the list

**Confirmation prompts** (phase 2)
- Flag certain actions as sensitive (e.g., click "Submit", "Send", "Transfer", "Delete")
- Require user confirmation via UI dialog before executing
- Timeout: auto-cancel if no confirmation after 30 seconds

**Audit log** (phase 3)
- Log all agent actions (navigation, clicks, extractions) to a local file
- Include URL, action type, timestamp, extracted data
- Optional encryption and rotation (for compliance)

**Sandbox & container isolation** (future)
- Run agent in a separate Chromium profile with restricted permissions
- Limit cookie access between browser sessions
- Restrict file system access to specific directories

---

## Reporting a Vulnerability

If you discover a security issue in Logica Pilot:

1. **Do not open a public GitHub issue.**
2. **Contact the maintainers privately:**
   - Email: [security@rovemark.com](mailto:security@rovemark.com)
   - Include: description, reproduction steps, impact
3. **Give us time to respond** (~30 days) before public disclosure.
4. **Do not exploit the vulnerability** beyond the minimum needed to confirm it.

We take security seriously and will patch issues promptly. Once patched, we'll credit you (unless you prefer anonymity).

---

## References

- **Chrome DevTools Protocol** — [chromium.org/blink/public/devtools-protocol](https://chromedevtools.github.io/devtools-protocol/)
- **Electron Security** — [electronjs.org/docs/tutorial/security](https://www.electronjs.org/docs/tutorial/security)
- **Anthropic API Security** — [docs.anthropic.com/claude/reference/getting-started-with-the-api](https://docs.anthropic.com/claude/reference/getting-started-with-the-api)
- **Chrome Extension Security** — [developer.chrome.com/docs/extensions/mv3/security](https://developer.chrome.com/docs/extensions/mv3/security/)

---

**Last updated:** 2026-06-30  
**Version:** Logica Pilot 0.1.0  
**License:** GPL-3.0-or-later
