//go:build darwin && cgo

package agent

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/fsnotify/fsevents"
	workspacev1 "github.com/opensumi/core/go/workspace-agent/gen/opensumi/workspace/v1"
)

func TestFSEventsChangeType(t *testing.T) {
	root := t.TempDir()
	existing := filepath.Join(root, "existing.txt")
	if err := os.WriteFile(existing, []byte("content"), 0o600); err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		name  string
		path  string
		flags fsevents.EventFlags
		want  workspacev1.FileChangeType
		ok    bool
	}{
		{name: "created", flags: fsevents.ItemCreated, want: workspacev1.FileChangeType_FILE_CHANGE_TYPE_ADDED, ok: true},
		{name: "removed", flags: fsevents.ItemRemoved, want: workspacev1.FileChangeType_FILE_CHANGE_TYPE_DELETED, ok: true},
		{name: "renamed destination", path: existing, flags: fsevents.ItemRenamed, want: workspacev1.FileChangeType_FILE_CHANGE_TYPE_ADDED, ok: true},
		{name: "renamed source", path: filepath.Join(root, "missing.txt"), flags: fsevents.ItemRenamed, want: workspacev1.FileChangeType_FILE_CHANGE_TYPE_DELETED, ok: true},
		{name: "modified", flags: fsevents.ItemModified, want: workspacev1.FileChangeType_FILE_CHANGE_TYPE_UPDATED, ok: true},
		{name: "unrelated", flags: fsevents.ItemIsFile, want: workspacev1.FileChangeType_FILE_CHANGE_TYPE_UPDATED, ok: false},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, ok := fseventsChangeType(test.path, test.flags)
			if got != test.want || ok != test.ok {
				t.Fatalf("fseventsChangeType() = (%v, %v), want (%v, %v)", got, ok, test.want, test.ok)
			}
		})
	}
}

func TestFSEventsBackendEmitsFileChanges(t *testing.T) {
	root := t.TempDir()
	backend, err := newWatchBackend(root, true, true, newExcludeFilter(root, nil))
	if err != nil {
		t.Fatal(err)
	}
	defer backend.Close()

	// Let the native dispatch queue finish registering before creating the file.
	time.Sleep(100 * time.Millisecond)
	target := filepath.Join(root, "created.txt")
	if err := os.WriteFile(target, []byte("created"), 0o600); err != nil {
		t.Fatal(err)
	}

	timeout := time.NewTimer(5 * time.Second)
	defer timeout.Stop()
	for {
		select {
		case event, ok := <-backend.Events():
			if !ok {
				t.Fatal("watch backend closed before delivering the file event")
			}
			if event.path == target && event.changeType == workspacev1.FileChangeType_FILE_CHANGE_TYPE_ADDED {
				return
			}
		case err := <-backend.Errors():
			if err != nil {
				t.Fatalf("watch backend failed: %v", err)
			}
		case <-timeout.C:
			t.Fatalf("timed out waiting for FSEvents change for %s", target)
		}
	}
}

func TestFSEventsBackendActivatesMissingRoot(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "missing", "nested")
	backend, err := newWatchBackend(root, false, true, newExcludeFilter(root, nil))
	if err != nil {
		t.Fatal(err)
	}
	defer backend.Close()

	time.Sleep(100 * time.Millisecond)
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "created.txt")
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
			t.Fatalf("timed out waiting for FSEvents change under missing root %s", root)
		}
	}
}
