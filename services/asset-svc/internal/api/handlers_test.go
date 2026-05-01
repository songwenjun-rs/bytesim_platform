package api

import (
	"sort"
	"testing"

	"github.com/bytesim/asset-svc/internal/model"
)

func diffByPath(d []model.DiffEntry) map[string]model.DiffEntry {
	out := map[string]model.DiffEntry{}
	for _, e := range d {
		out[e.Path] = e
	}
	return out
}

func TestComputeDiff_NoChange(t *testing.T) {
	a := map[string]any{"x": 1.0, "y": "hi"}
	b := map[string]any{"x": 1.0, "y": "hi"}
	if d := computeDiff("", a, b); len(d) != 0 {
		t.Fatalf("expected no diff, got %+v", d)
	}
}

func TestComputeDiff_TopLevelAddRemoveChange(t *testing.T) {
	a := map[string]any{"keep": "same", "drop": "old", "tweak": 1.0}
	b := map[string]any{"keep": "same", "tweak": 2.0, "added": "new"}
	out := computeDiff("", a, b)
	by := diffByPath(out)

	if e, ok := by["drop"]; !ok || e.Op != "removed" {
		t.Fatalf("expected drop=removed, got %+v", e)
	}
	if e, ok := by["added"]; !ok || e.Op != "added" {
		t.Fatalf("expected added=added, got %+v", e)
	}
	if e, ok := by["tweak"]; !ok || e.Op != "changed" {
		t.Fatalf("expected tweak=changed, got %+v", e)
	}
	if _, ok := by["keep"]; ok {
		t.Fatalf("did not expect 'keep' in diff")
	}
}

func TestComputeDiff_NestedObjectRecurses(t *testing.T) {
	a := map[string]any{"power": map[string]any{"peak_kw": 680.0, "pue": 1.22}}
	b := map[string]any{"power": map[string]any{"peak_kw": 820.0, "pue": 1.22, "cooling": "DLC"}}
	out := computeDiff("", a, b)
	by := diffByPath(out)

	if e, ok := by["power.peak_kw"]; !ok || e.Op != "changed" {
		t.Fatalf("expected power.peak_kw changed, got %+v", e)
	}
	if e, ok := by["power.cooling"]; !ok || e.Op != "added" {
		t.Fatalf("expected power.cooling added, got %+v", e)
	}
	if _, ok := by["power.pue"]; ok {
		t.Fatalf("power.pue should be unchanged")
	}
}

func TestComputeDiff_TypeMismatchTreatedAsChanged(t *testing.T) {
	a := map[string]any{"x": map[string]any{"a": 1.0}}
	b := map[string]any{"x": "now a string"}
	out := computeDiff("", a, b)
	if len(out) != 1 {
		t.Fatalf("expected single changed entry, got %+v", out)
	}
	if out[0].Path != "x" || out[0].Op != "changed" {
		t.Fatalf("expected x=changed, got %+v", out[0])
	}
}

func TestComputeDiff_ScalarsRootChange(t *testing.T) {
	out := computeDiff("", "old", "new")
	if len(out) != 1 || out[0].Op != "changed" || out[0].Path != "" {
		t.Fatalf("expected root scalar change, got %+v", out)
	}
}

func TestComputeDiff_ArraysAreCompareByValue(t *testing.T) {
	// Same array → no diff
	a := map[string]any{"xs": []any{1.0, 2.0, 3.0}}
	b := map[string]any{"xs": []any{1.0, 2.0, 3.0}}
	if d := computeDiff("", a, b); len(d) != 0 {
		t.Fatalf("equal arrays must not diff, got %+v", d)
	}
	// Different array → one changed entry
	c := map[string]any{"xs": []any{1.0, 2.0, 4.0}}
	d := computeDiff("", a, c)
	if len(d) != 1 || d[0].Path != "xs" || d[0].Op != "changed" {
		t.Fatalf("expected xs changed, got %+v", d)
	}
}

func TestComputeDiff_DeepStability(t *testing.T) {
	// Order of map iteration is randomized in Go — confirm output is sorted
	// so the UI gets stable diffs across requests.
	a := map[string]any{"z": 1.0, "a": 1.0, "m": 1.0}
	b := map[string]any{"z": 2.0, "a": 2.0, "m": 2.0}
	out := computeDiff("", a, b)
	paths := make([]string, len(out))
	for i, e := range out {
		paths[i] = e.Path
	}
	expected := []string{"a", "m", "z"}
	sortedExpected := make([]string, len(expected))
	copy(sortedExpected, expected)
	sort.Strings(sortedExpected)
	for i := range paths {
		if paths[i] != sortedExpected[i] {
			t.Fatalf("expected sorted paths %v, got %v", sortedExpected, paths)
		}
	}
}

func TestJSONEqual(t *testing.T) {
	cases := []struct {
		a, b any
		want bool
	}{
		{1.0, 1.0, true},
		{"x", "x", true},
		{nil, nil, true},
		{[]any{1.0, 2.0}, []any{1.0, 2.0}, true},
		{[]any{1.0, 2.0}, []any{2.0, 1.0}, false}, // order matters for arrays
		{map[string]any{"a": 1.0}, map[string]any{"a": 1.0}, true},
		{map[string]any{"a": 1.0}, map[string]any{"a": 2.0}, false},
	}
	for i, c := range cases {
		if got := jsonEqual(c.a, c.b); got != c.want {
			t.Errorf("case %d: jsonEqual(%v, %v) = %v, want %v", i, c.a, c.b, got, c.want)
		}
	}
}
