package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type RuntimeToolsHandler struct {
	runtimeSecret     string
	webSearchProvider string
	webSearchEndpoint string
	webSearchTimeout  time.Duration
}

type webSearchRequest struct {
	Query      string `json:"query"`
	MaxResults int    `json:"maxResults"`
}

type webSearchItem struct {
	Title   string `json:"title"`
	Snippet string `json:"snippet"`
	URL     string `json:"url"`
}

type webSearchResponse struct {
	Query     string          `json:"query"`
	Engine    string          `json:"engine"`
	Results   []webSearchItem `json:"results"`
	Total     int             `json:"total"`
	Note      string          `json:"note,omitempty"`
	ErrorType string          `json:"errorType,omitempty"`
}

type duckResponse struct {
	Heading       string      `json:"Heading"`
	AbstractText  string      `json:"AbstractText"`
	AbstractURL   string      `json:"AbstractURL"`
	RelatedTopics []duckTopic `json:"RelatedTopics"`
}

type duckTopic struct {
	Text     string      `json:"Text"`
	FirstURL string      `json:"FirstURL"`
	Topics   []duckTopic `json:"Topics"`
}

func NewRuntimeToolsHandler(runtimeSecret, provider, endpoint string, timeoutMs int) *RuntimeToolsHandler {
	if timeoutMs <= 0 {
		timeoutMs = 12000
	}
	return &RuntimeToolsHandler{
		runtimeSecret:     runtimeSecret,
		webSearchProvider: strings.ToLower(strings.TrimSpace(provider)),
		webSearchEndpoint: strings.TrimSpace(endpoint),
		webSearchTimeout:  time.Duration(timeoutMs) * time.Millisecond,
	}
}

func (h *RuntimeToolsHandler) WebSearch(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("X-Runtime-Secret") != h.runtimeSecret {
		writeError(w, http.StatusUnauthorized, "invalid runtime secret")
		return
	}

	var req webSearchRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	query := strings.TrimSpace(req.Query)
	if query == "" {
		writeError(w, http.StatusBadRequest, "query is required")
		return
	}

	limit := req.MaxResults
	if limit <= 0 {
		limit = 5
	}
	if limit > 10 {
		limit = 10
	}

	resp, err := h.search(r.Context(), query, limit)
	if err != nil {
		writeJSON(w, http.StatusOK, webSearchResponse{
			Query:     query,
			Engine:    h.webSearchProviderOrDefault(),
			Results:   []webSearchItem{},
			Total:     0,
			Note:      err.Error(),
			ErrorType: classifySearchError(err),
		})
		return
	}

	writeJSON(w, http.StatusOK, resp)
}

func (h *RuntimeToolsHandler) search(ctx context.Context, query string, limit int) (webSearchResponse, error) {
	switch h.webSearchProviderOrDefault() {
	case "duckduckgo":
		return h.searchDuckDuckGo(ctx, query, limit)
	default:
		return webSearchResponse{
			Query:   query,
			Engine:  h.webSearchProviderOrDefault(),
			Results: []webSearchItem{},
			Total:   0,
		}, fmt.Errorf("unsupported web search provider: %s", h.webSearchProviderOrDefault())
	}
}

func (h *RuntimeToolsHandler) webSearchProviderOrDefault() string {
	if h.webSearchProvider == "" {
		return "duckduckgo"
	}
	return h.webSearchProvider
}

func (h *RuntimeToolsHandler) searchDuckDuckGo(ctx context.Context, query string, limit int) (webSearchResponse, error) {
	baseURL := h.webSearchEndpoint
	if baseURL == "" {
		baseURL = "https://api.duckduckgo.com/"
	}
	u, err := url.Parse(baseURL)
	if err != nil {
		return webSearchResponse{}, fmt.Errorf("invalid duckduckgo endpoint: %w", err)
	}
	q := u.Query()
	q.Set("q", query)
	q.Set("format", "json")
	q.Set("no_html", "1")
	q.Set("skip_disambig", "1")
	u.RawQuery = q.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return webSearchResponse{}, fmt.Errorf("create upstream request failed: %w", err)
	}
	req.Header.Set("User-Agent", "next-ai-agent-gateway/0.1 (+web-search)")

	client := &http.Client{Timeout: h.webSearchTimeout}
	upstreamResp, err := client.Do(req)
	if err != nil {
		return webSearchResponse{}, fmt.Errorf("duckduckgo request failed: %w", err)
	}
	defer upstreamResp.Body.Close()

	if upstreamResp.StatusCode < 200 || upstreamResp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(upstreamResp.Body, 2048))
		detail := strings.TrimSpace(string(body))
		if detail == "" {
			detail = upstreamResp.Status
		}
		return webSearchResponse{}, fmt.Errorf("duckduckgo http %d: %s", upstreamResp.StatusCode, detail)
	}

	var duck duckResponse
	if err := json.NewDecoder(upstreamResp.Body).Decode(&duck); err != nil {
		return webSearchResponse{}, fmt.Errorf("decode duckduckgo response failed: %w", err)
	}

	items := make([]webSearchItem, 0, limit+2)
	if strings.TrimSpace(duck.AbstractText) != "" && strings.TrimSpace(duck.AbstractURL) != "" {
		title := strings.TrimSpace(duck.Heading)
		if title == "" {
			title = query
		}
		items = append(items, webSearchItem{
			Title:   title,
			Snippet: strings.TrimSpace(duck.AbstractText),
			URL:     strings.TrimSpace(duck.AbstractURL),
		})
	}
	collectDuckTopics(&items, duck.RelatedTopics)

	uniq := make([]webSearchItem, 0, len(items))
	seen := make(map[string]struct{}, len(items))
	for _, item := range items {
		key := strings.TrimSpace(item.URL)
		if key == "" {
			continue
		}
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		uniq = append(uniq, item)
		if len(uniq) >= limit {
			break
		}
	}

	resp := webSearchResponse{
		Query:   query,
		Engine:  "duckduckgo",
		Results: uniq,
		Total:   len(uniq),
	}
	if len(uniq) == 0 {
		resp.Note = "No public web results found"
	}
	return resp, nil
}

func collectDuckTopics(items *[]webSearchItem, topics []duckTopic) {
	for _, topic := range topics {
		if len(topic.Topics) > 0 {
			collectDuckTopics(items, topic.Topics)
			continue
		}
		text := strings.TrimSpace(topic.Text)
		link := strings.TrimSpace(topic.FirstURL)
		if text == "" || link == "" {
			continue
		}
		title, snippet := splitDuckText(text)
		*items = append(*items, webSearchItem{
			Title:   title,
			Snippet: snippet,
			URL:     link,
		})
	}
}

func splitDuckText(text string) (string, string) {
	parts := strings.SplitN(text, " - ", 2)
	if len(parts) == 2 {
		title := strings.TrimSpace(parts[0])
		snippet := strings.TrimSpace(parts[1])
		if title == "" {
			title = strings.TrimSpace(text)
		}
		if snippet == "" {
			snippet = strings.TrimSpace(text)
		}
		return title, snippet
	}
	trimmed := strings.TrimSpace(text)
	return trimmed, trimmed
}

func classifySearchError(err error) string {
	msg := strings.ToLower(strings.TrimSpace(err.Error()))
	if strings.Contains(msg, "timeout") || errors.Is(err, context.DeadlineExceeded) {
		return "timeout"
	}
	if strings.Contains(msg, "connection refused") ||
		strings.Contains(msg, "no such host") ||
		strings.Contains(msg, "network is unreachable") ||
		strings.Contains(msg, "i/o timeout") {
		return "network"
	}
	if strings.Contains(msg, "http 429") {
		return "rate_limit"
	}
	if strings.Contains(msg, "http 5") {
		return "upstream_5xx"
	}
	if strings.Contains(msg, "unsupported web search provider") {
		return "config"
	}
	return "unknown"
}
