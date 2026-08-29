//go:build darwin && cgo

package agent

import (
	"os"
	"path/filepath"
	"sync"

	"github.com/fsnotify/fsevents"
	workspacev1 "github.com/opensumi/core/go/workspace-agent/gen/opensumi/workspace/v1"
)

// fseventsWatchBackend isolates the macOS-native dependency behind the common
// watcher contract. FSEvents watches directory trees recursively without
// retaining one file descriptor per file, unlike kqueue-based fsnotify.
type fseventsWatchBackend struct {
	stream *fsevents.EventStream
	queue  *watchEventQueue
	errors chan error
	done   chan struct{}
	once   sync.Once
}

func newWatchBackend(rootPath string, rootExists, recursive bool, filter excludeFilter) (watchBackend, error) {
	watchPath := rootPath
	if !rootExists {
		ancestor, err := nearestExistingDirectory(filepath.Dir(rootPath))
		if err != nil {
			return nil, err
		}
		watchPath = ancestor
	}
	canonicalWatchPath, err := filepath.EvalSymlinks(watchPath)
	if err != nil {
		return nil, err
	}
	relativeRoot, err := filepath.Rel(watchPath, rootPath)
	if err != nil {
		return nil, err
	}
	eventRootPath := filepath.Join(canonicalWatchPath, relativeRoot)

	stream := &fsevents.EventStream{
		Paths:   []string{canonicalWatchPath},
		Latency: watchBatchInterval,
		Flags:   fsevents.FileEvents | fsevents.WatchRoot | fsevents.NoDefer,
	}
	if err := stream.Start(); err != nil {
		return nil, err
	}
	backend := &fseventsWatchBackend{
		stream: stream,
		queue:  newWatchEventQueue(watchBackendEventQueueLimit),
		errors: make(chan error),
		done:   make(chan struct{}),
	}
	go backend.run(rootPath, eventRootPath, recursive, filter)
	return backend, nil
}

func (b *fseventsWatchBackend) Events() <-chan watchBackendEvent { return b.queue.Events() }
func (b *fseventsWatchBackend) Errors() <-chan error             { return b.errors }
func (b *fseventsWatchBackend) TakeOverflow() uint64             { return b.queue.TakeOverflow() }

func (b *fseventsWatchBackend) Close() {
	b.once.Do(func() {
		// Keep the Go receiver alive until CoreServices has stopped callbacks;
		// fsevents' callback sends synchronously into EventStream.Events.
		b.stream.Stop()
		close(b.done)
	})
}

func (b *fseventsWatchBackend) run(rootPath, eventRootPath string, recursive bool, filter excludeFilter) {
	defer b.queue.Close()
	defer close(b.errors)
	for {
		select {
		case <-b.done:
			return
		case batch := <-b.stream.Events:
			for _, event := range batch {
				if event.Flags&fsevents.HistoryDone != 0 {
					continue
				}
				if event.Flags&fsevents.MustScanSubDirs != 0 {
					if !b.send(watchBackendEvent{overflow: true}) {
						return
					}
				}
				eventPath := filepath.Clean(event.Path)
				if !pathWithin(eventRootPath, eventPath) {
					continue
				}
				relativePath, err := filepath.Rel(eventRootPath, eventPath)
				if err != nil {
					continue
				}
				path := filepath.Join(rootPath, relativePath)
				directory := event.Flags&fsevents.ItemIsDir != 0
				if filter.excluded(path, directory) {
					continue
				}
				if !recursive && path != rootPath && filepath.Dir(path) != rootPath {
					continue
				}
				changeType, changed := fseventsChangeType(path, event.Flags)
				if !changed {
					continue
				}
				if !b.send(watchBackendEvent{path: path, changeType: changeType, directory: directory}) {
					return
				}
			}
		}
	}
}

func (b *fseventsWatchBackend) send(event watchBackendEvent) bool {
	return b.queue.Send(b.done, event)
}

func fseventsChangeType(path string, flags fsevents.EventFlags) (workspacev1.FileChangeType, bool) {
	if flags&fsevents.ItemRemoved != 0 {
		return workspacev1.FileChangeType_FILE_CHANGE_TYPE_DELETED, true
	}
	if flags&fsevents.ItemCreated != 0 {
		return workspacev1.FileChangeType_FILE_CHANGE_TYPE_ADDED, true
	}
	if flags&fsevents.ItemRenamed != 0 {
		if _, err := os.Stat(path); err == nil {
			return workspacev1.FileChangeType_FILE_CHANGE_TYPE_ADDED, true
		}
		return workspacev1.FileChangeType_FILE_CHANGE_TYPE_DELETED, true
	}
	if flags&fsevents.RootChanged != 0 {
		if _, err := os.Stat(path); err == nil {
			return workspacev1.FileChangeType_FILE_CHANGE_TYPE_UPDATED, true
		}
		return workspacev1.FileChangeType_FILE_CHANGE_TYPE_DELETED, true
	}
	if flags&(fsevents.ItemModified|fsevents.ItemInodeMetaMod|fsevents.ItemFinderInfoMod|fsevents.ItemChangeOwner|fsevents.ItemXattrMod) != 0 {
		return workspacev1.FileChangeType_FILE_CHANGE_TYPE_UPDATED, true
	}
	return workspacev1.FileChangeType_FILE_CHANGE_TYPE_UPDATED, false
}
