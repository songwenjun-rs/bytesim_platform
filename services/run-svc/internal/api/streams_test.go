package api

import "testing"

func TestClassify(t *testing.T) {
	cases := []struct{ in, want string }{
		{"warn", "warn"},
		{"WARN", "warn"},
		{"err", "err"},
		{"error", "err"},
		{"ERROR", "err"},
		{"info", "info"},
		{"", "info"},
		{"random", "info"},
	}
	for _, c := range cases {
		if got := classify(c.in); got != c.want {
			t.Errorf("classify(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
