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
		resp.Header.Del("Content-Length")
		return nil
	}
	return proxy
}
