// Tiny healthcheck binary for distroless run-svc image.
// Distroless has no shell or curl, so HEALTHCHECK CMD must be a binary; we
// build this alongside run-svc itself in the same multi-stage image.
package main

import (
	"net/http"
	"os"
	"time"
)

func main() {
	c := &http.Client{Timeout: 2 * time.Second}
	r, err := c.Get("http://127.0.0.1:8081/healthz")
	if err != nil {
		os.Exit(1)
	}
	defer r.Body.Close()
	if r.StatusCode != http.StatusOK {
		os.Exit(1)
	}
}
