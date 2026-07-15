# Features

Logica Pilot is two things in one: a **token-first automation engine** (82 tools,
CLI + MCP + programmatic) and a **full desktop browser** with an embedded AI copilot.

---

## Automation — 82 tools

Every tool is identical across the CLI (`logica-pilot <tool>`), MCP (`browser_<tool>`)
and the programmatic API. All token-first, zero-dependency, local. Full reference with
args and examples: **[TOOLS.md](TOOLS.md)**.

| Group | Tools |
|-------|-------|
| **Navigation** (5) | navigate · back · forward · reload · wait (semantic) |
| **Perception** (14) | observe (indexed map) · read (markdown/cache/redactPII/**engine http·adaptive**) · extract · meta · images · product · **apis (backend API discovery)** · **jsdata (hydration state)** · **locate (value→path)** · video · media · links · handoff · screenshot |
| **Actions** (12) | act (click/type/press/scroll by index) · fill · select · hover · eval · pdf · upload · dialog · drag · storage · permission · evalbatch |
| **Autonomy** (3) | run (autonomous loop) · adapter (site→tool) · workflow (deterministic replay) |
| **Site** (9) | map · crawl · **crawler (Crawlee-style: queue+pageFunction+dataset+resume)** · **actor (manifest+INPUT schema)** · **registry (shareable actor catalog)** · index (BM25 offline) · dataset · batch (async) · llmstxt |
| **Multi-Agent** (8) | fanout · search · gather · ask · research · compare · deal · factcheck |
| **Session & Monitoring** (6) | session · persist (CF-clearance) · memory · watch · monitor · runs |
| **Browser Control** (13) | stealth · **fingerprint (realistic, consistent + webrtc-block)** · **sessions (rotating identity pool)** · device · geo · tabs · wipe · health · html · fast · feedback · window · captcha |
| **Network** (4) | block · throttle · intercept (mock/headers) · proxypool (named pools + local rotating forwarder) |
| **DevTools & Testing** (2) | inspect (console/network/perf/eval) · assert (+ screenshot-diff) |
| **HTTP & Storage** (6) | **fetch (browserless HTTP)** · **queue (durable RequestQueue)** · **kvs (Key-Value Store)** · **vectorize (scrape→vector DB, incremental)** · **webhook (run-lifecycle)** · **schedule (cron)** |

### Apify/Crawlee parity — what makes it a scraping platform, not just a browser
- **Browserless HTTP tier + adaptive routing** — `fetch`/`read --engine http` skip Chrome on the ~70% of the web that renders over HTTP (10-50× cheaper); `engine:adaptive` tries HTTP first and auto-escalates to the browser on JS-shell/anti-bot, learning per host.
- **Durable, resumable storage** — a crawl killed mid-run resumes (RequestQueue WAL); Key-Value Store for blobs/INPUT/OUTPUT/checkpoints.
- **REST API** — `logica-pilot serve` = a drop-in for ScrapingBee/ScraperAPI (`GET /?url=…`) + `/v1/tools`, `/v1/actors/:name/runs`, `/v1/datasets`, `/v1/key-value-stores`.
- **Crawlee-style crawler** — a `pageFunction` per matched page → dataset rows, auto-enqueue, retry, resume, identity rotation.
- **Realistic fingerprints + rotating SessionPool + local rotating proxy** — internally-consistent identities (UA⇔UA-CH⇔webgl⇔screen), health-scored rotation, per-request proxy auth+rotation, WebRTC-leak block.
- **Backend API discovery** — `apis` finds + replays the private JSON APIs a page calls; `jsdata` surfaces hydration state; `locate` reverse-maps a value to its endpoint/path.
- **Formal Actors + webhooks + cron** — versioned, typed, portable units; run-lifecycle webhooks; scheduled runs.

### Capabilities that a cloud scraper can't match
- **Attach to your real browser** (`--attach <port>`) — your profile, logins, extensions.
- **BYO proxy + geo, now pooled** — any provider (`user:pass@host:port`); named **proxy pools** with round-robin/sticky/geo rotation; country emulation.
- **Stealth / anti-fingerprint** — opt-in `navigator.webdriver`/WebGL/plugins/canvas patching; **Cloudflare clearance persists** across runs (`persist`).
- **CAPTCHA — honest by default** — `detect` + human `handoff`; automated solving is gated opt-in with your own solver key.
- **Video understanding** — captions → transcript, keyframe sampling for a vision model, optional LLM summary — token-first, not opaque.
- **Device emulation + GPS** — mobile viewports/UA + geolocation override; **network throttle** and **request mocking**.
- **DevTools + test asserts** — console/network/perf capture, and assertions with screenshot-diff visual regression.
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
