//go:build !windows

package parentwatch

import (
	"os"
	"syscall"
)

func Alive(pid int) bool {
	process, err := os.FindProcess(pid)
	return err == nil && process.Signal(syscall.Signal(0)) == nil
}
