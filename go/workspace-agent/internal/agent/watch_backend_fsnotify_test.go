//go:build !darwin

package agent

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	workspacev1 "github.com/opensumi/core/go/workspace-agent/gen/opensumi/workspace/v1"
)

func TestFSNotifyBackendActivatesRapidlyCreatedMissingRoot(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "missing", "nested")
	backend, err := newWatchBackend(root, false, true, newExcludeFilter(root, nil))
	if err != nil {
		t.Fatal(err)
	}
	defer backend.Close()

	target := filepath.Join(root, "created.txt")
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, []byte("created"), 0o600); err != nil {
		t.Fatal(err)
	}

	timeout := time.NewTimer(5 * time.Second)
	defer timeout.Stop()
	for {
		select {
		case event, ok := <-backend.Events():
			if !ok {
				t.Fatal("watch backend closed before the missing root became active")
			}
			if event.path == target && event.changeType == workspacev1.FileChangeType_FILE_CHANGE_TYPE_ADDED {
				return
			}
		case err := <-backend.Errors():
			if err != nil {
				t.Fatalf("watch backend failed: %v", err)
			}
		case <-timeout.C:
			t.Fatalf("timed out waiting for fsnotify change under missing root %s", root)
		}
	}
}
