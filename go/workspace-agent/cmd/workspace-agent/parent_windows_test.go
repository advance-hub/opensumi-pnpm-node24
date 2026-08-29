//go:build windows

package main

import (
	"os"
	"os/exec"
	"testing"
)

func TestParentAliveUsesWindowsProcessHandle(t *testing.T) {
	if !parentAlive(os.Getpid()) {
		t.Fatal("current process was reported as stopped")
	}
	exited := exec.Command("cmd.exe", "/c", "exit", "0")
	if err := exited.Run(); err != nil {
		t.Fatal(err)
	}
	if parentAlive(exited.Process.Pid) {
		t.Fatal("exited process was reported as alive")
	}
}

func TestUnixSocketTransportIsRejectedOnWindows(t *testing.T) {
	if endpoint, err := listenLocal(`C:\\agent.sock`, ""); err == nil {
		_ = endpoint.listener.Close()
		endpoint.cleanup()
		t.Fatal("Unix socket transport was accepted on Windows")
	}
}
