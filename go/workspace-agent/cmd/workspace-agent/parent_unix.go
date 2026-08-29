//go:build !windows

package main

import "github.com/opensumi/core/go/workspace-agent/internal/parentwatch"

func parentAlive(pid int) bool {
	return parentwatch.Alive(pid)
}
