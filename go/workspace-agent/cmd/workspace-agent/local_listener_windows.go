//go:build windows

package main

import "errors"

func listenUnixSocket(string) (*localEndpoint, error) {
	return nil, errors.New("--socket is not supported on Windows; use --tcp 127.0.0.1:0")
}
