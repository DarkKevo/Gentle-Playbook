package middlewares

import (
	"bytes"
	"net/http"
	"strings"
)

// SanitizeInputMiddleware intercepts null-byte injections
func SanitizeInputMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "\x00") || strings.Contains(r.URL.RawQuery, "%00") {
			http.Error(w, "Invalid input: null byte rejected", http.StatusBadRequest)
			return
		}
		next.ServeHTTP(w, r)
	})
}
