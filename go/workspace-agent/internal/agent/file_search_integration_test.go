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

const fileSearchHelperEnvironment = "OPENSUMI_FILE_SEARCH_HELPER_SCENARIO"

type recordingFileSearchStream struct {
	ctx context.Context

	mu     sync.Mutex
	events []*workspacev1.FileSearchEvent
}

func (s *recordingFileSearchStream) Context() context.Context     { return s.ctx }
func (s *recordingFileSearchStream) SetHeader(metadata.MD) error  { return nil }
func (s *recordingFileSearchStream) SendHeader(metadata.MD) error { return nil }
func (s *recordingFileSearchStream) SetTrailer(metadata.MD)       {}
func (s *recordingFileSearchStream) SendMsg(any) error            { return nil }
func (s *recordingFileSearchStream) RecvMsg(any) error            { return nil }

func (s *recordingFileSearchStream) Send(event *workspacev1.FileSearchEvent) error {
	s.mu.Lock()
	s.events = append(s.events, event)
	s.mu.Unlock()
	return nil
}

func (s *recordingFileSearchStream) snapshot() []*workspacev1.FileSearchEvent {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]*workspacev1.FileSearchEvent(nil), s.events...)
}

func helperFileSearchCommand(ctx context.Context, _ string, _ ...string) *exec.Cmd {
	executable, err := os.Executable()
	if err != nil {
		panic(err)
	}
	return exec.CommandContext(ctx, executable, "-test.run=TestWorkspaceFileSearchHelperProcess")
}

func TestWorkspaceFileSearchHelperProcess(t *testing.T) {
	scenario := os.Getenv(fileSearchHelperEnvironment)
	if scenario == "" {
		return
	}
	switch scenario {
	case "paths":
		fmt.Println("src/server.ts")
		fmt.Println("src/start-server.ts")
		fmt.Println("src/super-runtime-version-router.ts")
		fmt.Println("README.md")
	case "wait-for-cancel":
		for {
			time.Sleep(time.Second)
		}
	default:
		os.Exit(2)
	}
	os.Exit(0)
}

func TestFileSearchClassifiesPathsAndHonorsLimit(t *testing.T) {
	t.Setenv(fileSearchHelperEnvironment, "paths")
	server := NewServer("test")
	server.fileSearchCommand = helperFileSearchCommand
	stream := &recordingFileSearchStream{ctx: context.Background()}

	err := server.Find(&workspacev1.FileSearchRequest{
		Pattern:     "server",
		FuzzyMatch:  true,
		MaxResults:  3,
		Roots:       []*workspacev1.FileSearchRoot{{RootPath: t.TempDir(), UseGitIgnore: true}},
		RipgrepPath: "ignored-by-helper",
	}, stream)
	if err != nil {
		t.Fatal(err)
	}

	var exact, fuzzy []string
	limitHit := false
	for _, event := range stream.snapshot() {
		exact = append(exact, event.GetExactPaths()...)
		fuzzy = append(fuzzy, event.GetFuzzyPaths()...)
		limitHit = limitHit || event.GetLimitHit()
	}
	if len(exact) != 2 || len(fuzzy) != 1 {
		t.Fatalf("exact = %v, fuzzy = %v, want two exact and one fuzzy path", exact, fuzzy)
	}
	if !limitHit {
		t.Fatal("file search reached max_results without reporting limit_hit")
	}
	if got := server.activeFileSearches.Load(); got != 0 {
		t.Fatalf("active file searches after completion = %d, want 0", got)
	}
}

func TestFileSearchCancellationStopsChildAndReleasesActiveCount(t *testing.T) {
	t.Setenv(fileSearchHelperEnvironment, "wait-for-cancel")
	server := NewServer("test")
	server.fileSearchCommand = helperFileSearchCommand
	ctx, cancel := context.WithCancel(context.Background())
	stream := &recordingFileSearchStream{ctx: ctx}
	root := t.TempDir()
	done := make(chan error, 1)
	go func() {
		done <- server.Find(&workspacev1.FileSearchRequest{
			Pattern:     "server",
			Roots:       []*workspacev1.FileSearchRoot{{RootPath: root, UseGitIgnore: true}},
			RipgrepPath: "ignored-by-helper",
		}, stream)
	}()

	deadline := time.Now().Add(3 * time.Second)
	for server.activeFileSearches.Load() != 1 {
		select {
		case err := <-done:
			t.Fatalf("file search stopped before becoming active: %v", err)
		default:
		}
		if time.Now().After(deadline) {
			t.Fatal("timed out waiting for the file search child to become active")
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("cancelled file search returned an error: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("file search child survived stream cancellation")
	}
	if got := server.activeFileSearches.Load(); got != 0 {
		t.Fatalf("active file searches after cancellation = %d, want 0", got)
	}
}
