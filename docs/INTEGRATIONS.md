# Integrations — n8n · Zapier · Make · LangChain

Logica Pilot's **REST API** (`logica-pilot serve`) + **run-lifecycle webhooks** make it
reachable from every low-code/agent platform **today**, using their generic HTTP and
webhook building blocks — no vendor-specific package required. This guide shows the
canonical wiring; a self-contained LangChain tool is included.

> Start the server: `LOGICA_PILOT_API_KEY=… logica-pilot serve --port 8080`
> Everything below assumes `BASE=http://your-host:8080` and header `x-api-key: $KEY`.

## The surface (recap)

| Call | Verb / path |
|---|---|
| Scrape (ScrapingBee-shaped) | `GET /?url=…&render_js=&markdown=&screenshot=&extract=` |
| Run any tool | `POST /v1/tools/:name` (JSON body = args) |
| Run an Actor | `POST /v1/actors/:name/runs` (body `{ "input": {…} }`) |
| Read a dataset | `GET /v1/datasets/:name/items?offset&limit` |
| Read a KVS record | `GET /v1/key-value-stores/:store/records/:key` |
| List tools | `GET /v1/tools` |
| Registry catalog | `GET /index.json` |

Subscribe to outcomes (so a downstream flow triggers when a job finishes):

```bash
logica-pilot webhook add --event run.succeeded --url https://YOUR-FLOW/webhook --actor my-scraper
```

LP then POSTs `{ eventType, eventData, resource: { actor, datasetId, runId, status } }`.

---

## n8n

**Run an Actor and use the result**
1. **HTTP Request** node → `POST {BASE}/v1/actors/my-scraper/runs`, header `x-api-key`,
   JSON body `{ "input": { "startUrls": ["https://…"] } }`.
2. The response includes `dataset`; a second **HTTP Request** →
   `GET {BASE}/v1/datasets/my-scraper/items` returns the rows.

**Trigger a flow when a run finishes**
1. Add a **Webhook** trigger node (note its URL).
2. `logica-pilot webhook add --event run.succeeded --url <n8n-webhook-url> --actor my-scraper`.
3. The flow fires with `resource.datasetId` → pull items as above.

## Zapier / Make

- **Action:** *Webhooks by Zapier → POST* to `{BASE}/v1/actors/:name/runs` with the
  `x-api-key` header and `{ "input": {…} }`. Map the returned `dataset` downstream.
- **Trigger:** *Catch Hook* → register its URL with `logica-pilot webhook add`.
- **Make:** identical with the **HTTP** and **Webhooks** modules.

## LangChain (Python)

Drop-in tool wrapper over the REST API — see
[`integrations/langchain_logica_pilot.py`](../integrations/langchain_logica_pilot.py):

```python
from langchain_logica_pilot import scrape_tool, run_actor_tool

tools = [scrape_tool("http://localhost:8080", api_key="…"),
         run_actor_tool("http://localhost:8080", api_key="…")]
# hand `tools` to any LangChain agent
```

## MCP (agents)

Agents that speak MCP don't need the REST API at all — point them at the stdio server
(`logica-pilot mcp`); all 82 tools appear as `browser_<name>` plus saved adapters as
`x_<name>`. See [MCP.md](MCP.md).
