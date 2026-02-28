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

type SearxngProvider struct {
	endpoint string
	apiKey   string
	client   *http.Client
}

func NewSearxngProvider(endpoint, apiKey string, timeout time.Duration) *SearxngProvider {
	if timeout <= 0 {
		timeout = 12 * time.Second
	}
	return &SearxngProvider{
		endpoint: strings.TrimSpace(endpoint),
		apiKey:   strings.TrimSpace(apiKey),
		client:   &http.Client{Timeout: timeout},
	}
}

func (p *SearxngProvider) Name() string {
	return ProviderSearxng
}

type searxngResponse struct {
	Results []struct {
		Title         string `json:"title"`
		URL           string `json:"url"`
		Content       string `json:"content"`
		PublishedDate string `json:"publishedDate"`
		Engine        string `json:"engine"`
	} `json:"results"`
}

func (p *SearxngProvider) Search(ctx context.Context, query Query) (Response, error) {
	if p.endpoint == "" {
		return Response{}, NewTypedError(ErrorTypeConfig, fmt.Errorf("searxng endpoint is missing"))
	}

	q := query.Normalize()
	u, err := url.Parse(p.endpoint)
	if err != nil {
		return Response{}, NewTypedError(ErrorTypeConfig, fmt.Errorf("invalid searxng endpoint: %w", err))
	}
	if strings.TrimSpace(u.Path) == "" || strings.TrimSpace(u.Path) == "/" {
		u.Path = "/search"
	}

	params := u.Query()
	params.Set("q", q.Query)
	params.Set("format", "json")
	params.Set("pageno", "1")
	if q.SearchLang != "" {
		params.Set("language", q.SearchLang)
	}
	if q.Country != "" {
		params.Set("region", q.Country)
	}
	u.RawQuery = params.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return Response{}, NewTypedError(ErrorTypeUnknown, fmt.Errorf("create searxng request failed: %w", err))
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "next-ai-agent-gateway/0.1 (+web-search)")
	if p.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+p.apiKey)
	}

	res, err := p.client.Do(req)
	if err != nil {
		return Response{}, NewTypedError(ErrorTypeNetwork, fmt.Errorf("searxng request failed: %w", err))
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
		return Response{}, NewTypedError(errorType, fmt.Errorf("searxng http %d: %s", res.StatusCode, detail))
	}

	var payload searxngResponse
	if err := json.NewDecoder(res.Body).Decode(&payload); err != nil {
		return Response{}, NewTypedError(ErrorTypeUnknown, fmt.Errorf("decode searxng response failed: %w", err))
	}

	results := make([]ResultItem, 0, q.Count)
	for _, row := range payload.Results {
		title := strings.TrimSpace(row.Title)
		link := strings.TrimSpace(row.URL)
		desc := strings.TrimSpace(row.Content)
		if title == "" && link == "" && desc == "" {
			continue
		}
		results = append(results, ResultItem{
			Title:       title,
			URL:         link,
			Description: desc,
			Published:   strings.TrimSpace(row.PublishedDate),
			SiteName:    strings.TrimSpace(row.Engine),
		})
		if len(results) >= q.Count {
			break
		}
	}

	out := Response{
		Query:    q.Query,
		Provider: ProviderSearxng,
		Results:  uniqueByURL(results, q.Count),
	}
	out.Total = len(out.Results)
	if out.Total == 0 {
		out.Note = "No public web results found"
	}
	return out, nil
}
