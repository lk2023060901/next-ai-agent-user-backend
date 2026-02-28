import { tool } from "ai";
import { z } from "zod";
function pushIfValid(items, candidate) {
    if (!candidate || typeof candidate !== "object")
        return;
    const obj = candidate;
    const text = typeof obj.Text === "string" ? obj.Text.trim() : "";
    const url = typeof obj.FirstURL === "string" ? obj.FirstURL.trim() : "";
    if (!text || !url)
        return;
    const [title, ...rest] = text.split(" - ");
    items.push({
        title: (title || text).trim(),
        snippet: rest.join(" - ").trim() || text,
        url,
    });
}
function collectRelated(items, related) {
    if (!Array.isArray(related))
        return;
    for (const entry of related) {
        if (!entry || typeof entry !== "object")
            continue;
        const obj = entry;
        // DuckDuckGo can return nested groups with Topics: []
        if (Array.isArray(obj.Topics)) {
            collectRelated(items, obj.Topics);
            continue;
        }
        pushIfValid(items, obj);
    }
}
export function makeWebSearchTool() {
    return tool({
        description: "Search the public web for up-to-date information. Prefer concise, source-linked results.",
        parameters: z.object({
            query: z.string().describe("Search query"),
            maxResults: z.number().optional().default(5).describe("Maximum number of results"),
        }),
        execute: async ({ query, maxResults }) => {
            const safeQuery = query.trim();
            const limit = Math.max(1, Math.min(10, Math.floor(maxResults ?? 5)));
            if (!safeQuery) {
                return {
                    query: safeQuery,
                    engine: "duckduckgo",
                    results: [],
                    total: 0,
                    note: "Empty query",
                };
            }
            try {
                const url = new URL("https://api.duckduckgo.com/");
                url.searchParams.set("q", safeQuery);
                url.searchParams.set("format", "json");
                url.searchParams.set("no_html", "1");
                url.searchParams.set("skip_disambig", "1");
                const response = await fetch(url, {
                    signal: AbortSignal.timeout(12000),
                    headers: {
                        "User-Agent": "next-ai-agent-runtime/0.1 (+web-search-tool)",
                    },
                });
                if (!response.ok) {
                    return {
                        query: safeQuery,
                        engine: "duckduckgo",
                        results: [],
                        total: 0,
                        note: `Web search HTTP ${response.status}`,
                    };
                }
                const payload = (await response.json());
                const items = [];
                // Abstract section
                const abstractText = typeof payload.AbstractText === "string" ? payload.AbstractText.trim() : "";
                const abstractUrl = typeof payload.AbstractURL === "string" ? payload.AbstractURL.trim() : "";
                const heading = typeof payload.Heading === "string" ? payload.Heading.trim() : "";
                if (abstractText && abstractUrl) {
                    items.push({
                        title: heading || safeQuery,
                        snippet: abstractText,
                        url: abstractUrl,
                    });
                }
                collectRelated(items, payload.RelatedTopics);
                const uniq = new Map();
                for (const item of items) {
                    if (!uniq.has(item.url))
                        uniq.set(item.url, item);
                }
                const results = [...uniq.values()].slice(0, limit);
                return {
                    query: safeQuery,
                    engine: "duckduckgo",
                    results,
                    total: results.length,
                    note: results.length === 0 ? "No public web results found" : undefined,
                };
            }
            catch (err) {
                return {
                    query: safeQuery,
                    engine: "duckduckgo",
                    results: [],
                    total: 0,
                    note: err instanceof Error ? err.message : String(err),
                };
            }
        },
    });
}
