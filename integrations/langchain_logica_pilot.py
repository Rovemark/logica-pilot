"""
langchain_logica_pilot — LangChain tools over the Logica Pilot REST API.

Logica Pilot's core stays zero-dependency; this is a thin, optional glue file for
Python agent stacks. It calls `logica-pilot serve` over HTTP — no LP internals.

Usage:
    from langchain_logica_pilot import scrape_tool, run_actor_tool, dataset_tool
    tools = [
        scrape_tool("http://localhost:8080", api_key="KEY"),
        run_actor_tool("http://localhost:8080", api_key="KEY"),
    ]
    # hand `tools` to any LangChain agent (create_react_agent, etc.)

Requires: `pip install langchain-core requests`
"""

from __future__ import annotations
import json
from urllib.parse import urlencode
import requests
from langchain_core.tools import Tool


def _headers(api_key: str | None) -> dict:
    return {"x-api-key": api_key} if api_key else {}


def scrape_tool(base: str, api_key: str | None = None, render_js: bool = True) -> Tool:
    """A tool that scrapes a URL to Markdown (ScrapingBee-shaped endpoint)."""
    def _scrape(url: str) -> str:
        q = urlencode({"url": url, "render_js": str(render_js).lower(), "markdown": "true"})
        r = requests.get(f"{base}/?{q}", headers=_headers(api_key), timeout=120)
        return r.text
    return Tool(
        name="logica_pilot_scrape",
        description="Scrape a web page to clean Markdown. Input: a URL. Handles JS-rendered pages.",
        func=_scrape,
    )


def run_actor_tool(base: str, api_key: str | None = None) -> Tool:
    """A tool that runs a named Actor. Input: 'actor_name {json-input}'."""
    def _run(spec: str) -> str:
        name, _, raw = spec.partition(" ")
        body = {"input": json.loads(raw)} if raw.strip() else {"input": {}}
        r = requests.post(f"{base}/v1/actors/{name}/runs", headers={**_headers(api_key), "content-type": "application/json"}, data=json.dumps(body), timeout=300)
        return r.text
    return Tool(
        name="logica_pilot_run_actor",
        description="Run a Logica Pilot Actor. Input: '<actor_name> <json_input>' e.g. 'book-scraper {\"startUrls\":[\"https://…\"]}'.",
        func=_run,
    )


def dataset_tool(base: str, api_key: str | None = None) -> Tool:
    """A tool that fetches a dataset's rows as JSON. Input: dataset name."""
    def _items(name: str) -> str:
        r = requests.get(f"{base}/v1/datasets/{name.strip()}/items", headers=_headers(api_key), timeout=60)
        return r.text
    return Tool(
        name="logica_pilot_dataset",
        description="Fetch the rows of a Logica Pilot dataset as JSON. Input: the dataset name.",
        func=_items,
    )


def call_tool(base: str, tool: str, args: dict, api_key: str | None = None) -> dict:
    """Low-level: invoke ANY of the 82 tools by name. Returns the parsed JSON/text."""
    r = requests.post(f"{base}/v1/tools/{tool}", headers={**_headers(api_key), "content-type": "application/json"}, data=json.dumps(args), timeout=300)
    try:
        return r.json()
    except Exception:
        return {"text": r.text}
