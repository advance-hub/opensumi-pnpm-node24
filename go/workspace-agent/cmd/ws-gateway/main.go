package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/opensumi/core/go/workspace-agent/internal/gateway"
	"github.com/opensumi/core/go/workspace-agent/internal/parentwatch"
)

var buildRevision = "development"

func main() {
	if err := run(os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintf(os.Stderr, "ws-gateway: %v\n", err)
		os.Exit(1)
	}
}

func run(args []string, output io.Writer) error {
	flags := flag.NewFlagSet("ws-gateway", flag.ContinueOnError)
	listenAddress := flags.String("listen", "127.0.0.1:8000", "public HTTP and WebSocket listen address")
	nodeHTTPURL := flags.String("node-http", "", "private Node HTTP backend URL")
	channelNetwork := flags.String("channel-network", "", "private Node channel network: unix or tcp")
	channelAddress := flags.String("channel-address", "", "private Node channel address")
	channelMode := flags.String("channel-mode", "direct", "private Node channel mode: direct or multiplex-v1")
	servicePath := flags.String("service-path", "/service", "public OpenSumi WebSocket path")
	admissionPath := flags.String("admission-path", "", "optional private Node readiness path checked before upgrade")
	maxPayloadBytes := flags.Int64("max-payload-bytes", 32*1024*1024, "maximum WebSocket message size")
	maxBufferedBytes := flags.Int64("max-buffered-bytes", 16*1024*1024, "maximum queued bytes per multiplexed logical stream")
	maxConnections := flags.Int("max-connections", 1_000, "maximum concurrent WebSocket connections")
	heartbeatInterval := flags.Duration("heartbeat-interval", 30*time.Second, "WebSocket ping interval")
	writeTimeout := flags.Duration("write-timeout", 10*time.Second, "per-message write timeout")
	dialTimeout := flags.Duration("dial-timeout", 5*time.Second, "private Node channel dial timeout")
	directFileRPC := flags.Bool("direct-file-rpc", false, "serve compatible DiskFileService read RPCs directly in Go")
	directFileReadMaxBytes := flags.Int64("direct-file-read-max-bytes", 8*1024*1024, "largest file served directly before Node fallback")
	directFileMetadataMaxBytes := flags.Int64("direct-file-metadata-max-bytes", 1024*1024, "largest metadata response built directly before Node fallback")
	directFileRPCMaxConcurrent := flags.Int("direct-file-rpc-max-concurrent", 16, "maximum simultaneous direct file RPCs before Node fallback")
	diagnosticsPath := flags.String("diagnostics-path", "/_opensumi/ws-gateway", "public read-only Gateway diagnostics path")
	shutdownTimeout := flags.Duration("shutdown-timeout", 3*time.Second, "graceful shutdown timeout")
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if flags.NArg() != 0 {
		return fmt.Errorf("unexpected positional arguments: %v", flags.Args())
	}

	server, err := gateway.New(gateway.Config{
		NodeHTTPURL:                *nodeHTTPURL,
		ChannelNetwork:             *channelNetwork,
		ChannelAddress:             *channelAddress,
		ChannelMode:                *channelMode,
		ServicePath:                *servicePath,
		AdmissionPath:              *admissionPath,
		MaxPayloadBytes:            *maxPayloadBytes,
		MaxBufferedBytes:           *maxBufferedBytes,
		MaxConnections:             *maxConnections,
		HeartbeatInterval:          *heartbeatInterval,
		WriteTimeout:               *writeTimeout,
		DialTimeout:                *dialTimeout,
		DirectFileRPC:              *directFileRPC,
		DirectFileReadMaxBytes:     *directFileReadMaxBytes,
		DirectFileMetadataMaxBytes: *directFileMetadataMaxBytes,
		DirectFileRPCMaxConcurrent: *directFileRPCMaxConcurrent,
		DiagnosticsPath:            *diagnosticsPath,
	})
	if err != nil {
		return err
	}
	listener, err := net.Listen("tcp", *listenAddress)
	if err != nil {
		return fmt.Errorf("listen on %s: %w", *listenAddress, err)
	}
	defer listener.Close()

	serveError := make(chan error, 1)
	go func() { serveError <- server.Serve(listener) }()
	if err := json.NewEncoder(output).Encode(map[string]any{
		"event":         "opensumi-ws-gateway-ready",
		"address":       listener.Addr().String(),
		"revision":      buildRevision,
		"channelMode":   *channelMode,
		"directFileRPC": *directFileRPC,
	}); err != nil {
		shutdownContext, cancel := context.WithTimeout(context.Background(), *shutdownTimeout)
		defer cancel()
		_ = server.Shutdown(shutdownContext)
		return fmt.Errorf("announce listener: %w", err)
	}

	shutdownSignal := make(chan os.Signal, 1)
	signal.Notify(shutdownSignal, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(shutdownSignal)
	parentGone, stopParentMonitor := monitorParent()
	defer stopParentMonitor()

	select {
	case err := <-serveError:
		return err
	case <-shutdownSignal:
	case <-parentGone:
	}

	shutdownContext, cancel := context.WithTimeout(context.Background(), *shutdownTimeout)
	defer cancel()
	if err := server.Shutdown(shutdownContext); err != nil {
		return fmt.Errorf("shutdown gateway: %w", err)
	}
	return <-serveError
}

func monitorParent() (<-chan struct{}, func()) {
	parentPID, err := strconv.Atoi(os.Getenv("OPENSUMI_GATEWAY_PARENT_PID"))
	if err != nil || parentPID <= 1 {
		return parentwatch.Monitor(0, time.Second)
	}
	return parentwatch.Monitor(parentPID, time.Second)
}
