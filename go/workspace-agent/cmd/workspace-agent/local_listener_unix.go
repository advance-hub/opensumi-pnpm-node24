//go:build !windows

package main

import (
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
)

func listenUnixSocket(socketPath string) (*localEndpoint, error) {
	if err := prepareSocket(socketPath); err != nil {
		return nil, err
	}
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		return nil, fmt.Errorf("listen on Unix socket: %w", err)
	}
	if err := os.Chmod(socketPath, 0o600); err != nil {
		_ = listener.Close()
		_ = os.Remove(socketPath)
		return nil, fmt.Errorf("restrict socket permissions: %w", err)
	}
	return &localEndpoint{
		listener:    listener,
		transport:   "unix",
		grpcAddress: "unix:" + socketPath,
		cleanup:     func() { _ = os.Remove(socketPath) },
	}, nil
}

func prepareSocket(socketPath string) error {
	if !filepath.IsAbs(socketPath) {
		return errors.New("--socket must be an absolute path")
	}
	if err := os.MkdirAll(filepath.Dir(socketPath), 0o700); err != nil {
		return fmt.Errorf("create socket directory: %w", err)
	}
	info, err := os.Lstat(socketPath)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect socket path: %w", err)
	}
	if info.Mode()&os.ModeSocket == 0 {
		return errors.New("refusing to replace a non-socket path")
	}
	return os.Remove(socketPath)
}
