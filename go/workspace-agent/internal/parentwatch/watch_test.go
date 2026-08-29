package parentwatch

import (
	"os"
	"testing"
	"time"
)

func TestMonitorStopsSynchronously(t *testing.T) {
	parentGone, stop := Monitor(os.Getpid(), time.Millisecond)
	stop()
	select {
	case <-parentGone:
		t.Fatal("live parent was reported as gone")
	default:
	}
}
