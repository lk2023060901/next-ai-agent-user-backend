package search

import (
	"context"
	"strings"
)

const (
	ProviderDuckDuckGo = "duckduckgo"
	ProviderBrave      = "brave"
	ProviderSearxng    = "searxng"
	ProviderSerpAPI    = "serpapi"
	ProviderAuto       = "auto"
)

type Query struct {
	Query      string
	Count      int
	Country    string
	SearchLang string
	Freshness  string
}

func (q Query) Normalize() Query {
	out := Query{
		Query:      strings.TrimSpace(q.Query),
		Count:      q.Count,
		Country:    strings.TrimSpace(strings.ToLower(q.Country)),
		SearchLang: strings.TrimSpace(strings.ToLower(q.SearchLang)),
		Freshness:  strings.TrimSpace(strings.ToLower(q.Freshness)),
	}
	if out.Count <= 0 {
		out.Count = 5
	}
	if out.Count > 10 {
		out.Count = 10
	}
	return out
}

type ResultItem struct {
	Title       string `json:"title"`
	URL         string `json:"url"`
	Description string `json:"description"`
	Published   string `json:"published,omitempty"`
	SiteName    string `json:"siteName,omitempty"`
}

type Response struct {
	Query     string       `json:"query"`
	Provider  string       `json:"provider"`
	Results   []ResultItem `json:"results"`
	Total     int          `json:"total"`
	Note      string       `json:"note,omitempty"`
	ErrorType string       `json:"errorType,omitempty"`
}

type Provider interface {
	Name() string
	Search(ctx context.Context, query Query) (Response, error)
}
