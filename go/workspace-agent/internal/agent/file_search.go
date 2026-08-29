package agent

import (
	"bufio"
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	workspacev1 "github.com/opensumi/core/go/workspace-agent/gen/opensumi/workspace/v1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const (
	fileSearchBatchSize      = 128
	fileSearchBatchByteLimit = 256 * 1024
	fileSearchScannerLimit   = 2 * 1024 * 1024
)

func (s *Server) Find(request *workspacev1.FileSearchRequest, stream workspacev1.WorkspaceFileSearch_FindServer) error {
	if len(request.GetRoots()) == 0 {
		return status.Error(codes.InvalidArgument, "at least one root is required")
	}
	for _, root := range request.GetRoots() {
		if root == nil {
			return status.Error(codes.InvalidArgument, "root is required")
		}
		if err := requireAbsolutePath(root.GetRootPath(), "root_path"); err != nil {
			return err
		}
	}

	s.activeFileSearches.Add(1)
	defer s.activeFileSearches.Add(^uint64(0))

	ctx, cancel := context.WithCancel(stream.Context())
	defer cancel()

	pattern := strings.ToLower(request.GetPattern())
	exactSeen := make(map[string]struct{})
	fuzzySeen := make(map[string]struct{})
	exactBatch := make([]string, 0, fileSearchBatchSize)
	fuzzyBatch := make([]string, 0, fileSearchBatchSize)
	batchBytes := 0
	var resultCount uint64
	limitHit := false

	flush := func() error {
		if len(exactBatch) == 0 && len(fuzzyBatch) == 0 {
			return nil
		}
		if err := stream.Send(&workspacev1.FileSearchEvent{
			ExactPaths: exactBatch,
			FuzzyPaths: fuzzyBatch,
		}); err != nil {
			return err
		}
		exactBatch = make([]string, 0, fileSearchBatchSize)
		fuzzyBatch = make([]string, 0, fileSearchBatchSize)
		batchBytes = 0
		return nil
	}

	for _, root := range request.GetRoots() {
		if limitHit {
			break
		}
		executable := request.GetRipgrepPath()
		if executable == "" {
			executable = "rg"
		}
		commandFactory := s.fileSearchCommand
		if commandFactory == nil {
			commandFactory = defaultSearchCommand
		}
		command := commandFactory(ctx, executable, fileSearchArgs(root)...)
		command.Dir = root.GetRootPath()
		command.Env = childProcessEnvironment(os.Environ())
		stdout, err := command.StdoutPipe()
		if err != nil {
			return internalError("open file search output", err)
		}
		command.Stderr = io.Discard
		if err := command.Start(); err != nil {
			return status.Error(codes.Unavailable, "workspace file search process could not start")
		}

		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 64*1024), fileSearchScannerLimit)
		for scanner.Scan() {
			candidate := scanner.Text()
			if candidate == "" {
				continue
			}
			fullPath := filepath.Join(root.GetRootPath(), filepath.FromSlash(candidate))
			normalizedCandidate := strings.ToLower(candidate)
			isExact := request.GetPattern() == "" || request.GetPattern() == "*" || strings.Contains(normalizedCandidate, pattern)
			if !isExact && (!request.GetFuzzyMatch() || !fuzzySubsequence(pattern, normalizedCandidate)) {
				continue
			}
			if _, exists := exactSeen[fullPath]; exists {
				continue
			}
			if _, exists := fuzzySeen[fullPath]; exists {
				continue
			}

			if len(exactBatch)+len(fuzzyBatch) > 0 && batchBytes+len(fullPath) > fileSearchBatchByteLimit {
				if err := flush(); err != nil {
					cancel()
					_ = command.Wait()
					return err
				}
			}
			if isExact {
				exactSeen[fullPath] = struct{}{}
				exactBatch = append(exactBatch, fullPath)
			} else {
				fuzzySeen[fullPath] = struct{}{}
				fuzzyBatch = append(fuzzyBatch, fullPath)
			}
			batchBytes += len(fullPath)
			resultCount++
			if request.GetMaxResults() > 0 && resultCount >= request.GetMaxResults() {
				limitHit = true
				cancel()
				break
			}
			if len(exactBatch)+len(fuzzyBatch) >= fileSearchBatchSize || batchBytes >= fileSearchBatchByteLimit {
				if err := flush(); err != nil {
					cancel()
					_ = command.Wait()
					return err
				}
			}
		}

		scannerErr := scanner.Err()
		if scannerErr != nil && command.Process != nil {
			_ = command.Process.Kill()
		}
		waitErr := command.Wait()
		if limitHit || stream.Context().Err() != nil {
			break
		}
		if scannerErr != nil {
			return internalError("read file search output", scannerErr)
		}
		if waitErr != nil {
			var exitError *exec.ExitError
			if errors.As(waitErr, &exitError) && exitError.ExitCode() == 1 {
				continue
			}
			return status.Error(codes.Internal, "workspace file search process failed")
		}
	}

	if stream.Context().Err() != nil {
		return nil
	}
	if err := flush(); err != nil {
		return err
	}
	if limitHit {
		return stream.Send(&workspacev1.FileSearchEvent{LimitHit: true})
	}
	return nil
}

func fileSearchArgs(root *workspacev1.FileSearchRoot) []string {
	args := []string{"--files", "--hidden", "--case-sensitive", "--no-require-git"}
	for _, include := range root.GetInclude() {
		if include != "" {
			args = append(args, "--glob", include)
		}
	}
	for _, exclude := range root.GetExclude() {
		if exclude != "" {
			args = append(args, "--glob", "!"+exclude)
		}
	}
	if !root.GetUseGitIgnore() {
		args = append(args, "-uu")
	}
	if root.GetNoIgnoreParent() {
		args = append(args, "--no-ignore-parent")
	}
	if root.GetFollowSymlinks() {
		args = append(args, "--follow")
	}
	return args
}

func fuzzySubsequence(pattern, candidate string) bool {
	if pattern == "" {
		return true
	}
	patternRunes := []rune(pattern)
	patternIndex := 0
	for _, candidateRune := range candidate {
		if candidateRune == patternRunes[patternIndex] {
			patternIndex++
			if patternIndex == len(patternRunes) {
				return true
			}
		}
	}
	return false
}
