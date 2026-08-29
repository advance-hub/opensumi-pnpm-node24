package agent

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"sync"
	"testing"
	"time"

	workspacev1 "github.com/opensumi/core/go/workspace-agent/gen/opensumi/workspace/v1"
	"google.golang.org/grpc/metadata"
)

const searchHelperEnvironment = "OPENSUMI_SEARCH_HELPER_SCENARIO"

type recordingSearchStream struct {
	ctx context.Context

	mu     sync.Mutex
	events []*workspacev1.SearchEvent
}

func newRecordingSearchStream(ctx context.Context) *recordingSearchStream {
	return &recordingSearchStream{ctx: ctx}
}

func (s *recordingSearchStream) Context() context.Context     { return s.ctx }
func (s *recordingSearchStream) SetHeader(metadata.MD) error  { return nil }
func (s *recordingSearchStream) SendHeader(metadata.MD) error { return nil }
func (s *recordingSearchStream) SetTrailer(metadata.MD)       {}
func (s *recordingSearchStream) SendMsg(any) error            { return nil }
func (s *recordingSearchStream) RecvMsg(any) error            { return nil }

func (s *recordingSearchStream) Send(event *workspacev1.SearchEvent) error {
	s.mu.Lock()
	s.events = append(s.events, event)
	s.mu.Unlock()
	return nil
}

func (s *recordingSearchStream) snapshot() []*workspacev1.SearchEvent {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]*workspacev1.SearchEvent(nil), s.events...)
}

func helperSearchCommand(ctx context.Context, _ string, _ ...string) *exec.Cmd {
	return exec.CommandContext(ctx, os.Args[0], "-test.run=TestWorkspaceSearchHelperProcess")
}

func TestWorkspaceSearchHelperProcess(t *testing.T) {
	scenario := os.Getenv(searchHelperEnvironment)
	if scenario == "" {
		return
	}

	switch scenario {
	case "unicode-and-limit":
		samples := []struct {
			text       string
			start, end int
		}{
			{text: "前缀 猫咪 后缀", start: 7, end: 10},
			{text: "second 猫", start: 7, end: 10},
			{text: "third 猫", start: 6, end: 9},
		}
		for index, sample := range samples {
			fmt.Printf(
				`{"type":"match","data":{"path":{"text":"/workspace/file-%d.txt"},"lines":{"text":%q},"line_number":%d,"absolute_offset":0,"submatches":[{"match":{"text":"猫"},"start":%d,"end":%d}]}}`+"\n",
				index+1,
				sample.text+"\n",
				index+1,
				sample.start,
				sample.end,
			)
		}
	case "wait-for-cancel":
		for {
			time.Sleep(time.Second)
		}
	default:
		os.Exit(2)
	}
	os.Exit(0)
}

func TestSearchStreamsUnicodeMatchesAndHonorsLimit(t *testing.T) {
	t.Setenv(searchHelperEnvironment, "unicode-and-limit")
	server := NewServer("test")
	server.searchCommand = helperSearchCommand
	stream := newRecordingSearchStream(context.Background())
	rootPath := t.TempDir()

	err := server.Search(&workspacev1.SearchRequest{
		Query:      "猫",
		RootPaths:  []string{rootPath},
		MaxResults: 2,
	}, stream)
	if err != nil {
		t.Fatal(err)
	}

	events := stream.snapshot()
	var matches []*workspacev1.SearchMatch
	limitHit := false
	for _, event := range events {
		matches = append(matches, event.GetMatches()...)
		limitHit = limitHit || event.GetLimitHit()
	}
	if len(matches) != 2 {
		t.Fatalf("received %d matches, want 2: %+v", len(matches), matches)
	}
	if matches[0].GetLineText() != "前缀 猫咪 后缀" || matches[0].GetStartByte() != 7 || matches[0].GetEndByte() != 10 {
		t.Fatalf("first Unicode match changed in transit: %+v", matches[0])
	}
	if !limitHit {
		t.Fatal("max_results stopped the process without reporting limit_hit")
	}
	if got := server.activeSearches.Load(); got != 0 {
		t.Fatalf("active searches after completion = %d, want 0", got)
	}
}

func TestSearchCancellationStopsChildAndReleasesActiveCount(t *testing.T) {
	t.Setenv(searchHelperEnvironment, "wait-for-cancel")
	server := NewServer("test")
	server.searchCommand = helperSearchCommand
	ctx, cancel := context.WithCancel(context.Background())
	stream := newRecordingSearchStream(ctx)
	rootPath := t.TempDir()
	done := make(chan error, 1)
	go func() {
		done <- server.Search(&workspacev1.SearchRequest{
			Query:     "first",
			RootPaths: []string{rootPath},
		}, stream)
	}()

	deadline := time.Now().Add(3 * time.Second)
	for server.activeSearches.Load() != 1 {
		select {
		case err := <-done:
			t.Fatalf("search stopped before becoming active: %v", err)
		default:
		}
		if time.Now().After(deadline) {
			t.Fatal("timed out waiting for the search child to become active")
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("cancelled search returned an error: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("search child survived stream cancellation")
	}
	if got := server.activeSearches.Load(); got != 0 {
		t.Fatalf("active searches after cancellation = %d, want 0", got)
	}
}
