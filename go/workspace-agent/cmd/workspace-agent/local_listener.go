package main

import (
	"errors"
	"fmt"
	"net"
)

type localEndpoint struct {
	listener    net.Listener
	transport   string
	grpcAddress string
	cleanup     func()
}

func listenLocal(socketPath, tcpAddress string) (*localEndpoint, error) {
	if (socketPath == "") == (tcpAddress == "") {
		return nil, errors.New("exactly one of --socket or --tcp is required")
	}
	if socketPath != "" {
		return listenUnixSocket(socketPath)
	}
	return listenLoopbackTCP(tcpAddress)
}

func listenLoopbackTCP(address string) (*localEndpoint, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, fmt.Errorf("parse --tcp address: %w", err)
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() || port != "0" {
		return nil, errors.New("--tcp must use an ephemeral loopback address such as 127.0.0.1:0")
	}
	listener, err := net.Listen("tcp", address)
	if err != nil {
		return nil, fmt.Errorf("listen on loopback: %w", err)
	}
	return &localEndpoint{
		listener:    listener,
		transport:   "tcp-loopback",
		grpcAddress: listener.Addr().String(),
		cleanup:     func() {},
	}, nil
}
