package store

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAppendLogAndOpen(t *testing.T) {
	root := t.TempDir()
	fs := NewFSArtifacts(root)
	if err := fs.AppendLog("sim-x", "first"); err != nil {
		t.Fatalf("append: %v", err)
	}
	if err := fs.AppendLog("sim-x", "second\n"); err != nil {
		t.Fatalf("append: %v", err)
	}
	rc, size, err := fs.Open("sim-x", "engine.log")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer rc.Close()
	body, _ := io.ReadAll(rc)
	if !strings.Contains(string(body), "first\n") || !strings.Contains(string(body), "second\n") {
		t.Errorf("unexpected body: %q", string(body))
	}
	if size <= 0 {
		t.Errorf("size=%d", size)
	}
}

func TestAppendLogRejectsTraversal(t *testing.T) {
	fs := NewFSArtifacts(t.TempDir())
	if err := fs.AppendLog("../etc", "x"); err == nil {
		t.Error("expected rejection")
	}
}

func TestOpenMissingReturnsError(t *testing.T) {
	fs := NewFSArtifacts(t.TempDir())
	if _, _, err := fs.Open("sim-missing", "result.json"); err == nil {
		t.Error("expected error for missing file")
	}
}

func TestOpenRejectsTraversal(t *testing.T) {
	fs := NewFSArtifacts(t.TempDir())
	if _, _, err := fs.Open("..", "passwd"); err == nil {
		t.Error("expected rejection")
	}
}

func TestAppendLogCreatesDirectory(t *testing.T) {
	root := filepath.Join(t.TempDir(), "nested", "deep")
	fs := NewFSArtifacts(root)
	if err := fs.AppendLog("sim-1", "hi"); err != nil {
		t.Fatalf("append: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "sim-1", "engine.log")); err != nil {
		t.Errorf("missing log file: %v", err)
	}
}
