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

	"github.com/bytesim/run-svc/internal/api"
	"github.com/bytesim/run-svc/internal/obs"
	"github.com/bytesim/run-svc/internal/store"
)

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// runOpts decouples main()'s side-effects (signal trap + logger setup) from
// the lifecycle code so tests can drive run() to completion in <1s without
// kill -SIGTERM dance.
type runOpts struct {
	dsn          string
	addr         string
	artifactsDir string
	// signalCh receives an OS signal to trigger graceful shutdown.
	signalCh <-chan os.Signal
	// quitTrigger optionally bypasses signalCh — closing this channel triggers
	// the same shutdown path. Tests use this to exit cleanly.
	quitTrigger <-chan struct{}
	// listenerReady fires once the HTTP server's accept loop is up. Tests
	// observe this to know when it's safe to close quitTrigger.
	listenerReady chan<- struct{}
}

// run is the testable lifecycle. main() is a thin shim around it.
func run(ctx context.Context, opts runOpts) error {
	pg, err := store.NewPG(ctx, opts.dsn)
	if err != nil {
		return fmt.Errorf("postgres: %w", err)
	}
	defer pg.Close()

	srv := &api.Server{
		PG:        pg,
		Artifacts: store.NewFSArtifacts(opts.artifactsDir),
	}

	httpSrv := &http.Server{
		Handler:           srv.Routes(),
		ReadHeaderTimeout: 5 * time.Second,
	}

	listenErr := make(chan error, 1)
	go func() {
		log.Printf("run-svc listening on %s", opts.addr)
		// Open the listener manually so we can signal readiness before the
		// blocking Serve call. Without this tests race the goroutine.
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
	log.Println("shutting down...")

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer shutdownCancel()
	return httpSrv.Shutdown(shutdownCtx)
}

// mainImpl wires up the OS-side concerns (logger, signal trap, env vars)
// and delegates to run(). main() is a thin shell around it that converts
// the returned error into log.Fatalf — keeping this layer separate makes
// it testable.
func mainImpl() error {
	obs.SetupLogger("run-svc")

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	return run(ctx, runOpts{
		dsn:          envOr("PG_DSN", "postgres://bytesim:bytesim@localhost:5432/bytesim?sslmode=disable"),
		addr:         envOr("LISTEN_ADDR", ":8081"),
		artifactsDir: envOr("ARTIFACTS_DIR", "../../infra/artifacts"),
		signalCh:     sigCh,
	})
}

func main() {
	if err := mainImpl(); err != nil {
		log.Fatalf("run-svc: %v", err)
	}
}
