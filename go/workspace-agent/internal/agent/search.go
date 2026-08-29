package agent

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"regexp"
	"strings"

	workspacev1 "github.com/opensumi/core/go/workspace-agent/gen/opensumi/workspace/v1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const (
	searchBatchSize        = 128
	searchBatchByteLimit   = 256 * 1024
	searchScannerByteLimit = 2 * 1024 * 1024
)

type ripgrepLine struct {
	Type string `json:"type"`
	Data struct {
		Path struct {
			Text string `json:"text"`
		} `json:"path"`
		Lines struct {
			Text string `json:"text"`
		} `json:"lines"`
		LineNumber uint64 `json:"line_number"`
		Submatches []struct {
			Start uint64 `json:"start"`
			End   uint64 `json:"end"`
		} `json:"submatches"`
	} `json:"data"`
}

type searchCommandFactory func(context.Context, string, ...string) *exec.Cmd

func defaultSearchCommand(ctx context.Context, executable string, args ...string) *exec.Cmd {
	return exec.CommandContext(ctx, executable, args...)
}

func (s *Server) Search(request *workspacev1.SearchRequest, stream workspacev1.WorkspaceSearch_SearchServer) error {
	if request.GetQuery() == "" {
		return status.Error(codes.InvalidArgument, "query is required")
	}
	if len(request.GetRootPaths()) == 0 {
		return status.Error(codes.InvalidArgument, "at least one root_path is required")
	}
	for _, root := range request.GetRootPaths() {
		if err := requireAbsolutePath(root, "root_path"); err != nil {
			return err
		}
	}
	executable := request.GetRipgrepPath()
	if executable == "" {
		executable = "rg"
	}
	args, query := searchArgs(request)
	args = append(args, query)
	args = append(args, request.GetRootPaths()...)

	commandFactory := s.searchCommand
	if commandFactory == nil {
		commandFactory = defaultSearchCommand
	}
	command := commandFactory(stream.Context(), executable, args...)
	command.Env = childProcessEnvironment(os.Environ())
	stdout, err := command.StdoutPipe()
	if err != nil {
		return internalError("open search output", err)
	}
	command.Stderr = io.Discard
	if err := command.Start(); err != nil {
		return status.Error(codes.Unavailable, "workspace search process could not start")
	}

	s.activeSearches.Add(1)
	defer s.activeSearches.Add(^uint64(0))

	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64*1024), searchScannerByteLimit)
	batch := make([]*workspacev1.SearchMatch, 0, searchBatchSize)
	batchBytes := 0
	var resultCount uint64
	limitHit := false

	flush := func() error {
		if len(batch) == 0 {
			return nil
		}
		if err := stream.Send(&workspacev1.SearchEvent{Matches: batch}); err != nil {
			return err
		}
		batch = make([]*workspacev1.SearchMatch, 0, searchBatchSize)
		batchBytes = 0
		return nil
	}

	for scanner.Scan() {
		var line ripgrepLine
		if err := json.Unmarshal(scanner.Bytes(), &line); err != nil || line.Type != "match" {
			continue
		}
		if line.Data.Path.Text == "" || line.Data.Lines.Text == "" {
			continue
		}
		lineText := strings.TrimRight(line.Data.Lines.Text, "\r\n")
		for _, submatch := range line.Data.Submatches {
			if request.GetMaxResults() > 0 && resultCount >= request.GetMaxResults() {
				limitHit = true
				break
			}
			match := &workspacev1.SearchMatch{
				Path:      line.Data.Path.Text,
				Line:      line.Data.LineNumber,
				LineText:  lineText,
				StartByte: submatch.Start,
				EndByte:   submatch.End,
			}
			matchBytes := searchMatchBytes(match)
			if searchBatchWouldExceed(len(batch), batchBytes, matchBytes) {
				if err := flush(); err != nil {
					_ = command.Process.Kill()
					_ = command.Wait()
					return err
				}
			}
			batch = append(batch, match)
			batchBytes += matchBytes
			resultCount++
			if searchBatchFull(len(batch), batchBytes) {
				if err := flush(); err != nil {
					_ = command.Process.Kill()
					_ = command.Wait()
					return err
				}
			}
		}
		if limitHit {
			_ = command.Process.Kill()
			break
		}
	}
	if err := flush(); err != nil {
		_ = command.Process.Kill()
		_ = command.Wait()
		return err
	}
	if scannerErr := scanner.Err(); scannerErr != nil && !errors.Is(scannerErr, context.Canceled) {
		_ = command.Process.Kill()
		_ = command.Wait()
		return internalError("read search output", scannerErr)
	}
	waitErr := command.Wait()
	if limitHit {
		return stream.Send(&workspacev1.SearchEvent{LimitHit: true})
	}
	if stream.Context().Err() != nil {
		return nil
	}
	if waitErr != nil {
		var exitError *exec.ExitError
		if errors.As(waitErr, &exitError) && exitError.ExitCode() == 1 {
			return nil
		}
		return status.Error(codes.Internal, "workspace search process failed")
	}
	return nil
}

func searchMatchBytes(match *workspacev1.SearchMatch) int {
	if match == nil {
		return 0
	}
	// The protobuf wire representation adds tags and varints; this fixed allowance
	// keeps the batching decision conservative without serializing every match twice.
	return len(match.GetPath()) + len(match.GetLineText()) + 32
}

func searchBatchWouldExceed(matchCount, batchBytes, nextMatchBytes int) bool {
	return matchCount > 0 && batchBytes+nextMatchBytes > searchBatchByteLimit
}

func searchBatchFull(matchCount, batchBytes int) bool {
	return matchCount >= searchBatchSize || batchBytes >= searchBatchByteLimit
}

func childProcessEnvironment(environment []string) []string {
	sanitized := make([]string, 0, len(environment))
	for _, entry := range environment {
		name, _, found := strings.Cut(entry, "=")
		if found && strings.EqualFold(name, "OPENSUMI_AGENT_TOKEN") {
			continue
		}
		sanitized = append(sanitized, entry)
	}
	return sanitized
}

func searchArgs(request *workspacev1.SearchRequest) ([]string, string) {
	args := []string{"--json", "--max-count=100"}
	if request.GetMatchCase() {
		args = append(args, "--case-sensitive")
	} else {
		args = append(args, "--ignore-case")
	}
	if request.GetIncludeIgnored() {
		args = append(args, "-uu")
	}
	for _, include := range request.GetInclude() {
		if include != "" {
			args = append(args, "--glob="+include)
		}
	}
	for _, exclude := range request.GetExclude() {
		if exclude != "" {
			args = append(args, "--glob=!"+exclude)
		}
	}
	if encoding := request.GetEncoding(); encoding != "" && encoding != "utf8" {
		args = append(args, "--encoding", encoding)
	}
	if request.GetFollowSymlinks() {
		args = append(args, "--follow")
	}

	query := request.GetQuery()
	if request.GetMatchWholeWord() && !request.GetUseRegexp() {
		query = regexp.QuoteMeta(query)
		if startsWithWord(query) {
			query = `\b` + query
		}
		if endsWithWord(query) {
			query += `\b`
		}
	}
	if request.GetUseRegexp() || request.GetMatchWholeWord() {
		args = append(args, "--regexp")
	} else {
		args = append(args, "--fixed-strings", "--")
	}
	return args, query
}

func startsWithWord(value string) bool {
	for _, char := range value {
		return char == '_' || char >= '0' && char <= '9' || char >= 'A' && char <= 'Z' || char >= 'a' && char <= 'z'
	}
	return false
}

func endsWithWord(value string) bool {
	for index := len(value) - 1; index >= 0; index-- {
		char := value[index]
		return char == '_' || char >= '0' && char <= '9' || char >= 'A' && char <= 'Z' || char >= 'a' && char <= 'z'
	}
	return false
}
