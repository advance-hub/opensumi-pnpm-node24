package agent

import (
	"sync/atomic"

	workspacev1 "github.com/opensumi/core/go/workspace-agent/gen/opensumi/workspace/v1"
)

const watchBackendEventQueueLimit = 256

type watchBackendEvent struct {
	path       string
	changeType workspacev1.FileChangeType
	directory  bool
	overflow   bool
}

type watchBackend interface {
	Events() <-chan watchBackendEvent
	Errors() <-chan error
	TakeOverflow() uint64
	Close()
}

// watchEventQueue prevents a slow gRPC consumer from blocking the native OS
// callback or the fsnotify drain loop. Once the fixed-size queue is full, new
// events are counted as overflow and the Watch RPC reports that count on its
// next flush so consumers can observe that their view may need reconciliation.
type watchEventQueue struct {
	events  chan watchBackendEvent
	dropped atomic.Uint64
}

func newWatchEventQueue(limit int) *watchEventQueue {
	return &watchEventQueue{events: make(chan watchBackendEvent, limit)}
}

func (q *watchEventQueue) Events() <-chan watchBackendEvent {
	return q.events
}

func (q *watchEventQueue) Send(done <-chan struct{}, event watchBackendEvent) bool {
	select {
	case <-done:
		return false
	default:
	}

	select {
	case q.events <- event:
		return true
	case <-done:
		return false
	default:
		q.Drop(1)
		return true
	}
}

func (q *watchEventQueue) Drop(count uint64) {
	q.dropped.Add(count)
}

func (q *watchEventQueue) TakeOverflow() uint64 {
	return q.dropped.Swap(0)
}

func (q *watchEventQueue) Close() {
	close(q.events)
}
