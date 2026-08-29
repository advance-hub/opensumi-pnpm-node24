//go:build !darwin

package agent

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/fsnotify/fsnotify"
	workspacev1 "github.com/opensumi/core/go/workspace-agent/gen/opensumi/workspace/v1"
)

type fsnotifyWatchBackend struct {
	watcher *fsnotify.Watcher
	queue   *watchEventQueue
	errors  chan error
	done    chan struct{}
	once    sync.Once
}

func newWatchBackend(rootPath string, rootExists, recursive bool, filter excludeFilter) (watchBackend, error) {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	backend := &fsnotifyWatchBackend{
		watcher: watcher,
		queue:   newWatchEventQueue(watchBackendEventQueueLimit),
		errors:  make(chan error, 8),
		done:    make(chan struct{}),
	}
	if rootExists {
		if parent := filepath.Dir(rootPath); parent != rootPath {
			if err := watcher.Add(parent); err != nil {
				backend.Close()
				return nil, err
			}
		}
		if recursive {
			if err := addRecursive(watcher, rootPath, filter); err != nil {
				backend.Close()
				return nil, err
			}
		} else if err := watcher.Add(rootPath); err != nil {
			backend.Close()
			return nil, err
		}
	} else {
		ancestor, err := nearestExistingDirectory(filepath.Dir(rootPath))
		if err != nil {
			backend.Close()
			return nil, err
		}
		if err := watcher.Add(ancestor); err != nil {
			backend.Close()
			return nil, err
		}
	}
	go backend.run(rootPath, rootExists, recursive, filter)
	return backend, nil
}

func (b *fsnotifyWatchBackend) Events() <-chan watchBackendEvent { return b.queue.Events() }
func (b *fsnotifyWatchBackend) Errors() <-chan error             { return b.errors }
func (b *fsnotifyWatchBackend) TakeOverflow() uint64             { return b.queue.TakeOverflow() }

func (b *fsnotifyWatchBackend) Close() {
	b.once.Do(func() {
		close(b.done)
		_ = b.watcher.Close()
	})
}

func (b *fsnotifyWatchBackend) run(rootPath string, rootExists, recursive bool, filter excludeFilter) {
	defer b.queue.Close()
	defer close(b.errors)
	for {
		select {
		case <-b.done:
			return
		case event, ok := <-b.watcher.Events:
			if !ok {
				return
			}
			path := filepath.Clean(event.Name)
			directory := false
			if event.Has(fsnotify.Create) {
				if created, statErr := os.Stat(path); statErr == nil && created.IsDir() {
					directory = true
					if !rootExists && pathIsAncestorOrSelf(path, rootPath) {
						activated, activationErr := activateMissingRoot(b.watcher, rootPath, path, recursive, filter)
						b.reportError(activationErr)
						if activated {
							rootExists = true
							b.reportError(b.emitExistingRoot(rootPath, recursive, filter))
						}
					}
				}
			}
			if rootExists && recursive && directory && pathWithin(rootPath, path) && path != rootPath && !filter.excluded(path, true) {
				b.reportError(addRecursive(b.watcher, path, filter))
			}
			changeType, changed := fsnotifyChangeType(event)
			if !changed {
				continue
			}
			if path == rootPath && (event.Has(fsnotify.Remove) || event.Has(fsnotify.Rename)) {
				rootExists = false
			}
			if !b.send(watchBackendEvent{path: path, changeType: changeType, directory: directory}) {
				return
			}
		case watcherErr, ok := <-b.watcher.Errors:
			if !ok {
				return
			}
			b.reportError(watcherErr)
		}
	}
}

// activateMissingRoot closes the inotify registration race created by a rapid
// mkdir -p. By the time the first ancestor event is handled, several deeper
// directories may already exist, so register the complete existing chain in a
// single pass instead of waiting for events that have already happened.
func activateMissingRoot(
	watcher *fsnotify.Watcher,
	rootPath string,
	createdPath string,
	recursive bool,
	filter excludeFilter,
) (bool, error) {
	if !pathIsAncestorOrSelf(createdPath, rootPath) {
		return false, nil
	}
	current := createdPath
	for {
		info, statErr := os.Stat(current)
		if errors.Is(statErr, os.ErrNotExist) {
			return false, nil
		}
		if statErr != nil {
			return false, statErr
		}
		if !info.IsDir() {
			return false, fmt.Errorf("watch root ancestor %s is not a directory", current)
		}
		if current == rootPath {
			if recursive {
				return true, addRecursive(watcher, rootPath, filter)
			}
			return true, watcher.Add(rootPath)
		}
		if err := watcher.Add(current); err != nil {
			return false, err
		}
		remainder, relErr := filepath.Rel(current, rootPath)
		if relErr != nil {
			return false, relErr
		}
		nextPart := strings.SplitN(remainder, string(filepath.Separator), 2)[0]
		if nextPart == "" || nextPart == "." || nextPart == ".." {
			return false, fmt.Errorf("invalid watch root remainder %q", remainder)
		}
		current = filepath.Join(current, nextPart)
	}
}

func (b *fsnotifyWatchBackend) emitExistingRoot(rootPath string, recursive bool, filter excludeFilter) error {
	return filepath.WalkDir(rootPath, func(path string, entry os.DirEntry, walkErr error) error {
		select {
		case <-b.done:
			return filepath.SkipAll
		default:
		}
		if walkErr != nil {
			if errors.Is(walkErr, os.ErrPermission) || errors.Is(walkErr, os.ErrNotExist) {
				return filepath.SkipDir
			}
			return walkErr
		}
		if path != rootPath {
			if !recursive && filepath.Dir(path) != rootPath {
				if entry.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
			if filter.excluded(path, entry.IsDir()) {
				if entry.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
		}
		if !b.send(watchBackendEvent{
			path:       path,
			changeType: workspacev1.FileChangeType_FILE_CHANGE_TYPE_ADDED,
			directory:  entry.IsDir(),
		}) {
			return filepath.SkipAll
		}
		return nil
	})
}

func (b *fsnotifyWatchBackend) send(event watchBackendEvent) bool {
	return b.queue.Send(b.done, event)
}

func (b *fsnotifyWatchBackend) reportError(err error) {
	if err == nil {
		return
	}
	select {
	case b.errors <- err:
	case <-b.done:
	default:
		b.queue.Drop(1)
	}
}

func addRecursive(watcher *fsnotify.Watcher, root string, filter excludeFilter) error {
	return filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			if errors.Is(walkErr, os.ErrPermission) || errors.Is(walkErr, os.ErrNotExist) {
				return filepath.SkipDir
			}
			return walkErr
		}
		if !entry.IsDir() {
			return nil
		}
		if path != root && filter.excluded(path, true) {
			return filepath.SkipDir
		}
		if err := watcher.Add(path); errors.Is(err, os.ErrNotExist) {
			return nil
		} else {
			return err
		}
	})
}

func fsnotifyChangeType(event fsnotify.Event) (workspacev1.FileChangeType, bool) {
	if event.Has(fsnotify.Remove) || event.Has(fsnotify.Rename) {
		return workspacev1.FileChangeType_FILE_CHANGE_TYPE_DELETED, true
	}
	if event.Has(fsnotify.Create) {
		return workspacev1.FileChangeType_FILE_CHANGE_TYPE_ADDED, true
	}
	if event.Has(fsnotify.Write) || event.Has(fsnotify.Chmod) {
		return workspacev1.FileChangeType_FILE_CHANGE_TYPE_UPDATED, true
	}
	return workspacev1.FileChangeType_FILE_CHANGE_TYPE_UPDATED, false
}
