package agent

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	workspacev1 "github.com/opensumi/core/go/workspace-agent/gen/opensumi/workspace/v1"
)

func TestCapabilitiesAdvertiseFileSearchProtocol(t *testing.T) {
	server := NewServer("test")
	capabilities, err := server.GetCapabilities(context.Background(), &workspacev1.GetCapabilitiesRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if capabilities.GetProtocolMinor() != 1 || !containsString(capabilities.GetServices(), "workspace.fileSearch.v1") {
		t.Fatalf("file search capability missing: %+v", capabilities)
	}
}

func TestSearchArgsFixedString(t *testing.T) {
	request := &workspacev1.SearchRequest{
		Query:          "ServerApp",
		Include:        []string{"**/*.ts"},
		Exclude:        []string{"**/node_modules/**"},
		FollowSymlinks: true,
	}
	args, query := searchArgs(request)
	want := []string{
		"--json",
		"--max-count=100",
		"--ignore-case",
		"--glob=**/*.ts",
		"--glob=!**/node_modules/**",
		"--follow",
		"--fixed-strings",
		"--",
	}
	if query != "ServerApp" {
		t.Fatalf("query = %q, want ServerApp", query)
	}
	if !reflect.DeepEqual(args, want) {
		t.Fatalf("args = %#v, want %#v", args, want)
	}
}

func TestSearchArgsWholeWordEscapesPattern(t *testing.T) {
	args, query := searchArgs(&workspacev1.SearchRequest{Query: "hello.world", MatchWholeWord: true})
	if query != `\bhello\.world\b` {
		t.Fatalf("query = %q", query)
	}
	if args[len(args)-1] != "--regexp" {
		t.Fatalf("last arg = %q, want --regexp", args[len(args)-1])
	}
}

func TestChildProcessEnvironmentRemovesAgentCredential(t *testing.T) {
	environment := childProcessEnvironment([]string{
		"PATH=/usr/bin",
		"OPENSUMI_AGENT_TOKEN=secret",
		"opensumi_agent_token=case-insensitive-secret",
		"OPENSUMI_AGENT_PARENT_PID=123",
		"ENTRY_WITHOUT_VALUE",
	})
	want := []string{"PATH=/usr/bin", "OPENSUMI_AGENT_PARENT_PID=123", "ENTRY_WITHOUT_VALUE"}
	if !reflect.DeepEqual(environment, want) {
		t.Fatalf("child environment = %#v, want %#v", environment, want)
	}
}

func TestSearchMatchBytesIncludesPayloadAndWireAllowance(t *testing.T) {
	match := &workspacev1.SearchMatch{Path: "/workspace/file.ts", LineText: "const value = 1"}
	want := len(match.GetPath()) + len(match.GetLineText()) + 32
	if got := searchMatchBytes(match); got != want {
		t.Fatalf("search match bytes = %d, want %d", got, want)
	}
	if searchMatchBytes(nil) != 0 {
		t.Fatal("nil search match consumed batch bytes")
	}
}

func TestSearchBatchUsesCountAndByteLimits(t *testing.T) {
	if searchBatchWouldExceed(0, 0, searchBatchByteLimit+1) {
		t.Fatal("an oversized single match was rejected instead of being sent alone")
	}
	if searchBatchWouldExceed(1, searchBatchByteLimit-10, 10) {
		t.Fatal("a match that exactly fills the byte budget was flushed early")
	}
	if !searchBatchWouldExceed(1, searchBatchByteLimit-10, 11) {
		t.Fatal("a match that exceeds the byte budget did not flush the existing batch")
	}
	if !searchBatchFull(searchBatchSize, 1) || !searchBatchFull(1, searchBatchByteLimit) {
		t.Fatal("a batch at its count or byte limit was not full")
	}
	if searchBatchFull(searchBatchSize-1, searchBatchByteLimit-1) {
		t.Fatal("a batch below both limits was full")
	}
}

func TestFileSearchArgsPreserveNodeIgnoreAndGlobSemantics(t *testing.T) {
	root := &workspacev1.FileSearchRoot{
		RootPath:       "/workspace",
		Include:        []string{"**/*.ts"},
		Exclude:        []string{"**/node_modules/**"},
		UseGitIgnore:   true,
		NoIgnoreParent: true,
		FollowSymlinks: true,
	}
	want := []string{
		"--files",
		"--hidden",
		"--case-sensitive",
		"--no-require-git",
		"--glob",
		"**/*.ts",
		"--glob",
		"!**/node_modules/**",
		"--no-ignore-parent",
		"--follow",
	}
	if got := fileSearchArgs(root); !reflect.DeepEqual(got, want) {
		t.Fatalf("file search args = %#v, want %#v", got, want)
	}

	root.UseGitIgnore = false
	if got := fileSearchArgs(root); !containsString(got, "-uu") {
		t.Fatalf("file search args did not disable ignore files: %#v", got)
	}
}

func TestFuzzySubsequenceMatchesWithoutRenderedAllocations(t *testing.T) {
	for _, test := range []struct {
		pattern   string
		candidate string
		want      bool
	}{
		{pattern: "srvr", candidate: "server/src/start-server.ts", want: true},
		{pattern: "猫咪", candidate: "src/猫-咪/file.ts", want: true},
		{pattern: "abc", candidate: "acb.ts", want: false},
		{pattern: "", candidate: "anything", want: true},
	} {
		if got := fuzzySubsequence(test.pattern, test.candidate); got != test.want {
			t.Fatalf("fuzzySubsequence(%q, %q) = %v, want %v", test.pattern, test.candidate, got, test.want)
		}
	}
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func TestExcludeFilterHandlesRecursivePatterns(t *testing.T) {
	root := filepath.Join(string(filepath.Separator), "workspace")
	filter := newExcludeFilter(root, []string{"**/node_modules/**/*", "**/.git/objects/**"})
	if !filter.excluded(filepath.Join(root, "packages", "app", "node_modules", "pkg", "index.js"), false) {
		t.Fatal("nested node_modules file was not excluded")
	}
	if !filter.excluded(filepath.Join(root, "packages", "app", "node_modules"), true) {
		t.Fatal("nested node_modules directory was not excluded")
	}
	if !filter.excluded(filepath.Join(root, "node_modules"), true) {
		t.Fatal("root node_modules directory was not excluded")
	}
	if !filter.excluded(filepath.Join(root, ".git", "objects", "aa", "hash"), false) {
		t.Fatal("git object was not excluded")
	}
	if !filter.excluded(filepath.Join(root, ".git", "objects"), true) {
		t.Fatal("root git objects directory was not excluded")
	}
	if filter.excluded(filepath.Join(root, "packages", "app", "src", "index.ts"), false) {
		t.Fatal("source file was unexpectedly excluded")
	}
}

func TestFileURIEncodesSpaces(t *testing.T) {
	uri := fileURI(filepath.Join(string(filepath.Separator), "workspace", "with space", "file.ts"))
	if !strings.HasPrefix(uri, "file:///") || !strings.Contains(uri, "with%20space") {
		t.Fatalf("unexpected file URI: %s", uri)
	}
}

func TestMissingWatchRootUsesNearestExistingDirectory(t *testing.T) {
	root := t.TempDir()
	want := filepath.Join(root, "one")
	if err := os.Mkdir(want, 0o755); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(want, "two", "three")
	got, err := nearestExistingDirectory(filepath.Dir(target))
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("nearest existing directory = %q, want %q", got, want)
	}
	if !pathIsAncestorOrSelf(want, target) || !pathIsAncestorOrSelf(target, target) || !pathWithin(want, target) || pathWithin(target, want) {
		t.Fatal("path scope helpers returned inconsistent results")
	}
}
