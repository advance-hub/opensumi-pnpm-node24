package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/opensumi/core/go/workspace-agent/internal/agent"
	"github.com/opensumi/core/go/workspace-agent/internal/parentwatch"
	"google.golang.org/grpc"
)

var buildRevision = "development"

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintf(os.Stderr, "workspace-agent: %v\n", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	return runWithOutput(args, os.Stdout)
}

func runWithOutput(args []string, output io.Writer) error {
	flags := flag.NewFlagSet("workspace-agent", flag.ContinueOnError)
	socketPath := flags.String("socket", "", "Unix socket used by the trusted Node adapter")
	tcpAddress := flags.String("tcp", "", "ephemeral loopback address used by the trusted Node adapter on Windows")
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	token, err := consumeAgentToken()
	if err != nil {
		return err
	}
	endpoint, err := listenLocal(*socketPath, *tcpAddress)
	if err != nil {
		return err
	}
	defer endpoint.cleanup()
	defer endpoint.listener.Close()

	unaryAuth, streamAuth := agent.AuthInterceptors(token)
	grpcServer := grpc.NewServer(grpc.UnaryInterceptor(unaryAuth), grpc.StreamInterceptor(streamAuth))
	service := agent.NewServer(buildRevision)
	agent.Register(grpcServer, service)

	serveError := make(chan error, 1)
	go func() { serveError <- grpcServer.Serve(endpoint.listener) }()
	if err := json.NewEncoder(output).Encode(map[string]string{
		"event":     "workspace-agent-ready",
		"transport": endpoint.transport,
		"address":   endpoint.grpcAddress,
	}); err != nil {
		grpcServer.Stop()
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
	case <-service.ShutdownRequested():
	case <-shutdownSignal:
	case <-parentGone:
	}

	stopped := make(chan struct{})
	go func() {
		grpcServer.GracefulStop()
		close(stopped)
	}()
	stopTimer := time.NewTimer(2 * time.Second)
	defer stopTimer.Stop()
	select {
	case <-stopped:
	case <-stopTimer.C:
		grpcServer.Stop()
		<-stopped
	}
	return nil
}

func consumeAgentToken() (string, error) {
	token := os.Getenv("OPENSUMI_AGENT_TOKEN")
	if token == "" {
		return "", errors.New("OPENSUMI_AGENT_TOKEN is required")
	}
	if err := os.Unsetenv("OPENSUMI_AGENT_TOKEN"); err != nil {
		return "", fmt.Errorf("clear OPENSUMI_AGENT_TOKEN after startup: %w", err)
	}
	return token, nil
}

func monitorParent() (<-chan struct{}, func()) {
	parentPID, err := strconv.Atoi(os.Getenv("OPENSUMI_AGENT_PARENT_PID"))
	if err != nil || parentPID <= 1 {
		return parentwatch.Monitor(0, time.Second)
	}
	return parentwatch.Monitor(parentPID, time.Second)
}
