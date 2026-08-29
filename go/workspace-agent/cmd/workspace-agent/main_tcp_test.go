package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"strconv"
	"testing"
	"time"

	workspacev1 "github.com/opensumi/core/go/workspace-agent/gen/opensumi/workspace/v1"
	"github.com/opensumi/core/go/workspace-agent/internal/agent"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

func TestRunServesAuthenticatedControlOverEphemeralLoopback(t *testing.T) {
	t.Setenv("OPENSUMI_AGENT_TOKEN", "loopback-process-token")
	t.Setenv("OPENSUMI_AGENT_PARENT_PID", "")
	reader, writer := io.Pipe()
	t.Cleanup(func() {
		_ = reader.Close()
		_ = writer.Close()
	})
	runError := make(chan error, 1)
	go func() { runError <- runWithOutput([]string{"--tcp", "127.0.0.1:0"}, writer) }()

	var ready struct {
		Event     string `json:"event"`
		Transport string `json:"transport"`
		Address   string `json:"address"`
	}
	if err := json.NewDecoder(reader).Decode(&ready); err != nil {
		t.Fatal(err)
	}
	if ready.Event != "workspace-agent-ready" || ready.Transport != "tcp-loopback" {
		t.Fatalf("unexpected ready event: %+v", ready)
	}
	if _, exists := os.LookupEnv("OPENSUMI_AGENT_TOKEN"); exists {
		t.Fatal("OPENSUMI_AGENT_TOKEN remained in the Agent environment after startup")
	}
	host, port, err := net.SplitHostPort(ready.Address)
	if err != nil || net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback() || port == "0" {
		t.Fatalf("ready address %q is not an allocated loopback port", ready.Address)
	}

	connection, err := grpc.NewClient(ready.Address, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	client := workspacev1.NewAgentControlClient(connection)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := client.GetCapabilities(ctx, &workspacev1.GetCapabilitiesRequest{}); status.Code(err) != codes.Unauthenticated {
		t.Fatalf("unauthenticated GetCapabilities error = %v, want Unauthenticated", err)
	}
	authorized := metadata.AppendToOutgoingContext(ctx, "authorization", "Bearer loopback-process-token")
	capabilities, err := client.GetCapabilities(authorized, &workspacev1.GetCapabilitiesRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if capabilities.GetProtocolMajor() != agent.ProtocolMajor {
		t.Fatalf("protocol major = %d, want %d", capabilities.GetProtocolMajor(), agent.ProtocolMajor)
	}
	if _, err := client.Shutdown(authorized, &workspacev1.ShutdownRequest{}); err != nil {
		t.Fatal(err)
	}
	waitForAgentExit(t, runError)
}

func TestListenLocalRequiresOnePrivateTransport(t *testing.T) {
	for _, test := range []struct {
		name   string
		socket string
		tcp    string
	}{
		{name: "neither"},
		{name: "both", socket: "/tmp/agent.sock", tcp: "127.0.0.1:0"},
		{name: "non-loopback", tcp: "0.0.0.0:0"},
		{name: "fixed-port", tcp: "127.0.0.1:50051"},
	} {
		t.Run(test.name, func(t *testing.T) {
			endpoint, err := listenLocal(test.socket, test.tcp)
			if endpoint != nil {
				_ = endpoint.listener.Close()
				endpoint.cleanup()
			}
			if err == nil {
				t.Fatalf("listenLocal(%q, %q) succeeded", test.socket, test.tcp)
			}
		})
	}
}

func TestMonitorParentCanStopWhileParentIsAlive(t *testing.T) {
	t.Setenv("OPENSUMI_AGENT_PARENT_PID", strconv.Itoa(os.Getpid()))
	parentGone, stop := monitorParent()
	stopped := make(chan struct{})
	go func() {
		stop()
		close(stopped)
	}()

	select {
	case <-stopped:
	case <-time.After(250 * time.Millisecond):
		t.Fatal("parent monitor did not stop promptly")
	}
	select {
	case <-parentGone:
		t.Fatal("stopping the monitor reported the live parent as gone")
	default:
	}
	stop()
}

func waitForAgentExit(t *testing.T, runError <-chan error) {
	t.Helper()
	select {
	case err := <-runError:
		if err != nil && !errors.Is(err, net.ErrClosed) {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("workspace-agent did not stop")
	}
}
