package store

// Pure-function unit tests for asset-svc/internal/store/postgres.go.
// Anything DB-touching lives in integration tests; this file only exercises
// helpers that are deterministic / no I/O so we get coverage without standing
// up Postgres.

import (
	"strings"
	"testing"
)

func TestRandomHex(t *testing.T) {
	for _, n := range []int{1, 3, 8, 16} {
		got := randomHex(n)
		if len(got) != n*2 {
			t.Errorf("randomHex(%d) length = %d, want %d", n, len(got), n*2)
		}
		// Hex chars only
		for _, r := range got {
			if !strings.ContainsRune("0123456789abcdef", r) {
				t.Errorf("non-hex char %q in %q", r, got)
			}
		}
	}
	// Uniqueness sanity — two calls must collide < 1 / 2^48 chance.
	a := randomHex(8)
	b := randomHex(8)
	if a == b {
		t.Errorf("two 8-byte randomHex calls collided: %s", a)
	}
}

func TestSha1HexDeterministic(t *testing.T) {
	a := sha1Hex([]byte(`{"x":1}`))
	b := sha1Hex([]byte(`{"x":1}`))
	if a != b {
		t.Errorf("sha1Hex not deterministic: %s vs %s", a, b)
	}
	if len(a) != 40 {
		t.Errorf("sha1Hex length = %d, want 40", len(a))
	}
	c := sha1Hex([]byte(`{"x":2}`))
	if c == a {
		t.Errorf("sha1Hex didn't differentiate inputs")
	}
}

func TestNextVersionTag(t *testing.T) {
	cases := []struct {
		name string
		in   []string
		want string
	}{
		{"empty list → v1", []string{}, "v1"},
		{"single v3 → v4", []string{"v3"}, "v4"},
		{"v1 + v3 → v4 (skips gaps)", []string{"v1", "v3"}, "v4"},
		{"non-numeric ignored", []string{"v3", "v3-gb300", "abc"}, "v4"},
		{"trims whitespace", []string{" v5 "}, "v6"},
		{"non-v-prefix ignored", []string{"3", "build-1"}, "v1"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := nextVersionTag(append([]string{}, tc.in...))
			if got != tc.want {
				t.Errorf("nextVersionTag(%v) = %s, want %s", tc.in, got, tc.want)
			}
		})
	}
}

func TestNullableStr(t *testing.T) {
	if nullableStr("") != nil {
		t.Error(`nullableStr("") should be nil`)
	}
	if v := nullableStr("hello"); v != "hello" {
		t.Errorf(`nullableStr("hello") = %v, want "hello"`, v)
	}
}
