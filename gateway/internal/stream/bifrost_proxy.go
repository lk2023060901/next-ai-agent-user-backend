package stream

import (
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
)

// BifrostProxy reverse-proxies LLM requests (/v1/*) to the Bifrost sidecar.
// Strips sensitive headers (X-Runtime-Secret, Cookie) before forwarding.
func BifrostProxy(bifrostAddr string) http.Handler {
	target, err := url.Parse(bifrostAddr)
	if err != nil {
		log.Fatalf("invalid bifrost addr: %s", bifrostAddr)
	}
	proxy := httputil.NewSingleHostReverseProxy(target)
	originalDirector := proxy.Director
	proxy.Director = func(req *http.Request) {
		originalDirector(req)
		req.Header.Del("X-Runtime-Secret")
		req.Header.Del("Cookie")
	}
	return proxy
}
