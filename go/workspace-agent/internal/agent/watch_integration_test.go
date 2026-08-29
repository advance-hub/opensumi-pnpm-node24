//go:build linux || (darwin && cgo)

package agent

import (
	"context"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sort"
	"testing"
	"time"

	workspacev1 "github.com/opensumi/core/go/workspace-agent/gen/opensumi/workspace/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/test/bufconn"
)

const (
	watchLatencySamples = 20
	watchLatencyP95SLO  = 750 * time.Millisecond
)

func TestWorkspaceWatcherLatencyAndCancellation(t *testing.T) {
	token := "watch-integration-test"
	listener := bufconn.Listen(1024 * 1024)
	unaryAuth, streamAuth := AuthInterceptors(token)
	grpcServer := grpc.NewServer(grpc.UnaryInterceptor(unaryAuth), grpc.StreamInterceptor(streamAuth))
	service := NewServer("test")
	Register(grpcServer, service)
	serveError := make(chan error, 1)
	go func() { serveError <- grpcServer.Serve(listener) }()
	t.Cleanup(func() {
		grpcServer.Stop()
		_ = listener.Close()
		select {
		case err := <-serveError:
			if err != nil && err != grpc.ErrServerStopped {
				t.Errorf("gRPC server failed: %v", err)
			}
		default:
		}
	})

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	connection, err := grpc.NewClient(
		"passthrough:///workspace-agent-test",
		grpc.WithContextDialer(func(context.Context, string) (net.Conn, error) { return listener.Dial() }),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = connection.Close() })
	authorizedContext := metadata.AppendToOutgoingContext(ctx, "authorization", "Bearer "+token)
	controlClient := workspacev1.NewAgentControlClient(connection)
	watchClient := workspacev1.NewWorkspaceWatcherClient(connection)

	root := t.TempDir()
	watchContext, cancelWatch := context.WithCancel(authorizedContext)
	stream, err := watchClient.Watch(watchContext, &workspacev1.WatchRequest{
		WorkspaceId: "latency-test",
		RootPath:    root,
		Recursive:   true,
	})
	if err != nil {
		t.Fatal(err)
	}
	waitForActiveWatchCount(t, authorizedContext, controlClient, 1)
	// Health changes after the backend is constructed. Give the native dispatch
	// queue one short settling window before producing the first measured event.
	time.Sleep(150 * time.Millisecond)

	latencies := make([]time.Duration, 0, watchLatencySamples)
	for index := 0; index < watchLatencySamples; index++ {
		target := filepath.Join(root, fmt.Sprintf("latency-%02d.txt", index))
		startedAt := time.Now()
		if err := os.WriteFile(target, []byte("event"), 0o600); err != nil {
			t.Fatal(err)
		}
		for {
			event, receiveErr := stream.Recv()
			if receiveErr != nil {
				t.Fatalf("watch stream ended before %s was delivered: %v", target, receiveErr)
			}
			matched := false
			for _, change := range event.GetChanges() {
				if change.GetUri() == fileURI(target) {
					matched = true
					break
				}
			}
			if matched {
				latencies = append(latencies, time.Since(startedAt))
				break
			}
		}
	}

	p95 := durationPercentile(latencies, 0.95)
	if p95 > watchLatencyP95SLO {
		t.Fatalf("watch event P95 %s exceeded %s SLO (samples: %v)", p95, watchLatencyP95SLO, latencies)
	}
	t.Logf("watch event latency: samples=%d p50=%s p95=%s", len(latencies), durationPercentile(latencies, 0.5), p95)

	cancelWatch()
	waitForActiveWatchCount(t, authorizedContext, controlClient, 0)
}

func waitForActiveWatchCount(
	t *testing.T,
	ctx context.Context,
	client workspacev1.AgentControlClient,
	want uint64,
) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		health, err := client.Health(ctx, &workspacev1.HealthRequest{})
		if err != nil {
			t.Fatal(err)
		}
		if health.GetActiveWatches() == want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("active watch count = %d, want %d", health.GetActiveWatches(), want)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func durationPercentile(values []time.Duration, quantile float64) time.Duration {
	if len(values) == 0 {
		return 0
	}
	sorted := append([]time.Duration(nil), values...)
	sort.Slice(sorted, func(left, right int) bool { return sorted[left] < sorted[right] })
	rank := int(float64(len(sorted))*quantile + 0.999999999)
	if rank < 1 {
		rank = 1
	}
	return sorted[rank-1]
}
