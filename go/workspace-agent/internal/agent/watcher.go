package agent

import (
	"context"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/bmatcuk/doublestar/v4"
	workspacev1 "github.com/opensumi/core/go/workspace-agent/gen/opensumi/workspace/v1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const (
	watchBatchInterval    = 50 * time.Millisecond
	watchPendingLimit     = 4096
	watchPendingByteLimit = 1024 * 1024
)

func (s *Server) Watch(request *workspacev1.WatchRequest, stream workspacev1.WorkspaceWatcher_WatchServer) error {
	if err := requireAbsolutePath(request.GetRootPath(), "root_path"); err != nil {
		return err
	}
	rootPath, err := filepath.Abs(request.GetRootPath())
	if err != nil {
		return status.Error(codes.InvalidArgument, "root_path is invalid")
	}
	info, err := os.Stat(rootPath)
	rootExists := err == nil
	if err != nil && !os.IsNotExist(err) {
		return internalError("inspect watch root", err)
	}
	if rootExists && !info.IsDir() {
		return status.Error(codes.InvalidArgument, "watch root must be a directory")
	}

	filter := newExcludeFilter(rootPath, request.GetExcludes())
	watcher, err := newWatchBackend(rootPath, rootExists, request.GetRecursive(), filter)
	if err != nil {
		return internalError("initialize watcher", err)
	}
	defer watcher.Close()
	return s.runWatch(request, stream, rootPath, filter, watcher)
}

type watchEventStream interface {
	Context() context.Context
	Send(*workspacev1.WatchEvent) error
}

func (s *Server) runWatch(
	request *workspacev1.WatchRequest,
	stream watchEventStream,
	rootPath string,
	filter excludeFilter,
	watcher watchBackend,
) error {
	s.activeWatches.Add(1)
	defer s.activeWatches.Add(^uint64(0))
	// Protocol 1.2 defines the first empty event as a readiness acknowledgement.
	// The backend is fully registered before runWatch starts, so clients can wait
	// for this frame before allowing callers to mutate the watched workspace.
	if err := stream.Send(&workspacev1.WatchEvent{}); err != nil {
		return err
	}

	ticker := time.NewTicker(watchBatchInterval)
	defer ticker.Stop()
	pending := make(map[string]workspacev1.FileChangeType)
	pendingBytes := 0
	var dropped uint64

	flush := func() error {
		dropped += watcher.TakeOverflow()
		if len(pending) == 0 && dropped == 0 {
			return nil
		}
		event := &workspacev1.WatchEvent{}
		if len(pending) > 0 {
			event.Changes = make([]*workspacev1.FileChange, 0, len(pending))
			for path, changeType := range pending {
				event.Changes = append(event.Changes, &workspacev1.FileChange{Uri: fileURI(path), Type: changeType})
			}
			clear(pending)
			pendingBytes = 0
		}
		if dropped > 0 {
			event.Overflow = &workspacev1.WatcherOverflow{
				ResolvedUri: fileURI(rootPath),
				EventCount:  dropped,
				Limit:       watchPendingLimit,
				TimestampMs: time.Now().UnixMilli(),
			}
			dropped = 0
		}
		return stream.Send(event)
	}

	for {
		select {
		case <-stream.Context().Done():
			return nil
		case event, ok := <-watcher.Events():
			if !ok {
				return nil
			}
			if event.overflow {
				dropped++
				continue
			}
			path := filepath.Clean(event.path)
			if !pathWithin(rootPath, path) {
				continue
			}
			if !request.GetRecursive() && path != rootPath && filepath.Dir(path) != rootPath {
				continue
			}
			if filter.excluded(path, event.directory) {
				continue
			}
			if _, exists := pending[path]; exists {
				pending[path] = event.changeType
				continue
			}
			changeBytes := watchChangeBytes(path)
			if watchPendingWouldOverflow(len(pending), pendingBytes, changeBytes) {
				dropped++
				continue
			}
			pending[path] = event.changeType
			pendingBytes += changeBytes
		case watcherErr, ok := <-watcher.Errors():
			if !ok {
				return nil
			}
			if err := stream.Send(&workspacev1.WatchEvent{Failure: &workspacev1.WatcherFailure{
				ResolvedUri: fileURI(rootPath),
				Message:     safeError(watcherErr),
				Attempts:    1,
				TimestampMs: time.Now().UnixMilli(),
			}}); err != nil {
				return err
			}
		case <-ticker.C:
			if err := flush(); err != nil {
				return err
			}
		}
	}
}

// A file URI can expand a path byte to a three-byte percent escape. The fixed
// allowance covers the protobuf field tag, enum and length prefixes without
// serializing every event twice on the hot path.
func watchChangeBytes(path string) int {
	return len(path)*3 + 32
}

func watchPendingWouldOverflow(pendingCount, pendingBytes, nextChangeBytes int) bool {
	return pendingCount >= watchPendingLimit || nextChangeBytes > watchPendingByteLimit || pendingBytes+nextChangeBytes > watchPendingByteLimit
}

func nearestExistingDirectory(path string) (string, error) {
	for {
		info, err := os.Stat(path)
		if err == nil {
			if !info.IsDir() {
				return "", status.Error(codes.InvalidArgument, "watch root ancestor must be a directory")
			}
			return path, nil
		}
		if !os.IsNotExist(err) {
			return "", err
		}
		parent := filepath.Dir(path)
		if parent == path {
			return "", err
		}
		path = parent
	}
}

func pathWithin(root, path string) bool {
	relative, err := filepath.Rel(root, path)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

func pathIsAncestorOrSelf(path, target string) bool {
	relative, err := filepath.Rel(path, target)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

type excludeFilter struct {
	root     string
	patterns []string
}

func newExcludeFilter(root string, patterns []string) excludeFilter {
	normalized := make([]string, 0, len(patterns))
	for _, pattern := range patterns {
		pattern = strings.TrimPrefix(filepath.ToSlash(strings.TrimSpace(pattern)), "./")
		pattern = strings.TrimPrefix(pattern, "/")
		if pattern != "" {
			normalized = append(normalized, pattern)
			if rootPattern := strings.TrimPrefix(pattern, "**/"); rootPattern != pattern {
				normalized = append(normalized, rootPattern)
			}
		}
	}
	return excludeFilter{root: filepath.Clean(root), patterns: normalized}
}

func (f excludeFilter) excluded(path string, directory bool) bool {
	relative, err := filepath.Rel(f.root, filepath.Clean(path))
	if err != nil || relative == "." {
		return false
	}
	relative = filepath.ToSlash(relative)
	for _, pattern := range f.patterns {
		matched, matchErr := doublestar.Match(pattern, relative)
		if matchErr == nil && matched {
			return true
		}
		if directory {
			for _, suffix := range []string{"/**/*", "/**"} {
				if strings.HasSuffix(pattern, suffix) {
					matched, matchErr = doublestar.Match(strings.TrimSuffix(pattern, suffix), relative)
					if matchErr == nil && matched {
						return true
					}
				}
			}
			matched, matchErr = doublestar.Match(pattern, relative+"/")
			if matchErr == nil && matched {
				return true
			}
		}
	}
	return false
}

func fileURI(path string) string {
	normalized := filepath.ToSlash(filepath.Clean(path))
	if !strings.HasPrefix(normalized, "/") {
		normalized = "/" + normalized
	}
	return (&url.URL{Scheme: "file", Path: normalized}).String()
}
