package parentwatch

import (
	"sync"
	"time"
)

func Monitor(pid int, interval time.Duration) (<-chan struct{}, func()) {
	parentGone := make(chan struct{})
	if pid <= 1 {
		return parentGone, func() {}
	}
	if interval <= 0 {
		interval = time.Second
	}
	stop := make(chan struct{})
	stopped := make(chan struct{})
	var stopOnce sync.Once
	go func() {
		defer close(stopped)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				if !Alive(pid) {
					close(parentGone)
					return
				}
			}
		}
	}()
	return parentGone, func() {
		stopOnce.Do(func() { close(stop) })
		<-stopped
	}
}
