package stream

import (
	"fmt"
	"net/http"
	"net/http/httputil"
	"net/url"
)

// BifrostProxy reverse-proxies LLM requests (/v1/*) to the Bifrost sidecar.
func BifrostProxy(bifrostAddr string) http.Handler {
	target, err := url.Parse(bifrostAddr)
	if err != nil {
		panic(fmt.Sprintf("invalid bifrost addr: %s", bifrostAddr))
	}
	proxy := httputil.NewSingleHostReverseProxy(target)
	return proxy
}
