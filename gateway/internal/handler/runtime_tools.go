package handler

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/liukai/next-ai-agent-user-backend/gateway/internal/search"
)

type RuntimeToolsHandler struct {
	runtimeSecret      string
	defaultProvider    string
	registry           *search.Registry
	selectionInputSeed search.ResolveInput
}

type RuntimeToolsHandlerOptions struct {
	RuntimeSecret      string
	DefaultProvider    string
	TimeoutMs          int
	DuckDuckGoEndpoint string
	BraveEndpoint      string
	BraveAPIKey        string
	SearxngEndpoint    string
	SearxngAPIKey      string
	SerpAPIEndpoint    string
	SerpAPIKey         string
}

type webSearchRequest struct {
	Query      string `json:"query"`
	Provider   string `json:"provider,omitempty"`
	Count      int    `json:"count,omitempty"`
	MaxResults int    `json:"maxResults,omitempty"` // backward compatibility
	Country    string `json:"country,omitempty"`
	SearchLang string `json:"search_lang,omitempty"`
	Freshness  string `json:"freshness,omitempty"`
}

func NewRuntimeToolsHandler(options RuntimeToolsHandlerOptions) *RuntimeToolsHandler {
	timeout := time.Duration(options.TimeoutMs) * time.Millisecond
	if timeout <= 0 {
		timeout = 12 * time.Second
	}

	registry := search.NewRegistry(
		search.NewDuckDuckGoProvider(options.DuckDuckGoEndpoint, timeout),
		search.NewBraveProvider(options.BraveEndpoint, options.BraveAPIKey, timeout),
		search.NewSearxngProvider(options.SearxngEndpoint, options.SearxngAPIKey, timeout),
		search.NewSerpAPIProvider(options.SerpAPIEndpoint, options.SerpAPIKey, timeout),
	)

	return &RuntimeToolsHandler{
		runtimeSecret:   options.RuntimeSecret,
		defaultProvider: strings.TrimSpace(strings.ToLower(options.DefaultProvider)),
		registry:        registry,
		selectionInputSeed: search.ResolveInput{
			Configured:      strings.TrimSpace(strings.ToLower(options.DefaultProvider)),
			BraveAPIKey:     options.BraveAPIKey,
			SearxngEndpoint: options.SearxngEndpoint,
			SerpAPIKey:      options.SerpAPIKey,
		},
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

	count := req.Count
	if count <= 0 {
		count = req.MaxResults
	}
	if count <= 0 {
		count = 5
	}
	if count > 10 {
		count = 10
	}

	resolvedProvider := search.ResolveProviderName(search.ResolveInput{
		Requested:       req.Provider,
		Configured:      h.defaultProvider,
		BraveAPIKey:     h.selectionInputSeed.BraveAPIKey,
		SearxngEndpoint: h.selectionInputSeed.SearxngEndpoint,
		SerpAPIKey:      h.selectionInputSeed.SerpAPIKey,
	}, h.registry)

	provider, ok := h.registry.Get(resolvedProvider)
	if !ok {
		writeJSON(w, http.StatusOK, map[string]any{
			"query":     query,
			"provider":  resolvedProvider,
			"results":   []any{},
			"total":     0,
			"note":      fmt.Sprintf("unsupported web search provider: %s", resolvedProvider),
			"errorType": search.ErrorTypeConfig,
		})
		return
	}

	response, err := provider.Search(r.Context(), search.Query{
		Query:      query,
		Count:      count,
		Country:    req.Country,
		SearchLang: req.SearchLang,
		Freshness:  req.Freshness,
	})
	if err != nil {
		errorType := search.ClassifyError(err)
		writeJSON(w, http.StatusOK, map[string]any{
			"query":     query,
			"provider":  resolvedProvider,
			"results":   []any{},
			"total":     0,
			"note":      err.Error(),
			"errorType": errorType,
		})
		return
	}

	if response.Provider == "" {
		response.Provider = resolvedProvider
	}
	writeJSON(w, http.StatusOK, response)
}
