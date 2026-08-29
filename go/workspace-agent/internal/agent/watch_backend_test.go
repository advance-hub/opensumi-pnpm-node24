package agent

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	workspacev1 "github.com/opensumi/core/go/workspace-agent/gen/opensumi/workspace/v1"
)

type fakeWatchBackend struct {
	events   chan watchBackendEvent
	errors   chan error
	overflow atomic.Uint64
}

func newFakeWatchBackend() *fakeWatchBackend {
	return &fakeWatchBackend{
		events: make(chan watchBackendEvent),
		errors: make(chan error),
	}
}

func (b *fakeWatchBackend) Events() <-chan watchBackendEvent { return b.events }
func (b *fakeWatchBackend) Errors() <-chan error             { return b.errors }
func (b *fakeWatchBackend) TakeOverflow() uint64             { return b.overflow.Swap(0) }
func (b *fakeWatchBackend) Close()                           {}

type recordingWatchStream struct {
	ctx    context.Context
	events chan *workspacev1.WatchEvent
}

func (s *recordingWatchStream) Context() context.Context { return s.ctx }
func (s *recordingWatchStream) Send(event *workspacev1.WatchEvent) error {
	s.events <- event
	return nil
}

func TestWatchEventQueueDropsInsteadOfBlockingNativeProducer(t *testing.T) {
	queue := newWatchEventQueue(1)
	done := make(chan struct{})
	first := watchBackendEvent{path: "/workspace/first.txt"}
	second := watchBackendEvent{path: "/workspace/second.txt"}

	if !queue.Send(done, first) {
		t.Fatal("first queue send stopped unexpectedly")
	}
	secondResult := make(chan bool, 1)
	go func() { secondResult <- queue.Send(done, second) }()
	select {
	case sent := <-secondResult:
		if !sent {
			t.Fatal("full queue stopped the producer instead of recording overflow")
		}
	case <-time.After(250 * time.Millisecond):
		t.Fatal("full queue blocked the native producer")
	}

	if got := queue.TakeOverflow(); got != 1 {
		t.Fatalf("overflow count = %d, want 1", got)
	}
	if got := queue.TakeOverflow(); got != 0 {
		t.Fatalf("overflow count after drain = %d, want 0", got)
	}
	if got := <-queue.Events(); got.path != first.path {
		t.Fatalf("queued event path = %q, want %q", got.path, first.path)
	}

	close(done)
	if queue.Send(done, second) {
		t.Fatal("queue accepted an event after shutdown")
	}
	queue.Close()
}

func TestWatchPendingBatchUsesCountAndByteLimits(t *testing.T) {
	if got := watchChangeBytes("/workspace/file.txt"); got != len("/workspace/file.txt")*3+32 {
		t.Fatalf("watchChangeBytes() = %d", got)
	}
	if watchPendingWouldOverflow(1, watchPendingByteLimit-64, 64) {
		t.Fatal("exact byte boundary was rejected")
	}
	if !watchPendingWouldOverflow(1, watchPendingByteLimit-64, 65) {
		t.Fatal("byte limit overflow was accepted")
	}
	if !watchPendingWouldOverflow(watchPendingLimit, 0, 1) {
		t.Fatal("count limit overflow was accepted")
	}
	if !watchPendingWouldOverflow(0, 0, watchPendingByteLimit+1) {
		t.Fatal("oversized single change was accepted")
	}
	if watchPendingWouldOverflow(watchPendingLimit-1, watchPendingByteLimit-2, 1) {
		t.Fatal("batch below both limits was rejected")
	}
}

func TestRunWatchReportsBackendOverflowAndReleasesActiveCount(t *testing.T) {
	root := t.TempDir()
	backend := newFakeWatchBackend()
	backend.overflow.Store(7)
	ctx, cancel := context.WithCancel(context.Background())
	stream := &recordingWatchStream{ctx: ctx, events: make(chan *workspacev1.WatchEvent, 2)}
	server := NewServer("test")
	request := &workspacev1.WatchRequest{RootPath: root, Recursive: true}
	runError := make(chan error, 1)
	go func() {
		runError <- server.runWatch(request, stream, root, newExcludeFilter(root, nil), backend)
	}()

	select {
	case event := <-stream.events:
		if len(event.GetChanges()) != 0 || event.GetOverflow() != nil || event.GetFailure() != nil {
			t.Fatalf("unexpected watch readiness event: %+v", event)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for watch readiness acknowledgement")
	}
	select {
	case event := <-stream.events:
		overflow := event.GetOverflow()
		if overflow == nil {
			t.Fatal("WatchEvent did not contain backend overflow")
		}
		if overflow.GetResolvedUri() != fileURI(root) || overflow.GetEventCount() != 7 || overflow.GetLimit() != watchPendingLimit {
			t.Fatalf("unexpected overflow event: %+v", overflow)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for backend overflow event")
	}
	if got := server.activeWatches.Load(); got != 1 {
		t.Fatalf("active watch count while running = %d, want 1", got)
	}
	if got := backend.TakeOverflow(); got != 0 {
		t.Fatalf("backend overflow count after report = %d, want 0", got)
	}

	cancel()
	select {
	case err := <-runError:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("runWatch did not stop after stream cancellation")
	}
	if got := server.activeWatches.Load(); got != 0 {
		t.Fatalf("active watch count after cancellation = %d, want 0", got)
	}
}
