package store

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// FSArtifacts is a stand-in for S3-compatible storage. Slice-1 reads from a
// host-mounted directory; the same Reader/Stat surface will swap to MinIO/S3 later.
type FSArtifacts struct {
	root string
}

func NewFSArtifacts(root string) *FSArtifacts {
	return &FSArtifacts{root: root}
}

func (f *FSArtifacts) safePath(runID, name string) (string, error) {
	if strings.ContainsAny(runID, "/\\") || strings.ContainsAny(name, "/\\") {
		return "", errors.New("invalid path component")
	}
	return filepath.Join(f.root, runID, name), nil
}

func (f *FSArtifacts) Open(runID, name string) (io.ReadCloser, int64, error) {
	p, err := f.safePath(runID, name)
	if err != nil {
		return nil, 0, err
	}
	st, err := os.Stat(p)
	if err != nil {
		return nil, 0, err
	}
	fh, err := os.Open(p)
	if err != nil {
		return nil, 0, err
	}
	return fh, st.Size(), nil
}

// RemoveAll deletes the run's artifacts directory ({root}/{runID}). Used by
// the仿真报告 delete flow — the DB row is gone first, the disk dir is best-
// effort cleanup. Path-traversal is blocked by safePath.
func (f *FSArtifacts) RemoveAll(runID string) error {
	p, err := f.safePath(runID, "engine.log") // reuse path validation
	if err != nil {
		return err
	}
	return os.RemoveAll(filepath.Dir(p))
}

// AppendLog opens (or creates) {root}/{runID}/engine.log and appends. Engine-svc
// uses this via the PATCH endpoint to make incremental progress visible to the
// streaming WS without needing its own write path.
//
// Note on mode: run-svc runs as distroless nonroot (uid 65532); engine-svc
// runs as uid 1001 and writes other artifacts (result.json, timeline.json) to
// the same directory. If we create the dir with the default 0755, engine-svc
// can't write — it's neither owner nor in run-svc's group. So we chmod 0777
// explicitly (MkdirAll's mode arg is ANDed with umask, typically 022).
func (f *FSArtifacts) AppendLog(runID, line string) error {
	p, err := f.safePath(runID, "engine.log")
	if err != nil {
		return err
	}
	dir := filepath.Dir(p)
	if err := os.MkdirAll(dir, 0o777); err != nil {
		return err
	}
	// Explicitly chmod so the umask (which would have AND-masked the dir to
	// 0755 above) doesn't lock out engine-svc's app user.
	_ = os.Chmod(dir, 0o777)
	fh, err := os.OpenFile(p, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o666)
	if err != nil {
		return err
	}
	defer fh.Close()
	if !strings.HasSuffix(line, "\n") {
		line += "\n"
	}
	_, err = fh.WriteString(line)
	return err
}
