//go:build linux

package gateway

import (
	"os"
	"syscall"
)

func fileTimesMillis(_ string, info os.FileInfo) (int64, int64, bool) {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, 0, false
	}
	return nodeTimespecMillis(stat.Mtim.Sec, stat.Mtim.Nsec),
		nodeTimespecMillis(stat.Ctim.Sec, stat.Ctim.Nsec), true
}
