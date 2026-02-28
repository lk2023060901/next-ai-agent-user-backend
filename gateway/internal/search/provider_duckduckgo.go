package search

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type DuckDuckGoProvider struct {
	endpoint string
	client   *http.Client
}

func NewDuckDuckGoProvider(endpoint string, timeout time.Duration) *DuckDuckGoProvider {
	if strings.TrimSpace(endpoint) == "" {
		endpoint = "https://api.duckduckgo.com/"
	}
	if timeout <= 0 {
		timeout = 12 * time.Second
	}
	return &DuckDuckGoProvider{
		endpoint: endpoint,
		client:   &http.Client{Timeout: timeout},
	}
}

func (p *DuckDuckGoProvider) Name() string {
	return ProviderDuckDuckGo
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

func (p *DuckDuckGoProvider) Search(ctx context.Context, query Query) (Response, error) {
	q := query.Normalize()
	u, err := url.Parse(p.endpoint)
	if err != nil {
		return Response{}, NewTypedError(ErrorTypeConfig, fmt.Errorf("invalid duckduckgo endpoint: %w", err))
	}
	params := u.Query()
	params.Set("q", q.Query)
	params.Set("format", "json")
	params.Set("no_html", "1")
	params.Set("skip_disambig", "1")
	u.RawQuery = params.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return Response{}, NewTypedError(ErrorTypeUnknown, fmt.Errorf("create duckduckgo request failed: %w", err))
	}
	req.Header.Set("User-Agent", "next-ai-agent-gateway/0.1 (+web-search)")

	res, err := p.client.Do(req)
	if err != nil {
		return Response{}, NewTypedError(ErrorTypeNetwork, fmt.Errorf("duckduckgo request failed: %w", err))
	}
	defer res.Body.Close()

	if res.StatusCode < 200 || res.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(res.Body, 2048))
		detail := strings.TrimSpace(string(body))
		if detail == "" {
			detail = res.Status
		}
		errorType := ErrorTypeUnknown
		if res.StatusCode == http.StatusTooManyRequests {
			errorType = ErrorTypeRateLimit
		} else if res.StatusCode >= 500 {
			errorType = ErrorTypeUpstream5xx
		}
		return Response{}, NewTypedError(errorType, fmt.Errorf("duckduckgo http %d: %s", res.StatusCode, detail))
	}

	var payload duckResponse
	if err := json.NewDecoder(res.Body).Decode(&payload); err != nil {
		return Response{}, NewTypedError(ErrorTypeUnknown, fmt.Errorf("decode duckduckgo response failed: %w", err))
	}

	items := make([]ResultItem, 0, q.Count+2)
	if strings.TrimSpace(payload.AbstractText) != "" && strings.TrimSpace(payload.AbstractURL) != "" {
		title := strings.TrimSpace(payload.Heading)
		if title == "" {
			title = q.Query
		}
		items = append(items, ResultItem{
			Title:       title,
			URL:         strings.TrimSpace(payload.AbstractURL),
			Description: strings.TrimSpace(payload.AbstractText),
		})
	}
	collectDuckTopics(&items, payload.RelatedTopics)
	items = uniqueByURL(items, q.Count)

	out := Response{
		Query:    q.Query,
		Provider: ProviderDuckDuckGo,
		Results:  items,
		Total:    len(items),
	}
	if len(items) == 0 {
		out.Note = "No public web results found"
	}
	return out, nil
}

func collectDuckTopics(items *[]ResultItem, topics []duckTopic) {
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
		title, desc := splitDuckText(text)
		*items = append(*items, ResultItem{
			Title:       title,
			URL:         link,
			Description: desc,
		})
	}
}

func splitDuckText(text string) (string, string) {
	parts := strings.SplitN(text, " - ", 2)
	if len(parts) == 2 {
		title := strings.TrimSpace(parts[0])
		desc := strings.TrimSpace(parts[1])
		if title == "" {
			title = strings.TrimSpace(text)
		}
		if desc == "" {
			desc = strings.TrimSpace(text)
		}
		return title, desc
	}
	t := strings.TrimSpace(text)
	return t, t
}

func uniqueByURL(items []ResultItem, limit int) []ResultItem {
	if limit <= 0 {
		limit = 5
	}
	seen := make(map[string]struct{}, len(items))
	out := make([]ResultItem, 0, min(limit, len(items)))
	for _, item := range items {
		key := strings.TrimSpace(item.URL)
		if key == "" {
			continue
		}
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, item)
		if len(out) >= limit {
			break
		}
	}
	return out
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
