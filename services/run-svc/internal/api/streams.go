package api

import (
	"bufio"
	"log"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

// Each line of engine.log looks like:  [10:32:14] ENGINE/scheduler      load config topo-v3 ✓ hwspec v4
// or:                                  [11:18:12] WARN  OOD             EP=16 candidates flagged · 38 skipped
var logLine = regexp.MustCompile(`^\[(\d{2}:\d{2}:\d{2})\]\s+(\S+)\s+(.+)$`)

type LogEvent struct {
	Type   string `json:"type"`            // "log" | "eof"
	TS     string `json:"ts,omitempty"`
	Source string `json:"source,omitempty"`
	Level  string `json:"level,omitempty"` // info | warn | err
	Msg    string `json:"msg,omitempty"`
}

func classify(source string) string {
	switch strings.ToLower(source) {
	case "warn":
		return "warn"
	case "err", "error":
		return "err"
	default:
		return "info"
	}
}

func (s *Server) streamLog(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	rc, _, err := s.Artifacts.Open(id, "engine.log")
	if err != nil {
		writeErr(w, http.StatusNotFound, "engine log not found: "+id)
		return
	}
	defer rc.Close()

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("ws upgrade error: %v", err)
		return
	}
	defer conn.Close()

	sc := bufio.NewScanner(rc)
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	for sc.Scan() {
		line := sc.Text()
		ev := LogEvent{Type: "log"}
		if m := logLine.FindStringSubmatch(line); m != nil {
			ev.TS, ev.Source, ev.Msg = m[1], m[2], m[3]
			ev.Level = classify(m[2])
		} else {
			ev.Msg = line
			ev.Level = "info"
		}
		if err := conn.WriteJSON(ev); err != nil {
			return
		}
		// pace the playback so the front-end shows streaming behavior
		time.Sleep(60 * time.Millisecond)
	}
	if err := sc.Err(); err != nil {
		log.Printf("log scan error: %v", err)
	}
	_ = conn.WriteJSON(LogEvent{Type: "eof"})

	// keep connection open briefly so the close handshake completes cleanly
	conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
	_ = conn.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, "done"))
}
