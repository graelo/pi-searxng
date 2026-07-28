import { createHash } from "node:crypto";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import type { SearchResult } from "./searxng.js";
import { search } from "./searxng.js";
import { loadConfig } from "./config.js";

interface CacheEntry {
  query: string;
  limit: number | undefined;
  results: SearchResult[];
  createdAt: number;
  lastAccessed: number;
}

interface WebSearchSuccessDetails {
  searchId: string;
  resultCount: number;
  query: string;
}

interface WebSearchErrorDetails {
  searchId: string;
  error: string;
}

type WebSearchDetails = WebSearchSuccessDetails | WebSearchErrorDetails;

interface GetResultsSuccessDetails {
  searchId: string;
  query: string;
  resultCount: number;
}

interface GetResultsErrorDetails {
  searchId: string;
  error: string;
}

type GetResultsDetails = GetResultsSuccessDetails | GetResultsErrorDetails;

const searchCache = new Map<string, CacheEntry>();

// Helper that retrieves a cache entry and moves it to the end of the Map (LRU)
function getCacheEntry(id: string): CacheEntry | undefined {
  const entry = searchCache.get(id);
  if (entry) {
    searchCache.delete(id);
    searchCache.set(id, entry); // re-insert → moves to end (most recently used)
  }
  return entry;
}

const { config, diagnostics, notices } = loadConfig();
for (const problem of diagnostics) {
  console.warn(problem);
}
for (const notice of notices) {
  console.info(notice);
}
const CACHE_FRESHNESS_MS = config.cacheFreshnessMs;
const CACHE_TTL_MS = config.cacheTtlMs;
const MAX_CACHE_SIZE = config.cacheMaxSize;

function cleanup(): void {
  const now = Date.now();

  // Remove expired entries
  for (const [id, entry] of searchCache) {
    if (now - entry.lastAccessed > CACHE_TTL_MS) {
      searchCache.delete(id);
    }
  }

  // Evict oldest entries if over limit
  while (searchCache.size > MAX_CACHE_SIZE) {
    const firstKey = searchCache.keys().next().value;
    if (firstKey) searchCache.delete(firstKey);
  }
}

function generateId(query: string, limit?: number): string {
  const key = limit !== undefined ? `${query}|${limit}` : query;
  return createHash("md5").update(key).digest("hex");
}

function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) return "No results found.";
  return results.map((r, i) => 
    `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet.slice(0, 200)}${r.snippet.length > 200 ? "..." : ""}`
  ).join("\n\n");
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: "Search the web using SearXNG",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      limit: Type.Optional(Type.Number({ description: "Max results to return" }))
    }),
    
    async execute(_id, params, signal) {
      // Sanitize limit parameter
      let warningNote = "";
      let limit: number | undefined;
      if (params.limit !== undefined) {
        const originalLimit = params.limit;
        limit = Math.max(1, Math.ceil(params.limit));
        if (limit !== originalLimit) {
          warningNote = `Note: limit was adjusted from ${originalLimit} to ${limit}.\n\n`;
        }
      }

      const searchId = generateId(params.query, limit);

      if (signal?.aborted) {
        return {
          content: [{ type: "text", text: "Aborted" }],
          details: { searchId, error: "Aborted" }
        } as AgentToolResult<WebSearchDetails>;
      }

      try {
        cleanup();
        const cached = getCacheEntry(searchId);
        const isStale = cached && (Date.now() - cached.createdAt > CACHE_FRESHNESS_MS);

        let results: SearchResult[];

        if (cached && !isStale) {
          // Fresh cache → return directly
          cached.lastAccessed = Date.now();
          results = cached.results;
        } else {
          // Not found or stale → search SearXNG
          const { results: newResults } = await search(params.query, limit, config);
          results = newResults;
          searchCache.set(searchId, {
            query: params.query,
            limit,
            results,
            createdAt: isStale ? Date.now() : (cached?.createdAt || Date.now()),
            lastAccessed: Date.now()
          });
        }

        return {
          content: [{ type: "text", text: warningNote + formatSearchResults(results) }],
          details: { searchId, resultCount: results.length, query: params.query }
        } as AgentToolResult<WebSearchDetails>;
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          details: { searchId, error: String(err) }
        } as AgentToolResult<WebSearchDetails>;
      }
    },
    
    renderCall(args, theme) {
      const q = (args as any).query || "";
      const display = q.length > 50 ? q.slice(0, 47) + "..." : q;
      return new Text(theme.fg("toolTitle", "search ") + theme.fg("accent", `"${display}"`), 0, 0);
    },
    
    renderResult(result, _opts, theme) {
      const count = (result.details as any)?.resultCount || 0;
      return new Text(theme.fg("success", `${count} results`), 0, 0);
    }
  });

  pi.registerTool({
    name: "get_search_results",
    label: "Get Search Results",
    description: "Retrieve previous search results by ID",
    parameters: Type.Object({
      searchId: Type.String()
    }),
    
    async execute(_id, params) {
      cleanup();

      const cached = getCacheEntry(params.searchId);
      if (!cached) {
        return {
          content: [{ type: "text", text: "Search not found" }],
          details: { searchId: params.searchId, error: "Search not found" }
        } as AgentToolResult<GetResultsDetails>;
      }

      // Update lastAccessed (LRU behavior)
      cached.lastAccessed = Date.now();

      const limitText = cached.limit !== undefined ? ` (limit: ${cached.limit})` : "";
      return {
        content: [{ type: "text", text: `Query: "${cached.query}"${limitText}\n\n${formatSearchResults(cached.results)}` }],
        details: { searchId: params.searchId, query: cached.query, resultCount: cached.results.length }
      } as AgentToolResult<GetResultsDetails>;
    }
  });
}
