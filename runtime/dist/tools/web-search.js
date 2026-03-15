import { Type } from "@sinclair/typebox";
import { config } from "../config.js";
function clampResults(value) {
    const parsed = Math.floor(value ?? 5);
    if (!Number.isFinite(parsed))
        return 5;
    return Math.max(1, Math.min(10, parsed));
}
function parseItems(raw, limit) {
    if (!Array.isArray(raw))
        return [];
    const normalized = [];
    for (const row of raw) {
        if (!row || typeof row !== "object")
            continue;
        const item = row;
        const title = typeof item.title === "string" ? item.title.trim() : "";
        const snippetRaw = typeof item.snippet === "string"
            ? item.snippet
            : typeof item.description === "string"
                ? item.description
                : "";
        const snippet = snippetRaw.trim();
        const url = typeof item.url === "string" ? item.url.trim() : "";
        const published = typeof item.published === "string" ? item.published.trim() : "";
        const siteName = typeof item.siteName === "string" ? item.siteName.trim() : "";
        if (!title && !snippet && !url)
            continue;
        normalized.push({
            title: title || snippet || "(untitled)",
            snippet: snippet || title || "",
            url,
            ...(published ? { published } : {}),
            ...(siteName ? { siteName } : {}),
        });
        if (normalized.length >= limit)
            break;
    }
    return normalized;
}
function classifyFailure(msg) {
    const s = msg.toLowerCase();
    if (s.includes("timeout"))
        return "timeout";
    if (s.includes("connection refused") ||
        s.includes("network") ||
        s.includes("no such host") ||
        s.includes("failed to fetch")) {
        return "network";
    }
    if (s.includes("429"))
        return "rate_limit";
    if (s.includes("5"))
        return "upstream_5xx";
    return "unknown";
}
const WebSearchParams = Type.Object({
    query: Type.String({ description: "Search query" }),
    count: Type.Optional(Type.Number({ description: "Maximum number of results", default: 5 })),
    maxResults: Type.Optional(Type.Number({ description: "Deprecated alias for count" })),
    provider: Type.Optional(Type.Union([
        Type.Literal("auto"),
        Type.Literal("duckduckgo"),
        Type.Literal("brave"),
        Type.Literal("searxng"),
        Type.Literal("serpapi"),
    ], { description: "Search provider selection" })),
    country: Type.Optional(Type.String({ description: "Optional country code (e.g. us, cn)" })),
    search_lang: Type.Optional(Type.String({ description: "Optional search language code (e.g. en, zh)" })),
    freshness: Type.Optional(Type.Union([
        Type.Literal("pd"),
        Type.Literal("pw"),
        Type.Literal("pm"),
        Type.Literal("py"),
    ], { description: "Optional freshness window: day/week/month/year" })),
});
export function makeWebSearchTool() {
    return {
        name: "web_search",
        description: "Search the public web for up-to-date information. Prefer concise, source-linked results.",
        parameters: WebSearchParams,
        category: "api",
        riskLevel: "low",
        execute: async (args) => {
            const safeQuery = (args.query ?? "").trim();
            const limit = clampResults(args.count ?? args.maxResults);
            if (!safeQuery) {
                return {
                    query: safeQuery,
                    provider: "gateway",
                    results: [],
                    total: 0,
                    note: "Empty query",
                    errorType: "invalid_request",
                };
            }
            const url = `${config.gatewayAddr.replace(/\/+$/, "")}/internal/tools/web-search`;
            const payload = JSON.stringify({
                query: safeQuery,
                count: limit,
                provider: args.provider ?? "auto",
                ...(args.country ? { country: args.country } : {}),
                ...(args.search_lang ? { search_lang: args.search_lang } : {}),
                ...(args.freshness ? { freshness: args.freshness } : {}),
            });
            try {
                const response = await fetch(url, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "X-Runtime-Secret": config.runtimeSecret,
                    },
                    body: payload,
                    signal: AbortSignal.timeout(15000),
                });
                const bodyText = await response.text();
                let parsed = {};
                try {
                    parsed = (bodyText ? JSON.parse(bodyText) : {});
                }
                catch {
                    parsed = {};
                }
                if (!response.ok) {
                    const detail = bodyText.trim() || response.statusText || "Gateway web search failed";
                    return {
                        query: safeQuery,
                        provider: "gateway",
                        results: [],
                        total: 0,
                        note: `Gateway web search HTTP ${response.status}: ${detail}`,
                        errorType: response.status === 401 ? "auth" : classifyFailure(detail),
                    };
                }
                const results = parseItems(parsed.results, limit);
                const note = typeof parsed.note === "string" ? parsed.note : undefined;
                const errorType = typeof parsed.errorType === "string" ? parsed.errorType : undefined;
                const resolvedProvider = typeof parsed.provider === "string" && parsed.provider.trim()
                    ? parsed.provider
                    : typeof parsed.engine === "string" && parsed.engine.trim()
                        ? parsed.engine
                        : "gateway";
                return {
                    query: safeQuery,
                    provider: resolvedProvider,
                    engine: resolvedProvider,
                    results,
                    total: typeof parsed.total === "number" ? parsed.total : results.length,
                    note: results.length === 0 ? note || "No public web results found" : note,
                    errorType,
                };
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return {
                    query: safeQuery,
                    provider: "gateway",
                    results: [],
                    total: 0,
                    note: `Gateway web search request failed: ${msg}`,
                    errorType: classifyFailure(msg),
                };
            }
        },
    };
}
