//go:build !windows

package main

import (
	"context"
	"errors"
	"net"
	"os"
	"os/exec"
	"path/filepath"
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

func TestRunServesAuthenticatedControlAndShutsDown(t *testing.T) {
	t.Setenv("OPENSUMI_AGENT_TOKEN", "process-integration-token")
	t.Setenv("OPENSUMI_AGENT_PARENT_PID", "")
	socketPath := shortTestSocket(t, "agent.sock")
	runError := make(chan error, 1)
	go func() { runError <- run([]string{"--socket", socketPath}) }()

	waitForSocket(t, socketPath, runError)
	info, err := os.Stat(socketPath)
	if err != nil {
		t.Fatal(err)
	}
	if permissions := info.Mode().Perm(); permissions != 0o600 {
		t.Fatalf("socket permissions = %o, want 600", permissions)
	}

	connection := dialUnixGRPC(t, socketPath)
	defer connection.Close()
	client := workspacev1.NewAgentControlClient(connection)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := client.GetCapabilities(ctx, &workspacev1.GetCapabilitiesRequest{}); status.Code(err) != codes.Unauthenticated {
		t.Fatalf("unauthenticated GetCapabilities error = %v, want Unauthenticated", err)
	}

	authorized := metadata.AppendToOutgoingContext(ctx, "authorization", "Bearer process-integration-token")
	capabilities, err := client.GetCapabilities(authorized, &workspacev1.GetCapabilitiesRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if capabilities.GetProtocolMajor() != agent.ProtocolMajor || capabilities.GetProtocolMinor() != agent.ProtocolMinor {
		t.Fatalf(
			"protocol = %d.%d, want %d.%d",
			capabilities.GetProtocolMajor(),
			capabilities.GetProtocolMinor(),
			agent.ProtocolMajor,
			agent.ProtocolMinor,
		)
	}
	if capabilities.GetBuildRevision() != buildRevision {
		t.Fatalf("build revision = %q, want %q", capabilities.GetBuildRevision(), buildRevision)
	}
	if _, err := client.Shutdown(authorized, &workspacev1.ShutdownRequest{}); err != nil {
		t.Fatal(err)
	}
	waitForRunExit(t, runError)
	waitForSocketRemoval(t, socketPath)
}

func TestRunStopsWhenConfiguredParentIsGone(t *testing.T) {
	parent := exec.Command("sh", "-c", "exit 0")
	if err := parent.Start(); err != nil {
		t.Fatal(err)
	}
	parentPID := parent.Process.Pid
	if err := parent.Wait(); err != nil {
		t.Fatal(err)
	}

	t.Setenv("OPENSUMI_AGENT_TOKEN", "parent-lifecycle-token")
	t.Setenv("OPENSUMI_AGENT_PARENT_PID", strconv.Itoa(parentPID))
	socketPath := shortTestSocket(t, "parent-agent.sock")
	runError := make(chan error, 1)
	go func() { runError <- run([]string{"--socket", socketPath}) }()

	waitForSocket(t, socketPath, runError)
	waitForRunExit(t, runError)
	waitForSocketRemoval(t, socketPath)
}

func TestPrepareSocketRejectsNonSocketTarget(t *testing.T) {
	target := filepath.Join(t.TempDir(), "ordinary-file")
	if err := os.WriteFile(target, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := prepareSocket(target); err == nil {
		t.Fatal("prepareSocket accepted a non-socket target")
	}
	contents, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(contents) != "keep" {
		t.Fatalf("non-socket target changed to %q", contents)
	}
}

func dialUnixGRPC(t *testing.T, socketPath string) *grpc.ClientConn {
	t.Helper()
	connection, err := grpc.NewClient(
		"passthrough:///workspace-agent-process-test",
		grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", socketPath)
		}),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	if err != nil {
		t.Fatal(err)
	}
	return connection
}

func shortTestSocket(t *testing.T, name string) string {
	t.Helper()
	directory, err := os.MkdirTemp(os.TempDir(), "opensumi-wa-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(directory) })
	return filepath.Join(directory, name)
}

func waitForSocket(t *testing.T, socketPath string, runError <-chan error) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		select {
		case err := <-runError:
			t.Fatalf("workspace-agent exited before creating its socket: %v", err)
		default:
		}
		info, err := os.Stat(socketPath)
		if err == nil && info.Mode()&os.ModeSocket != 0 {
			return
		}
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			t.Fatal(err)
		}
		if time.Now().After(deadline) {
			t.Fatalf("socket %s was not created", socketPath)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func waitForSocketRemoval(t *testing.T, socketPath string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		_, err := os.Stat(socketPath)
		if errors.Is(err, os.ErrNotExist) {
			return
		}
		if err != nil {
			t.Fatal(err)
		}
		if time.Now().After(deadline) {
			t.Fatalf("socket %s was not removed", socketPath)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func waitForRunExit(t *testing.T, runError <-chan error) {
	t.Helper()
	select {
	case err := <-runError:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("workspace-agent did not stop")
	}
}
