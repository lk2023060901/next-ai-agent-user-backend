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

type SerpAPIProvider struct {
	endpoint string
	apiKey   string
	client   *http.Client
}

func NewSerpAPIProvider(endpoint, apiKey string, timeout time.Duration) *SerpAPIProvider {
	if strings.TrimSpace(endpoint) == "" {
		endpoint = "https://serpapi.com/search.json"
	}
	if timeout <= 0 {
		timeout = 12 * time.Second
	}
	return &SerpAPIProvider{
		endpoint: endpoint,
		apiKey:   strings.TrimSpace(apiKey),
		client:   &http.Client{Timeout: timeout},
	}
}

func (p *SerpAPIProvider) Name() string {
	return ProviderSerpAPI
}

type serpAPIResponse struct {
	OrganicResults []struct {
		Title   string `json:"title"`
		Link    string `json:"link"`
		Snippet string `json:"snippet"`
		Date    string `json:"date"`
		Source  string `json:"source"`
	} `json:"organic_results"`
}

func (p *SerpAPIProvider) Search(ctx context.Context, query Query) (Response, error) {
	if p.apiKey == "" {
		return Response{}, NewTypedError(ErrorTypeConfig, fmt.Errorf("serpapi api key is missing"))
	}

	q := query.Normalize()
	u, err := url.Parse(p.endpoint)
	if err != nil {
		return Response{}, NewTypedError(ErrorTypeConfig, fmt.Errorf("invalid serpapi endpoint: %w", err))
	}

	params := u.Query()
	params.Set("q", q.Query)
	params.Set("api_key", p.apiKey)
	params.Set("num", fmt.Sprintf("%d", q.Count))
	if q.Country != "" {
		params.Set("gl", q.Country)
	}
	if q.SearchLang != "" {
		params.Set("hl", q.SearchLang)
	}
	if q.Freshness != "" {
		if tbs := serpAPITbs(q.Freshness); tbs != "" {
			params.Set("tbs", tbs)
		}
	}
	u.RawQuery = params.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return Response{}, NewTypedError(ErrorTypeUnknown, fmt.Errorf("create serpapi request failed: %w", err))
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "next-ai-agent-gateway/0.1 (+web-search)")

	res, err := p.client.Do(req)
	if err != nil {
		return Response{}, NewTypedError(ErrorTypeNetwork, fmt.Errorf("serpapi request failed: %w", err))
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
		return Response{}, NewTypedError(errorType, fmt.Errorf("serpapi http %d: %s", res.StatusCode, detail))
	}

	var payload serpAPIResponse
	if err := json.NewDecoder(res.Body).Decode(&payload); err != nil {
		return Response{}, NewTypedError(ErrorTypeUnknown, fmt.Errorf("decode serpapi response failed: %w", err))
	}

	results := make([]ResultItem, 0, q.Count)
	for _, row := range payload.OrganicResults {
		title := strings.TrimSpace(row.Title)
		link := strings.TrimSpace(row.Link)
		desc := strings.TrimSpace(row.Snippet)
		if title == "" && link == "" && desc == "" {
			continue
		}
		results = append(results, ResultItem{
			Title:       title,
			URL:         link,
			Description: desc,
			Published:   strings.TrimSpace(row.Date),
			SiteName:    strings.TrimSpace(row.Source),
		})
		if len(results) >= q.Count {
			break
		}
	}

	out := Response{
		Query:    q.Query,
		Provider: ProviderSerpAPI,
		Results:  uniqueByURL(results, q.Count),
	}
	out.Total = len(out.Results)
	if out.Total == 0 {
		out.Note = "No public web results found"
	}
	return out, nil
}

func serpAPITbs(freshness string) string {
	switch strings.TrimSpace(strings.ToLower(freshness)) {
	case "pd", "day", "d":
		return "qdr:d"
	case "pw", "week", "w":
		return "qdr:w"
	case "pm", "month", "m":
		return "qdr:m"
	case "py", "year", "y":
		return "qdr:y"
	default:
		return ""
	}
}
