//go:build darwin && !cgo

package agent

import "errors"

func newWatchBackend(string, bool, bool, excludeFilter) (watchBackend, error) {
	return nil, errors.New("macOS workspace watching requires a CGO-enabled build")
}
