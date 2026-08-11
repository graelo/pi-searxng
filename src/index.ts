import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import type { SearchResult } from "./searxng.js";
import { search } from "./searxng.js";
import {
  DEFAULT_CONFIG,
  loadConfigForSession,
  type Config,
} from "./config.js";

interface CacheEntry {
  results: SearchResult[];
  createdAt: number;
  lastAccessed: number;
}

interface WebSearchSuccessDetails {
  resultCount: number;
  query: string;
}

interface WebSearchErrorDetails {
  error: string;
}

type WebSearchDetails = WebSearchSuccessDetails | WebSearchErrorDetails;

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

// Configuration is initialized with defaults until session_start, when Pi has
// resolved project trust and the session-specific config can be loaded safely.
let config: Config = { ...DEFAULT_CONFIG };
let cacheFreshnessMs = config.cacheFreshnessMs;
let cacheTtlMs = config.cacheTtlMs;
let maxCacheSize = config.cacheMaxSize;

function applyConfig(loaded: ReturnType<typeof loadConfigForSession>): void {
  config = loaded.config;
  cacheFreshnessMs = config.cacheFreshnessMs;
  cacheTtlMs = config.cacheTtlMs;
  maxCacheSize = config.cacheMaxSize;

  for (const problem of loaded.diagnostics) {
    console.warn(problem);
  }
  for (const notice of loaded.notices) {
    console.info(notice);
  }
}

function cleanup(): void {
  const now = Date.now();

  // Remove expired entries
  for (const [id, entry] of searchCache) {
    if (now - entry.lastAccessed > cacheTtlMs) {
      searchCache.delete(id);
    }
  }

  // Evict oldest entries if over limit
  while (searchCache.size > maxCacheSize) {
    const firstKey = searchCache.keys().next().value;
    if (firstKey) searchCache.delete(firstKey);
  }
}

function getCacheKey(query: string, limit?: number): string {
  return `${query}\u0000${limit ?? ""}`;
}

function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) return "No results found.";
  return results.map((r, i) => 
    `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet.slice(0, 200)}${r.snippet.length > 200 ? "..." : ""}`
  ).join("\n\n");
}

export default function (pi: ExtensionAPI) {
  // Project-tier configuration is deferred until this event because trust is
  // only available on the session context. Global configuration is still used
  // when the project is untrusted.
  pi.on("session_start", (_event, ctx) => {
    const sessionContext = {
      cwd: ctx.cwd,
      isProjectTrusted: () =>
        (ctx as typeof ctx & { isProjectTrusted?: () => boolean })
          .isProjectTrusted?.() === true,
    };
    applyConfig(loadConfigForSession(sessionContext));
  });

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

      const cacheKey = getCacheKey(params.query, limit);

      if (signal?.aborted) {
        return {
          content: [{ type: "text", text: "Aborted" }],
          details: { error: "Aborted" }
        } as AgentToolResult<WebSearchDetails>;
      }

      try {
        cleanup();
        const cached = getCacheEntry(cacheKey);
        const isStale = cached && (Date.now() - cached.createdAt > cacheFreshnessMs);

        let results: SearchResult[];

        if (cached && !isStale) {
          // Fresh cache → return directly
          cached.lastAccessed = Date.now();
          results = cached.results;
        } else {
          // Not found or stale → search SearXNG
          const { results: newResults } = await search(params.query, limit, config);
          results = newResults;
          searchCache.set(cacheKey, {
            results,
            createdAt: isStale ? Date.now() : (cached?.createdAt || Date.now()),
            lastAccessed: Date.now()
          });
        }

        return {
          content: [{ type: "text", text: warningNote + formatSearchResults(results) }],
          details: { resultCount: results.length, query: params.query }
        } as AgentToolResult<WebSearchDetails>;
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          details: { error: String(err) }
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

}
