package search

import (
	"strings"
)

type Registry struct {
	providers map[string]Provider
}

func NewRegistry(providers ...Provider) *Registry {
	m := make(map[string]Provider, len(providers))
	for _, provider := range providers {
		if provider == nil {
			continue
		}
		name := strings.TrimSpace(strings.ToLower(provider.Name()))
		if name == "" {
			continue
		}
		m[name] = provider
	}
	return &Registry{providers: m}
}

func (r *Registry) Get(name string) (Provider, bool) {
	if r == nil {
		return nil, false
	}
	provider, ok := r.providers[strings.TrimSpace(strings.ToLower(name))]
	return provider, ok
}

func (r *Registry) Has(name string) bool {
	_, ok := r.Get(name)
	return ok
}

type ResolveInput struct {
	Requested       string
	Configured      string
	BraveAPIKey     string
	SearxngEndpoint string
	SerpAPIKey      string
}

func ResolveProviderName(input ResolveInput, registry *Registry) string {
	requested := strings.TrimSpace(strings.ToLower(input.Requested))
	if requested != "" && requested != ProviderAuto && registry.Has(requested) {
		return requested
	}

	configured := strings.TrimSpace(strings.ToLower(input.Configured))
	if configured != "" && configured != ProviderAuto && registry.Has(configured) {
		return configured
	}

	if strings.TrimSpace(input.BraveAPIKey) != "" && registry.Has(ProviderBrave) {
		return ProviderBrave
	}
	if strings.TrimSpace(input.SearxngEndpoint) != "" && registry.Has(ProviderSearxng) {
		return ProviderSearxng
	}
	if strings.TrimSpace(input.SerpAPIKey) != "" && registry.Has(ProviderSerpAPI) {
		return ProviderSerpAPI
	}
	if registry.Has(ProviderDuckDuckGo) {
		return ProviderDuckDuckGo
	}

	// fallback to first provider name deterministically not guaranteed; caller should still check.
	for _, candidate := range []string{ProviderBrave, ProviderSearxng, ProviderSerpAPI} {
		if registry.Has(candidate) {
			return candidate
		}
	}
	return ProviderDuckDuckGo
}
