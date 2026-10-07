import type { Config } from "./config.js";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface Infobox {
  title: string;
  content: string;
  url: string;
}

export interface SearchResponse {
  results: SearchResult[];
  /** Direct answers (e.g. from answer engines / instant answers). */
  answers: string[];
  /** Infoboxes (e.g. Wikipedia summaries) returned alongside or instead of results. */
  infoboxes: Infobox[];
  /** Engines that failed to respond, as reported by SearXNG. */
  unresponsiveEngines: string[];
}

const MAX_ERROR_BODY_LENGTH = 200;

export async function search(query: string, limit: number | undefined, config: Config): Promise<SearchResponse> {
  const url = new URL(`${config.searxngUrl}/search`);

  const safesearchMap: Record<string, "0" | "1" | "2"> = {
    off: "0",
    moderate: "1",
    strict: "2"
  };

  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("safesearch", safesearchMap[config.safesearch]);
  
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  
  try {
    const res = await fetch(url.toString(), {
      signal: controller.signal,
      headers: {
        "Accept": "application/json",
        "User-Agent": "pi-searxng/1.0"
      }
    });
    
    if (!res.ok) {
      const body = (await res.text()).slice(0, MAX_ERROR_BODY_LENGTH);
      throw new Error(`SearXNG returned ${res.status} at ${url.toString()}: ${body}`);
    }

    // Read the body once as text to avoid "Body is unusable" errors when
    // trying to read it a second time after a failed res.json() call.
    const responseText = await res.text();

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      throw new Error(
        `SearXNG returned non-JSON response (Content-Type: "${contentType}") at ${url.toString()}. ` +
        `First ${MAX_ERROR_BODY_LENGTH} chars: ${responseText.slice(0, MAX_ERROR_BODY_LENGTH)}`
      );
    }

    let data;
    try {
      data = JSON.parse(responseText);
    } catch {
      throw new Error(
        `Failed to parse SearXNG response as JSON at ${url.toString()}. ` +
        `Response may be an error page. First ${MAX_ERROR_BODY_LENGTH} chars: ${responseText.slice(0, MAX_ERROR_BODY_LENGTH)}`
      );
    }
    
    const results: SearchResult[] = (data.results || [])
      .slice(0, limit || config.maxResults)
      .map((r: any) => ({
        title: r.title || "Untitled",
        url:
          typeof r.url === "string" && r.url ? r.url
          : typeof r.url_normalized === "string" && r.url_normalized ? r.url_normalized
          : "",
        snippet: r.content || r.abstract || ""
      }));

    const answers: string[] = Array.isArray(data.answers)
      ? data.answers.filter((a: unknown): a is string => typeof a === "string")
      : [];

    const infoboxes: Infobox[] = (Array.isArray(data.infoboxes) ? data.infoboxes : [])
      .map((box: any) => ({
        title: box?.infobox || box?.title || "Untitled",
        content: box?.content || "",
        url:
          typeof box?.url === "string" && box.url ? box.url
          : Array.isArray(box?.urls) && typeof box.urls[0]?.url === "string" ? box.urls[0].url
          : ""
      }));

    // SearXNG reports unresponsive engines as [name, error] pairs; older
    // versions used plain strings. Accept both so the note stays accurate.
    const unresponsiveEngines: string[] = (Array.isArray(data.unresponsive_engines)
      ? data.unresponsive_engines
      : [])
      .map((e: unknown) =>
        Array.isArray(e) && typeof e[0] === "string" ? e[0]
        : typeof e === "string" ? e
        : "")
      .filter(Boolean);

    return { results, answers, infoboxes, unresponsiveEngines };
  } finally {
    clearTimeout(timeout);
  }
}
