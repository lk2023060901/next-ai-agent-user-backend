import { tool } from "ai";
import { z } from "zod";
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
        const snippet = typeof item.snippet === "string" ? item.snippet.trim() : "";
        const url = typeof item.url === "string" ? item.url.trim() : "";
        if (!title && !snippet && !url)
            continue;
        normalized.push({
            title: title || snippet || "(untitled)",
            snippet: snippet || title || "",
            url,
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
export function makeWebSearchTool() {
    return tool({
        description: "Search the public web for up-to-date information. Prefer concise, source-linked results.",
        parameters: z.object({
            query: z.string().describe("Search query"),
            maxResults: z.number().optional().default(5).describe("Maximum number of results"),
        }),
        execute: async ({ query, maxResults }) => {
            const safeQuery = query.trim();
            const limit = clampResults(maxResults);
            if (!safeQuery) {
                return {
                    query: safeQuery,
                    engine: "gateway",
                    results: [],
                    total: 0,
                    note: "Empty query",
                    errorType: "invalid_request",
                };
            }
            const url = `${config.gatewayAddr.replace(/\/+$/, "")}/internal/tools/web-search`;
            const payload = JSON.stringify({ query: safeQuery, maxResults: limit });
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
                        engine: "gateway",
                        results: [],
                        total: 0,
                        note: `Gateway web search HTTP ${response.status}: ${detail}`,
                        errorType: response.status === 401 ? "auth" : classifyFailure(detail),
                    };
                }
                const results = parseItems(parsed.results, limit);
                const note = typeof parsed.note === "string" ? parsed.note : undefined;
                const errorType = typeof parsed.errorType === "string" ? parsed.errorType : undefined;
                const engine = typeof parsed.engine === "string" && parsed.engine.trim() ? parsed.engine : "gateway";
                return {
                    query: safeQuery,
                    engine,
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
                    engine: "gateway",
                    results: [],
                    total: 0,
                    note: `Gateway web search request failed: ${msg}`,
                    errorType: classifyFailure(msg),
                };
            }
        },
    });
}
