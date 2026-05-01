package store

import (
	"strings"
	"testing"
)

func TestNilIfEmpty(t *testing.T) {
	if v := nilIfEmpty(""); v != nil {
		t.Fatalf("empty string should be nil, got %v", v)
	}
	if v := nilIfEmpty("x"); v != "x" {
		t.Fatalf("non-empty should pass through, got %v", v)
	}
}

func TestSha1JoinedDeterministic(t *testing.T) {
	a := sha1Joined([]string{"foo", "bar"})
	b := sha1Joined([]string{"foo", "bar"})
	if a != b {
		t.Fatalf("non-deterministic: %s vs %s", a, b)
	}
	if len(a) != 40 {
		t.Fatalf("sha1 should be 40 hex chars, got %d", len(a))
	}
	// Order matters; null-separated → reversed input must hash differently
	if c := sha1Joined([]string{"bar", "foo"}); c == a {
		t.Fatalf("ordering must matter")
	}
}

func TestSha1JoinedNullSeparation(t *testing.T) {
	// "a", "bc" must hash differently from "ab", "c" (separator collision check)
	x := sha1Joined([]string{"a", "bc"})
	y := sha1Joined([]string{"ab", "c"})
	if x == y {
		t.Fatalf("null separator failed to disambiguate")
	}
}

func TestRandomHexLength(t *testing.T) {
	for _, n := range []int{1, 4, 8, 16} {
		s := randomHex(n)
		if len(s) != n*2 {
			t.Fatalf("randomHex(%d) → len %d, want %d", n, len(s), n*2)
		}
		for _, c := range s {
			if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
				t.Fatalf("randomHex non-hex char: %q", c)
			}
		}
	}
}

func TestRandomHexUnique(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 100; i++ {
		s := randomHex(8)
		if seen[s] {
			t.Fatalf("collision after %d draws: %s", i, s)
		}
		seen[s] = true
	}
}

func TestSafePathRejectsTraversal(t *testing.T) {
	fs := NewFSArtifacts("/tmp/run-artifacts")
	cases := []struct {
		runID, name string
	}{
		{"../../etc", "passwd"},
		{"sim-1", "../../etc/passwd"},
		{"sim-1", "subdir/x"},
		{"sim/escape", "ok.txt"},
		{"sim-1", "back\\slash"},
	}
	for _, c := range cases {
		if _, err := fs.safePath(c.runID, c.name); err == nil {
			t.Errorf("expected rejection for runID=%q name=%q", c.runID, c.name)
		}
	}
}

func TestSafePathAcceptsCleanInputs(t *testing.T) {
	fs := NewFSArtifacts("/tmp/run-artifacts")
	p, err := fs.safePath("sim-7f2a", "result.json")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.HasSuffix(p, "/sim-7f2a/result.json") {
		t.Fatalf("unexpected path: %s", p)
	}
}
