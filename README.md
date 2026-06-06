# @graelo/pi-searxng

A **minimalist** SearXNG web search extension for [Pi](https://github.com/earendil-works/pi).

This is a focused, no-frills implementation that provides only web search and result caching — no content fetching, no repository cloning, no external dependencies beyond SearXNG.

> **Note:** This is an independent fork of [jcha0713/pi-searxng](https://github.com/jcha0713/pi-searxng), stripped down to its core search functionality with improved caching.
>
> **Note:** This is a temp fork of [amartinr/pi-searxng](https://github.com/amartinr/pi-searxng) with a fix on the agent dir.

## Features

- **Web Search** - Search the web via a SearXNG instance
- **Cached Results** - Retrieve previous search results by ID for follow-up queries
- **Smart Caching** - Deterministic IDs, freshness TTL, LRU eviction, and deduplication
- **Safesearch** - Configurable content filtering (`off`, `moderate`, `strict`)

## Design Philosophy

This extension follows a **minimalist** approach:

- **Web search only** — No content fetching, no HTML-to-Markdown conversion
- **No repository cloning** — Unlike the original, it doesn't clone GitHub repos
- **No external tools** — Doesn't require `git` or any system dependencies
- **Self-contained** — Everything runs in-process, no background services
- **Updated imports** — Uses current `@earendil-works/` scoped packages (Pi coding agent, TUI, TypeBox)

If you need content extraction or repo browsing, consider using other Pi extensions for those tasks.

## Installation

```bash
pi install npm:@graelo/pi-searxng
```

Or try without installing:

```bash
pi -e npm:@graelo/pi-searxng
```

## Building

```bash
npm install
npm run build
```

This compiles the TypeScript source in `src/` to JavaScript in `dist/`.

## Configuration

Create `~/.pi/agent/extensions/pi-searxng/config.json`:

```json
{
  "searxngUrl": "http://localhost:8080",
  "timeoutMs": 30000,
  "maxResults": 10,
  "safesearch": "off"
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `searxngUrl` | string | `http://localhost:8080` | URL of the SearXNG instance (can also be set via `SEARXNG_URL` env var) |
| `timeoutMs` | number | `30000` | HTTP request timeout in milliseconds |
| `maxResults` | number | `10` | Maximum number of results returned per search |
| `safesearch` | string | `"off"` | Content filtering level (`"off"`, `"moderate"`, `"strict"`) |

Or use an environment variable:

```bash
export SEARXNG_URL=http://localhost:8080
```

## Tools

### `web_search`

Search the web using SearXNG. Results are automatically cached for subsequent identical queries.

**Parameters:**

- `query` (string, required) - Search query
- `limit` (number, optional) - Max results to return (overrides `maxResults` from config). Note: the actual number returned depends on SearXNG's internal configuration.

**Returns:** A `searchId` in the `details` field, which can be used with `get_search_results` or passed to subsequent calls.

### `get_search_results`

Retrieve cached search results by ID. Returns the original query and all cached results.

**Parameters:**

- `searchId` (string, required) - Search ID returned from a previous `web_search` call

**Returns:** The original search query and the cached results. If the `searchId` is not found, returns an error message.

## Error Handling

Both tools return error messages within the response content when something fails:

- **`web_search`** — If SearXNG is unreachable, returns a descriptive error (including the HTTP status and response body).
- **`get_search_results`** — Returns "Search not found" if the `searchId` doesn't exist in the cache.

## Result Format

Results are returned as numbered entries with the following structure:

```text
1. **Result Title**
   https://example.com
   Short snippet of the result content...
```

Each result includes the **title**, **URL**, and a **snippet** (truncated to 200 characters).

## Caching

The package includes an in-memory cache that reduces redundant calls to SearXNG:

- **Deterministic IDs** — The `searchId` is an MD5 hash of the query text, so the same query always produces the same ID. This enables cache deduplication and lookup via `get_search_results`.
- **Freshness TTL** — Cache entries are considered fresh for a configurable period (default: **15 min**). Stale entries trigger a new search instead of returning cached results.
- **Eviction TTL** — Entries that haven't been accessed within **24 hours** are automatically removed.
- **LRU eviction** — When the cache exceeds **200 entries**, the oldest (least recently used) entries are evicted.
- **Lazy cleanup** — Cleanup runs automatically at the start of each tool call.

### Cache configuration

These fields can be added to `~/.pi/agent/extensions/pi-searxng/config.json`:

| Field | Type | Default | Description |
|---|---|---|---|
| `cacheFreshnessMs` | number | `900000` (15 min) | How long cache entries are considered fresh before re-searching |
| `cacheTtlMs` | number | `86400000` (24 hours) | Max time an entry stays in cache without being accessed |
| `cacheMaxSize` | number | `200` | Max number of entries before LRU eviction kicks in |

## Requirements

- Node.js 18+
- A running SearXNG instance (for web search)

## License

MIT
