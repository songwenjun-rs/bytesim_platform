// Tiny healthcheck binary for distroless asset-svc image.
// See run-svc/cmd/healthcheck/main.go for rationale.
package main

import (
	"net/http"
	"os"
	"time"
)

func main() {
	c := &http.Client{Timeout: 2 * time.Second}
	r, err := c.Get("http://127.0.0.1:8082/healthz")
	if err != nil {
		os.Exit(1)
	}
	defer r.Body.Close()
	if r.StatusCode != http.StatusOK {
		os.Exit(1)
	}
}
