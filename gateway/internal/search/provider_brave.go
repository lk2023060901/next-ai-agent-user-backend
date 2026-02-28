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

type BraveProvider struct {
	endpoint string
	apiKey   string
	client   *http.Client
}

func NewBraveProvider(endpoint, apiKey string, timeout time.Duration) *BraveProvider {
	if strings.TrimSpace(endpoint) == "" {
		endpoint = "https://api.search.brave.com/res/v1/web/search"
	}
	if timeout <= 0 {
		timeout = 12 * time.Second
	}
	return &BraveProvider{
		endpoint: endpoint,
		apiKey:   strings.TrimSpace(apiKey),
		client:   &http.Client{Timeout: timeout},
	}
}

func (p *BraveProvider) Name() string {
	return ProviderBrave
}

type braveResponse struct {
	Web struct {
		Results []struct {
			Title       string `json:"title"`
			URL         string `json:"url"`
			Description string `json:"description"`
			Age         string `json:"age"`
			PageAge     string `json:"page_age"`
			MetaURL     struct {
				Hostname string `json:"hostname"`
			} `json:"meta_url"`
		} `json:"results"`
	} `json:"web"`
}

func (p *BraveProvider) Search(ctx context.Context, query Query) (Response, error) {
	if p.apiKey == "" {
		return Response{}, NewTypedError(ErrorTypeConfig, fmt.Errorf("brave api key is missing"))
	}

	q := query.Normalize()
	u, err := url.Parse(p.endpoint)
	if err != nil {
		return Response{}, NewTypedError(ErrorTypeConfig, fmt.Errorf("invalid brave endpoint: %w", err))
	}

	params := u.Query()
	params.Set("q", q.Query)
	params.Set("count", fmt.Sprintf("%d", q.Count))
	if q.Country != "" {
		params.Set("country", q.Country)
	}
	if q.SearchLang != "" {
		params.Set("search_lang", q.SearchLang)
	}
	if q.Freshness != "" {
		params.Set("freshness", q.Freshness)
	}
	u.RawQuery = params.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return Response{}, NewTypedError(ErrorTypeUnknown, fmt.Errorf("create brave request failed: %w", err))
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("X-Subscription-Token", p.apiKey)
	req.Header.Set("User-Agent", "next-ai-agent-gateway/0.1 (+web-search)")

	res, err := p.client.Do(req)
	if err != nil {
		return Response{}, NewTypedError(ErrorTypeNetwork, fmt.Errorf("brave request failed: %w", err))
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
		return Response{}, NewTypedError(errorType, fmt.Errorf("brave http %d: %s", res.StatusCode, detail))
	}

	var payload braveResponse
	if err := json.NewDecoder(res.Body).Decode(&payload); err != nil {
		return Response{}, NewTypedError(ErrorTypeUnknown, fmt.Errorf("decode brave response failed: %w", err))
	}

	results := make([]ResultItem, 0, q.Count)
	for _, row := range payload.Web.Results {
		title := strings.TrimSpace(row.Title)
		link := strings.TrimSpace(row.URL)
		desc := strings.TrimSpace(row.Description)
		if title == "" && link == "" && desc == "" {
			continue
		}
		published := strings.TrimSpace(row.PageAge)
		if published == "" {
			published = strings.TrimSpace(row.Age)
		}
		results = append(results, ResultItem{
			Title:       title,
			URL:         link,
			Description: desc,
			Published:   published,
			SiteName:    strings.TrimSpace(row.MetaURL.Hostname),
		})
		if len(results) >= q.Count {
			break
		}
	}

	out := Response{
		Query:    q.Query,
		Provider: ProviderBrave,
		Results:  uniqueByURL(results, q.Count),
	}
	out.Total = len(out.Results)
	if out.Total == 0 {
		out.Note = "No public web results found"
	}
	return out, nil
}
