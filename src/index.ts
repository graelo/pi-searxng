import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { search, type SearchResponse } from "./searxng.js";
import {
  DEFAULT_CONFIG,
  loadConfig,
  loadConfigForSession,
  type Config,
} from "./config.js";

interface CacheEntry {
  response: SearchResponse;
  createdAt: number;
  lastAccessed: number;
}

interface WebSearchSuccessDetails {
  resultCount: number;
  query: string;
  /** Engine names the search was restricted to, when requested. */
  engines?: string[];
  unresponsiveEngines?: string[];
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

function getCacheKey(query: string, limit?: number, engines?: string[]): string {
  return `${query}\u0000${limit ?? ""}\u0000${engines?.join(",") ?? ""}`;
}

// The tool schema description is built at registration time, before
// session_start resolves project trust, so only the global config tier is
// available here. Runtime validation uses the session config instead.
function enginesDescription(): string {
  let available: string[] = [];
  try {
    available = loadConfig({}).config.engines;
  } catch {
    available = [];
  }
  if (available.length > 0) {
    return `Restrict the search to specific engines by name. Available on this instance: ${available.join(", ")}.`;
  }
  return "Restrict the search to specific SearXNG engine names, e.g. \"duckduckgo\", \"wikipedia\" (passed to SearXNG as-is).";
}

function formatSearchResponse(response: SearchResponse): string {
  const parts: string[] = [];

  if (response.results.length > 0) {
    parts.push(
      response.results
        .map((r, i) =>
          `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet.slice(0, 200)}${r.snippet.length > 200 ? "..." : ""}`
        )
        .join("\n\n")
    );
  } else {
    // SearXNG sometimes finds answers or infoboxes without any web results;
    // surface those instead of a bare "no results".
    const fallback = [
      ...response.answers.map((a) => `Answer: ${a}`),
      ...response.infoboxes.map(
        (b) => `**${b.title}**\n   ${b.content}${b.url ? `\n   ${b.url}` : ""}`
      )
    ];
    parts.push(fallback.length > 0 ? fallback.join("\n\n") : "No results found.");
  }

  // Empty result lists are often caused by upstream engines being
  // rate-limited or blocked; report which engines failed so it's diagnosable.
  if (response.unresponsiveEngines.length > 0) {
    parts.push(
      `Note: ${response.unresponsiveEngines.length} search engine(s) unresponsive: ${response.unresponsiveEngines.join(", ")}`
    );
  }

  return parts.join("\n\n");
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
      limit: Type.Optional(Type.Number({ description: "Max results to return" })),
      engines: Type.Optional(
        Type.Array(Type.String(), { description: enginesDescription() })
      )
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

      // Sanitize and validate engine selection against the configured list.
      // The list is the source of truth: unknown names must not reach SearXNG,
      // which silently ignores them and would search every engine while the
      // model believes it restricted the search.
      const rawEngines: unknown[] = Array.isArray(params.engines) ? params.engines : [];
      const requestedEngines = [...new Set(
        rawEngines.map((e) => String(e).trim()).filter(Boolean)
      )];
      let engines: string[] | undefined;
      if (requestedEngines.length > 0) {
        if (config.engines.length > 0) {
          const known = requestedEngines.filter((e) => config.engines.includes(e));
          const unknown = requestedEngines.filter((e) => !config.engines.includes(e));
          if (unknown.length > 0) {
            warningNote +=
              `Note: engine(s) not available on this instance were ignored: ${unknown.join(", ")}. ` +
              `Available: ${config.engines.join(", ")}.\n\n`;
          }
          if (known.length === 0) {
            return {
              content: [{
                type: "text",
                text:
                  `Error: none of the requested engines (${requestedEngines.join(", ")}) ` +
                  `are available on this instance. Available engines: ${config.engines.join(", ")}.`
              }],
              details: { error: "engines not available" }
            } as AgentToolResult<WebSearchDetails>;
          }
          engines = known;
        } else {
          // No configured list: pass through unvalidated.
          engines = requestedEngines;
        }
      }

      const cacheKey = getCacheKey(params.query, limit, engines);

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

        let response: SearchResponse;

        if (cached && !isStale) {
          // Fresh cache → return directly
          cached.lastAccessed = Date.now();
          response = cached.response;
        } else {
          // Not found or stale → search SearXNG
          response = await search(params.query, limit, engines, config);
          if (response.results.length > 0) {
            searchCache.set(cacheKey, {
              response,
              createdAt: isStale ? Date.now() : (cached?.createdAt || Date.now()),
              lastAccessed: Date.now()
            });
          } else if (cached) {
            // Empty results are often a transient upstream failure (engines
            // rate-limited or blocked). Never cache them as fresh — and drop
            // the stale entry so the next call searches again instead of
            // serving an outdated empty list.
            searchCache.delete(cacheKey);
          }
        }

        return {
          content: [{ type: "text", text: warningNote + formatSearchResponse(response) }],
          details: {
            resultCount: response.results.length,
            query: params.query,
            ...(engines ? { engines } : {}),
            ...(response.unresponsiveEngines.length > 0
              ? { unresponsiveEngines: response.unresponsiveEngines }
              : {})
          }
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
      const engines = ((args as any).engines as unknown[] | undefined)?.filter(Boolean) ?? [];
      const tag = engines.length > 0 ? ` [${engines.join(",")}]` : "";
      return new Text(
        theme.fg("toolTitle", "search ") +
          theme.fg("accent", `"${display}"`) +
          theme.fg("toolTitle", tag),
        0, 0
      );
    },
    
    renderResult(result, _opts, theme) {
      const count = (result.details as any)?.resultCount || 0;
      return new Text(theme.fg("success", `${count} results`), 0, 0);
    }
  });

}
