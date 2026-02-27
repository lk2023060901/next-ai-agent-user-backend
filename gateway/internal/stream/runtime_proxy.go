package stream

import (
	"fmt"
	"net/http"
	"net/http/httputil"
	"net/url"
)

// RuntimeProxy reverse-proxies agent runtime requests (/runtime/*) to the Runtime process.
// SSE responses require Content-Length to be removed to allow streaming.
func RuntimeProxy(runtimeAddr string) http.Handler {
	target, err := url.Parse(runtimeAddr)
	if err != nil {
		panic(fmt.Sprintf("invalid runtime addr: %s", runtimeAddr))
	}
	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.ModifyResponse = func(resp *http.Response) error {
		// CORS is handled by Gateway middleware. Strip upstream CORS headers
		// from Runtime responses to avoid duplicate ACAO/credentials headers.
		resp.Header.Del("Access-Control-Allow-Origin")
		resp.Header.Del("Access-Control-Allow-Credentials")
		resp.Header.Del("Access-Control-Allow-Headers")
		resp.Header.Del("Access-Control-Allow-Methods")
		resp.Header.Del("Access-Control-Expose-Headers")

		resp.Header.Del("Content-Length")
		return nil
	}
	return proxy
}
