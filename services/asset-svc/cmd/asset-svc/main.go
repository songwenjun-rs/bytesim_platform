package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/bytesim/asset-svc/internal/api"
	"github.com/bytesim/asset-svc/internal/store"
)

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

// runOpts decouples lifecycle from main()'s OS-side concerns. See run-svc
// cmd/run-svc/main.go for the rationale.
type runOpts struct {
	dsn           string
	addr          string
	signalCh      <-chan os.Signal
	quitTrigger   <-chan struct{}
	listenerReady chan<- struct{}
}

func run(ctx context.Context, opts runOpts) error {
	pg, err := store.NewPG(ctx, opts.dsn)
	if err != nil {
		return fmt.Errorf("postgres: %w", err)
	}
	defer pg.Close()

	srv := &api.Server{PG: pg}
	httpSrv := &http.Server{
		Handler:           srv.Routes(),
		ReadHeaderTimeout: 5 * time.Second,
	}

	listenErr := make(chan error, 1)
	go func() {
		log.Printf("asset-svc listening on %s", opts.addr)
		ln, err := net.Listen("tcp", opts.addr)
		if err != nil {
			listenErr <- err
			return
		}
		if opts.listenerReady != nil {
			close(opts.listenerReady)
		}
		if err := httpSrv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			listenErr <- err
		}
	}()

	select {
	case <-opts.signalCh:
	case <-opts.quitTrigger:
	case <-ctx.Done():
	case err := <-listenErr:
		return err
	}

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer shutdownCancel()
	return httpSrv.Shutdown(shutdownCtx)
}

func mainImpl() error {
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	return run(ctx, runOpts{
		dsn:      envOr("PG_DSN", "postgres://bytesim:bytesim@localhost:5432/bytesim?sslmode=disable"),
		addr:     envOr("LISTEN_ADDR", ":8082"),
		signalCh: sigCh,
	})
}

func main() {
	if err := mainImpl(); err != nil {
		log.Fatalf("asset-svc: %v", err)
	}
}
