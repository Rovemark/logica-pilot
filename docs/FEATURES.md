# Features

Logica Pilot is two things in one: a **token-first automation engine** (43 tools,
CLI + MCP + programmatic) and a **full desktop browser** with an embedded AI copilot.

---

## Automation — 43 tools

Every tool is identical across the CLI (`logica-pilot <tool>`), MCP (`browser_<tool>`)
and the programmatic API. All token-first, zero-dependency, local. Full reference with
args and examples: **[TOOLS.md](TOOLS.md)**.

| Group | Tools |
|-------|-------|
| **Navigation** (5) | navigate · back · forward · reload · wait (semantic) |
| **Perception** (10) | observe (indexed map) · read (markdown/paginate/cache/redactPII) · extract · meta · images · product · media · links · handoff · screenshot |
| **Actions** (6) | act (click/type/press/scroll by index) · fill · select · hover · eval · pdf |
| **Autonomy** (3) | run (autonomous loop) · adapter (site→tool) · workflow (deterministic replay) |
| **Site** (6) | map · crawl · index (BM25 offline) · dataset · batch (async) · llmstxt |
| **Multi-Agent** (8) | fanout · search · gather · ask · research · compare · deal · factcheck |
| **Session & Monitoring** (5) | session · memory · watch · monitor · runs |

### Capabilities that a cloud scraper can't match
- **Attach to your real browser** (`--attach <port>`) — your profile, logins, extensions.
- **BYO proxy + geo** — any provider (`user:pass@host:port`); country emulation.
- **PII redaction** — deterministic, local, free (email/phone/CPF/CNPJ/card/IP).
- **Consent-killer** — cookie/consent walls dismissed before perception.
- **Self-repair memory** — failures + fixes learned per site; converges to zero breakage.
- **Site adapters & workflows** — any site becomes a named tool; tasks replay without an LLM.
- **Monitors & datasets** — scheduled change alerts + living local tables (free price/stock time series).
- **Local BM25 index** — crawl once, query offline forever (0 tokens, 0 network).
- **~77% lower input cost** per run (prompt caching + map pruning); perception 5–185× smaller than raw HTML.

---

## The browser (desktop app)

A real Chromium-based browser (Electron) with the AI copilot built in.

| Area | What's there |
|------|--------------|
| **Tabs & windows** | new/close/reopen/switch, background open, new window |
| **Navigation** | address bar with search suggestions, back/forward/reload/stop |
| **Bookmarks** | star, manager |
| **Home tab** | frecency-ranked top sites, news feed, quick links |
| **History & downloads** | searchable history (clear by range), downloads with folder config |
| **Find & reader** | in-page find (Ctrl+F, match counter), Reader mode (Readability) |
| **Translate & zoom** | page translation, per-domain zoom |
| **Print & PDF** | print + save as PDF |
| **Permissions** | per-site camera/mic/geolocation/clipboard prompts |
| **Incognito** | private window, in-memory cookies |
| **Extensions** | Chrome Web Store + unpacked dev extensions |
| **Ad-block** | native blocking (EasyList + EasyPrivacy) with per-site allowlist + panel |
| **Settings & theme** | search engine, language, API key, privacy; dark/light auto |
| **Pilot panel** | objective input, vision toggle, model picker, live step timeline |
| **Localization** | multi-language UI |

The panel drives the same autonomous engine as the CLI/MCP `run` tool — give a goal,
watch the steps stream, get the answer in the browser's language.

---

See **[TOOLS.md](TOOLS.md)** for the full tool reference, **[MCP.md](MCP.md)** for the
MCP/CLI guide, and the **[README](../README.md)** for the token benchmark and the moat.
