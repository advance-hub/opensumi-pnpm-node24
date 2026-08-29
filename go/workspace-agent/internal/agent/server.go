package agent

import (
	"context"
	"crypto/subtle"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"

	workspacev1 "github.com/opensumi/core/go/workspace-agent/gen/opensumi/workspace/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

const (
	ProtocolMajor = 1
	ProtocolMinor = 2
)

var services = []string{"workspace.watch.v1", "workspace.search.v1", "workspace.fileSearch.v1"}

type Server struct {
	workspacev1.UnimplementedAgentControlServer
	workspacev1.UnimplementedWorkspaceWatcherServer
	workspacev1.UnimplementedWorkspaceSearchServer
	workspacev1.UnimplementedWorkspaceFileSearchServer

	buildRevision      string
	shutdown           chan struct{}
	shutdownOnce       sync.Once
	activeWatches      atomic.Uint64
	activeSearches     atomic.Uint64
	activeFileSearches atomic.Uint64
	searchCommand      searchCommandFactory
	fileSearchCommand  searchCommandFactory
}

func NewServer(buildRevision string) *Server {
	if buildRevision == "" {
		buildRevision = "development"
	}
	return &Server{
		buildRevision:     buildRevision,
		shutdown:          make(chan struct{}),
		searchCommand:     defaultSearchCommand,
		fileSearchCommand: defaultSearchCommand,
	}
}

func (s *Server) ShutdownRequested() <-chan struct{} {
	return s.shutdown
}

func (s *Server) GetCapabilities(context.Context, *workspacev1.GetCapabilitiesRequest) (*workspacev1.GetCapabilitiesResponse, error) {
	return &workspacev1.GetCapabilitiesResponse{
		ProtocolMajor: ProtocolMajor,
		ProtocolMinor: ProtocolMinor,
		Services:      append([]string(nil), services...),
		BuildRevision: s.buildRevision,
	}, nil
}

func (s *Server) Health(context.Context, *workspacev1.HealthRequest) (*workspacev1.HealthResponse, error) {
	return &workspacev1.HealthResponse{
		Ready:              true,
		ActiveWatches:      s.activeWatches.Load(),
		ActiveSearches:     s.activeSearches.Load(),
		ActiveFileSearches: s.activeFileSearches.Load(),
	}, nil
}

func (s *Server) Shutdown(context.Context, *workspacev1.ShutdownRequest) (*workspacev1.ShutdownResponse, error) {
	s.shutdownOnce.Do(func() { close(s.shutdown) })
	return &workspacev1.ShutdownResponse{}, nil
}

func AuthInterceptors(token string) (grpc.UnaryServerInterceptor, grpc.StreamServerInterceptor) {
	validate := func(ctx context.Context) error {
		if token == "" {
			return status.Error(codes.FailedPrecondition, "agent authentication is not configured")
		}
		values := metadata.ValueFromIncomingContext(ctx, "authorization")
		expected := "Bearer " + token
		if len(values) != 1 || subtle.ConstantTimeCompare([]byte(values[0]), []byte(expected)) != 1 {
			return status.Error(codes.Unauthenticated, "invalid agent credential")
		}
		return nil
	}

	unary := func(
		ctx context.Context,
		req any,
		info *grpc.UnaryServerInfo,
		handler grpc.UnaryHandler,
	) (any, error) {
		if err := validate(ctx); err != nil {
			return nil, err
		}
		return handler(ctx, req)
	}
	stream := func(
		srv any,
		serverStream grpc.ServerStream,
		info *grpc.StreamServerInfo,
		handler grpc.StreamHandler,
	) error {
		if err := validate(serverStream.Context()); err != nil {
			return err
		}
		return handler(srv, serverStream)
	}
	return unary, stream
}

func Register(grpcServer *grpc.Server, server *Server) {
	workspacev1.RegisterAgentControlServer(grpcServer, server)
	workspacev1.RegisterWorkspaceWatcherServer(grpcServer, server)
	workspacev1.RegisterWorkspaceSearchServer(grpcServer, server)
	workspacev1.RegisterWorkspaceFileSearchServer(grpcServer, server)
}

func requireAbsolutePath(value, field string) error {
	if value == "" {
		return status.Errorf(codes.InvalidArgument, "%s is required", field)
	}
	if strings.IndexByte(value, 0) >= 0 {
		return status.Errorf(codes.InvalidArgument, "%s contains an invalid byte", field)
	}
	if !filepath.IsAbs(value) {
		return status.Errorf(codes.InvalidArgument, "%s must be absolute", field)
	}
	return nil
}

func internalError(operation string, err error) error {
	return status.Error(codes.Internal, fmt.Sprintf("%s failed: %s", operation, safeError(err)))
}

func safeError(err error) string {
	if err == nil {
		return "unknown error"
	}
	if errors.Is(err, syscall.EMFILE) || errors.Is(err, syscall.ENFILE) {
		return "file descriptor limit reached"
	}
	if errors.Is(err, os.ErrPermission) {
		return "permission denied"
	}
	if errors.Is(err, os.ErrNotExist) {
		return "path disappeared during registration"
	}
	return fmt.Sprintf("%T", err)
}
