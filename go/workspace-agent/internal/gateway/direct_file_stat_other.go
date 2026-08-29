//go:build !darwin && !linux && !windows

package gateway

import "os"

func fileTimesMillis(_ string, _ os.FileInfo) (int64, int64, bool) {
	return 0, 0, false
}
