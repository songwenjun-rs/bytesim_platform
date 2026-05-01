package main

import (
	"context"
	"os"
	"testing"
	"time"
)

func TestEnvOr(t *testing.T) {
	const k = "BYTESIM_TEST_ENVOR_KEY"
	t.Cleanup(func() { os.Unsetenv(k) })

	os.Unsetenv(k)
	if got := envOr(k, "fallback"); got != "fallback" {
		t.Errorf("envOr unset = %q, want fallback", got)
	}
	os.Setenv(k, "")
	if got := envOr(k, "fallback"); got != "fallback" {
		t.Errorf("envOr empty = %q, want fallback", got)
	}
	os.Setenv(k, "actual")
	if got := envOr(k, "fallback"); got != "actual" {
		t.Errorf("envOr set = %q, want actual", got)
	}
}

func requireDSN(t *testing.T) string {
	t.Helper()
	dsn := os.Getenv("PG_DSN")
	if dsn == "" {
		t.Skip("PG_DSN not set; skipping integration-style cmd test")
	}
	return dsn
}

func TestRun_LifecycleViaQuitTrigger(t *testing.T) {
	dsn := requireDSN(t)

	ready := make(chan struct{})
	quit := make(chan struct{})
	errCh := make(chan error, 1)

	go func() {
		errCh <- run(context.Background(), runOpts{
			dsn:           dsn,
			addr:          "127.0.0.1:0",
			quitTrigger:   quit,
			listenerReady: ready,
		})
	}()
	select {
	case <-ready:
	case <-time.After(5 * time.Second):
		t.Fatalf("listener never came up")
	}
	close(quit)
	select {
	case err := <-errCh:
		if err != nil {
			t.Errorf("run returned: %v", err)
		}
	case <-time.After(7 * time.Second):
		t.Fatalf("run did not exit on quit")
	}
}

func TestRun_LifecycleViaContextCancel(t *testing.T) {
	dsn := requireDSN(t)

	ready := make(chan struct{})
	errCh := make(chan error, 1)
	ctx, cancel := context.WithCancel(context.Background())

	go func() {
		errCh <- run(ctx, runOpts{
			dsn:           dsn,
			addr:          "127.0.0.1:0",
			listenerReady: ready,
		})
	}()
	select {
	case <-ready:
	case <-time.After(5 * time.Second):
		t.Fatalf("listener never came up")
	}
	cancel()
	select {
	case err := <-errCh:
		if err != nil {
			t.Errorf("run returned: %v", err)
		}
	case <-time.After(7 * time.Second):
		t.Fatalf("run did not exit on cancel")
	}
}

func TestRun_LifecycleViaSignal(t *testing.T) {
	dsn := requireDSN(t)

	ready := make(chan struct{})
	sig := make(chan os.Signal, 1)
	errCh := make(chan error, 1)

	go func() {
		errCh <- run(context.Background(), runOpts{
			dsn:           dsn,
			addr:          "127.0.0.1:0",
			signalCh:      sig,
			listenerReady: ready,
		})
	}()
	<-ready
	sig <- os.Interrupt
	select {
	case err := <-errCh:
		if err != nil {
			t.Errorf("run returned: %v", err)
		}
	case <-time.After(7 * time.Second):
		t.Fatalf("run did not exit on signal")
	}
}

func TestRun_BadDSN_Errors(t *testing.T) {
	err := run(context.Background(), runOpts{
		dsn:  "postgres://no-such-host:1/x?connect_timeout=1",
		addr: "127.0.0.1:0",
	})
	if err == nil {
		t.Errorf("expected error on bad DSN, got nil")
	}
}

func TestMainImpl_BadDSN(t *testing.T) {
	t.Setenv("PG_DSN", "postgres://no-such-host:1/x?connect_timeout=1")
	t.Setenv("LISTEN_ADDR", "127.0.0.1:0")
	if err := mainImpl(); err == nil {
		t.Errorf("mainImpl should error on bad DSN, got nil")
	}
}

func TestMainImpl_GracefulShutdown(t *testing.T) {
	dsn := requireDSN(t)
	t.Setenv("PG_DSN", dsn)
	t.Setenv("LISTEN_ADDR", "127.0.0.1:0")

	errCh := make(chan error, 1)
	go func() { errCh <- mainImpl() }()

	time.Sleep(300 * time.Millisecond)
	pid, _ := os.FindProcess(os.Getpid())
	_ = pid.Signal(os.Interrupt)

	select {
	case err := <-errCh:
		if err != nil {
			t.Errorf("mainImpl returned: %v", err)
		}
	case <-time.After(7 * time.Second):
		t.Fatalf("mainImpl did not exit on SIGINT")
	}
}
