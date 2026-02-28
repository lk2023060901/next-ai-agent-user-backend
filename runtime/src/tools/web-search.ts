import { tool } from "ai";
import { z } from "zod";
import { config } from "../config.js";

interface WebSearchItem {
  title: string;
  snippet: string;
  url: string;
  published?: string;
  siteName?: string;
}

interface GatewayWebSearchResponse {
  query?: unknown;
  provider?: unknown;
  engine?: unknown; // backward compatibility
  results?: unknown;
  total?: unknown;
  note?: unknown;
  errorType?: unknown;
}

function clampResults(value: number | undefined): number {
  const parsed = Math.floor(value ?? 5);
  if (!Number.isFinite(parsed)) return 5;
  return Math.max(1, Math.min(10, parsed));
}

function parseItems(raw: unknown, limit: number): WebSearchItem[] {
  if (!Array.isArray(raw)) return [];
  const normalized: WebSearchItem[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const item = row as Record<string, unknown>;
    const title = typeof item.title === "string" ? item.title.trim() : "";
    const snippetRaw =
      typeof item.snippet === "string"
        ? item.snippet
        : typeof item.description === "string"
          ? item.description
          : "";
    const snippet = snippetRaw.trim();
    const url = typeof item.url === "string" ? item.url.trim() : "";
    const published = typeof item.published === "string" ? item.published.trim() : "";
    const siteName = typeof item.siteName === "string" ? item.siteName.trim() : "";
    if (!title && !snippet && !url) continue;
    normalized.push({
      title: title || snippet || "(untitled)",
      snippet: snippet || title || "",
      url,
      ...(published ? { published } : {}),
      ...(siteName ? { siteName } : {}),
    });
    if (normalized.length >= limit) break;
  }
  return normalized;
}

function classifyFailure(msg: string): string {
  const s = msg.toLowerCase();
  if (s.includes("timeout")) return "timeout";
  if (
    s.includes("connection refused") ||
    s.includes("network") ||
    s.includes("no such host") ||
    s.includes("failed to fetch")
  ) {
    return "network";
  }
  if (s.includes("429")) return "rate_limit";
  if (s.includes("5")) return "upstream_5xx";
  return "unknown";
}

export function makeWebSearchTool() {
  return tool({
    description:
      "Search the public web for up-to-date information. Prefer concise, source-linked results.",
    parameters: z.object({
      query: z.string().describe("Search query"),
      count: z.number().optional().default(5).describe("Maximum number of results"),
      maxResults: z.number().optional().describe("Deprecated alias for count"),
      provider: z
        .enum(["auto", "duckduckgo", "brave", "searxng", "serpapi"])
        .optional()
        .describe("Search provider selection"),
      country: z.string().optional().describe("Optional country code (e.g. us, cn)"),
      search_lang: z.string().optional().describe("Optional search language code (e.g. en, zh)"),
      freshness: z
        .enum(["pd", "pw", "pm", "py"])
        .optional()
        .describe("Optional freshness window: day/week/month/year"),
    }),
    execute: async ({ query, count, maxResults, provider, country, search_lang, freshness }) => {
      const safeQuery = query.trim();
      const limit = clampResults(count ?? maxResults);
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
        provider: provider ?? "auto",
        ...(country ? { country } : {}),
        ...(search_lang ? { search_lang } : {}),
        ...(freshness ? { freshness } : {}),
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
        let parsed: GatewayWebSearchResponse = {};
        try {
          parsed = (bodyText ? JSON.parse(bodyText) : {}) as GatewayWebSearchResponse;
        } catch {
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
        const resolvedProvider =
          typeof parsed.provider === "string" && parsed.provider.trim()
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
      } catch (err) {
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
  });
}
