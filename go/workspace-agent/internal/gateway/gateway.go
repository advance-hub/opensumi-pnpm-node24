package gateway

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

const (
	defaultServicePath       = "/service"
	defaultMaxPayloadBytes   = int64(32 * 1024 * 1024)
	defaultMaxBufferedBytes  = int64(16 * 1024 * 1024)
	defaultMaxConnections    = 1_000
	defaultHeartbeatInterval = 30 * time.Second
	defaultWriteTimeout      = 10 * time.Second
	defaultDialTimeout       = 5 * time.Second
	defaultDirectFileRPCs    = 16
	admissionCacheDuration   = 100 * time.Millisecond
	defaultDiagnosticsPath   = "/_opensumi/ws-gateway"
	channelModeDirect        = "direct"
	channelModeMultiplexV1   = "multiplex-v1"
)

var frameIndicator = [4]byte{0x0d, 0x0a, 0x0d, 0x0a}

type Config struct {
	NodeHTTPURL                string
	ChannelNetwork             string
	ChannelAddress             string
	ChannelMode                string
	ServicePath                string
	AdmissionPath              string
	MaxPayloadBytes            int64
	MaxBufferedBytes           int64
	MaxConnections             int
	HeartbeatInterval          time.Duration
	WriteTimeout               time.Duration
	DialTimeout                time.Duration
	DirectFileRPC              bool
	DirectFileReadMaxBytes     int64
	DirectFileMetadataMaxBytes int64
	DirectFileRPCMaxConcurrent int
	DiagnosticsPath            string
}

type Stats struct {
	DirectFileRPCEnabled       bool   `json:"directFileRPCEnabled"`
	DirectFileRPCs             uint64 `json:"directFileRPCs"`
	DirectFileReads            uint64 `json:"directFileReads"`
	DirectFileReadBytes        uint64 `json:"directFileReadBytes"`
	DirectFileAccesses         uint64 `json:"directFileAccesses"`
	DirectDirectoryReads       uint64 `json:"directDirectoryReads"`
	DirectFileStats            uint64 `json:"directFileStats"`
	DirectFileMetadataMaxBytes int64  `json:"directFileMetadataMaxBytes"`
	DirectFileRPCMaxConcurrent int    `json:"directFileRPCMaxConcurrent"`
	BrowserFramesForwarded     uint64 `json:"browserFramesForwarded"`
	NodeFramesForwarded        uint64 `json:"nodeFramesForwarded"`
}

type gatewayStats struct {
	directFileRPCs         atomic.Uint64
	directFileReads        atomic.Uint64
	directFileReadBytes    atomic.Uint64
	directFileAccesses     atomic.Uint64
	directDirectoryReads   atomic.Uint64
	directFileStats        atomic.Uint64
	browserFramesForwarded atomic.Uint64
	nodeFramesForwarded    atomic.Uint64
}

type Server struct {
	config             Config
	proxy              *httputil.ReverseProxy
	upgrader           websocket.Upgrader
	slots              chan struct{}
	admissionURL       *url.URL
	admissionClient    *http.Client
	admissionCtx       context.Context
	admissionCancel    context.CancelFunc
	admissionMu        sync.Mutex
	admissionUntil     time.Time
	admissionResult    error
	admissionFlight    chan struct{}
	multiplex          *multiplexBackend
	stats              gatewayStats
	directFileRPCSlots chan struct{}

	draining atomic.Bool
	mu       sync.Mutex
	http     *http.Server
	bridges  map[*bridge]struct{}
	wg       sync.WaitGroup
}

func New(config Config) (*Server, error) {
	if config.NodeHTTPURL == "" {
		return nil, errors.New("node HTTP URL is required")
	}
	target, err := url.Parse(config.NodeHTTPURL)
	if err != nil {
		return nil, fmt.Errorf("parse node HTTP URL: %w", err)
	}
	if target.Scheme != "http" && target.Scheme != "https" {
		return nil, fmt.Errorf("unsupported node HTTP URL scheme %q", target.Scheme)
	}
	if target.Host == "" {
		return nil, errors.New("node HTTP URL must include a host")
	}
	if config.ChannelNetwork != "unix" && config.ChannelNetwork != "tcp" {
		return nil, fmt.Errorf("channel network must be unix or tcp, got %q", config.ChannelNetwork)
	}
	if config.ChannelAddress == "" {
		return nil, errors.New("channel address is required")
	}
	if config.ChannelMode == "" {
		config.ChannelMode = channelModeDirect
	}
	if config.ChannelMode != channelModeDirect && config.ChannelMode != channelModeMultiplexV1 {
		return nil, fmt.Errorf("unsupported channel mode %q", config.ChannelMode)
	}
	if config.ServicePath == "" {
		config.ServicePath = defaultServicePath
	}
	if config.ServicePath[0] != '/' {
		return nil, errors.New("service path must begin with /")
	}
	if config.AdmissionPath != "" && config.AdmissionPath[0] != '/' {
		return nil, errors.New("admission path must begin with /")
	}
	if config.MaxPayloadBytes == 0 {
		config.MaxPayloadBytes = defaultMaxPayloadBytes
	}
	if config.MaxPayloadBytes < 0 || config.MaxPayloadBytes > maximumFramePayload() {
		return nil, fmt.Errorf("max payload bytes must be between 1 and %d", maximumFramePayload())
	}
	if config.MaxBufferedBytes == 0 {
		config.MaxBufferedBytes = defaultMaxBufferedBytes
	}
	if config.MaxBufferedBytes < 0 {
		return nil, errors.New("max buffered bytes must be positive")
	}
	if config.MaxConnections == 0 {
		config.MaxConnections = defaultMaxConnections
	}
	if config.MaxConnections < 0 {
		return nil, errors.New("max connections must be positive")
	}
	if config.HeartbeatInterval == 0 {
		config.HeartbeatInterval = defaultHeartbeatInterval
	}
	if config.HeartbeatInterval < 0 {
		return nil, errors.New("heartbeat interval cannot be negative")
	}
	if config.WriteTimeout == 0 {
		config.WriteTimeout = defaultWriteTimeout
	}
	if config.WriteTimeout < 0 {
		return nil, errors.New("write timeout cannot be negative")
	}
	if config.DialTimeout == 0 {
		config.DialTimeout = defaultDialTimeout
	}
	if config.DialTimeout < 0 {
		return nil, errors.New("dial timeout cannot be negative")
	}
	if config.DirectFileRPC {
		if config.DirectFileReadMaxBytes == 0 {
			config.DirectFileReadMaxBytes = defaultDirectFileReadMaxLen
			if config.DirectFileReadMaxBytes > config.MaxPayloadBytes {
				config.DirectFileReadMaxBytes = config.MaxPayloadBytes
			}
		}
		if config.DirectFileReadMaxBytes < 0 || config.DirectFileReadMaxBytes > config.MaxPayloadBytes {
			return nil, fmt.Errorf("direct file read max bytes must be between 1 and %d", config.MaxPayloadBytes)
		}
		if config.DirectFileMetadataMaxBytes == 0 {
			config.DirectFileMetadataMaxBytes = 1024 * 1024
			if config.DirectFileMetadataMaxBytes > config.MaxPayloadBytes {
				config.DirectFileMetadataMaxBytes = config.MaxPayloadBytes
			}
		}
		if config.DirectFileMetadataMaxBytes < 0 || config.DirectFileMetadataMaxBytes > config.MaxPayloadBytes {
			return nil, fmt.Errorf("direct file metadata max bytes must be between 1 and %d", config.MaxPayloadBytes)
		}
		if config.DirectFileRPCMaxConcurrent == 0 {
			config.DirectFileRPCMaxConcurrent = defaultDirectFileRPCs
		}
		if config.DirectFileRPCMaxConcurrent < 0 || config.DirectFileRPCMaxConcurrent > config.MaxConnections {
			return nil, fmt.Errorf("direct file RPC concurrency must be between 1 and %d", config.MaxConnections)
		}
	}
	if config.DiagnosticsPath == "" {
		config.DiagnosticsPath = defaultDiagnosticsPath
	}
	if config.DiagnosticsPath[0] != '/' || config.DiagnosticsPath == config.ServicePath {
		return nil, errors.New("diagnostics path must be an absolute path distinct from the service path")
	}

	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, proxyErr error) {
		http.Error(w, fmt.Sprintf("node HTTP backend unavailable: %v", proxyErr), http.StatusBadGateway)
	}

	var admissionURL *url.URL
	if config.AdmissionPath != "" {
		admissionURL = target.ResolveReference(&url.URL{Path: config.AdmissionPath})
	}
	admissionCtx, admissionCancel := context.WithCancel(context.Background())
	server := &Server{
		config: config,
		proxy:  proxy,
		upgrader: websocket.Upgrader{
			CheckOrigin:       func(*http.Request) bool { return true },
			EnableCompression: false,
		},
		slots:           make(chan struct{}, config.MaxConnections),
		admissionURL:    admissionURL,
		admissionClient: &http.Client{Timeout: config.DialTimeout},
		admissionCtx:    admissionCtx,
		admissionCancel: admissionCancel,
		bridges:         make(map[*bridge]struct{}),
	}
	if config.DirectFileRPC {
		server.directFileRPCSlots = make(chan struct{}, config.DirectFileRPCMaxConcurrent)
	}
	if config.ChannelMode == channelModeMultiplexV1 {
		multiplex, err := newMultiplexBackend(config)
		if err != nil {
			admissionCancel()
			return nil, err
		}
		server.multiplex = multiplex
	}
	return server, nil
}

func (s *Server) Handler() http.Handler {
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == s.config.DiagnosticsPath && r.Method == http.MethodGet {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(s.Stats())
		return
	}
	if r.URL.Path == s.config.ServicePath && websocket.IsWebSocketUpgrade(r) {
		s.serveWebSocket(w, r)
		return
	}
	s.proxy.ServeHTTP(w, r)
}

func (s *Server) Stats() Stats {
	return Stats{
		DirectFileRPCEnabled:       s.config.DirectFileRPC,
		DirectFileRPCs:             s.stats.directFileRPCs.Load(),
		DirectFileReads:            s.stats.directFileReads.Load(),
		DirectFileReadBytes:        s.stats.directFileReadBytes.Load(),
		DirectFileAccesses:         s.stats.directFileAccesses.Load(),
		DirectDirectoryReads:       s.stats.directDirectoryReads.Load(),
		DirectFileStats:            s.stats.directFileStats.Load(),
		DirectFileMetadataMaxBytes: s.config.DirectFileMetadataMaxBytes,
		DirectFileRPCMaxConcurrent: s.config.DirectFileRPCMaxConcurrent,
		BrowserFramesForwarded:     s.stats.browserFramesForwarded.Load(),
		NodeFramesForwarded:        s.stats.nodeFramesForwarded.Load(),
	}
}

func (s *Server) Serve(listener net.Listener) error {
	s.mu.Lock()
	if s.http != nil {
		s.mu.Unlock()
		return errors.New("gateway server is already running")
	}
	httpServer := &http.Server{Handler: s}
	s.http = httpServer
	s.mu.Unlock()

	err := httpServer.Serve(listener)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func (s *Server) Shutdown(ctx context.Context) error {
	s.draining.Store(true)
	s.admissionCancel()

	s.mu.Lock()
	httpServer := s.http
	bridges := make([]*bridge, 0, len(s.bridges))
	for current := range s.bridges {
		bridges = append(bridges, current)
	}
	s.mu.Unlock()

	var shutdownErr error
	if httpServer != nil {
		shutdownErr = httpServer.Shutdown(ctx)
	}
	for _, current := range bridges {
		current.close()
	}
	if s.multiplex != nil {
		s.multiplex.close()
	}

	done := make(chan struct{})
	go func() {
		s.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
		return shutdownErr
	case <-ctx.Done():
		if shutdownErr != nil {
			return shutdownErr
		}
		return ctx.Err()
	}
}

func (s *Server) serveWebSocket(w http.ResponseWriter, r *http.Request) {
	if s.draining.Load() {
		http.Error(w, "gateway is shutting down", http.StatusServiceUnavailable)
		return
	}
	select {
	case s.slots <- struct{}{}:
		defer func() { <-s.slots }()
	default:
		http.Error(w, "websocket connection limit reached", http.StatusServiceUnavailable)
		return
	}
	if err := s.checkAdmission(r.Context()); err != nil {
		http.Error(w, fmt.Sprintf("websocket admission rejected: %v", err), http.StatusServiceUnavailable)
		return
	}

	var backend net.Conn
	if s.multiplex == nil {
		dialer := net.Dialer{Timeout: s.config.DialTimeout}
		var err error
		backend, err = dialer.DialContext(r.Context(), s.config.ChannelNetwork, s.config.ChannelAddress)
		if err != nil {
			http.Error(w, fmt.Sprintf("node channel backend unavailable: %v", err), http.StatusServiceUnavailable)
			return
		}
	}

	webSocket, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		if backend != nil {
			_ = backend.Close()
		}
		return
	}
	webSocket.SetReadLimit(s.config.MaxPayloadBytes)
	if s.multiplex != nil {
		backend, err = s.multiplex.openStream()
		if err != nil {
			_ = webSocket.Close()
			return
		}
	}

	current := newBridge(webSocket, backend, s.config, &s.stats, s.directFileRPCSlots)
	s.mu.Lock()
	if s.draining.Load() {
		s.mu.Unlock()
		current.close()
		return
	}
	s.bridges[current] = struct{}{}
	s.wg.Add(1)
	s.mu.Unlock()

	defer func() {
		current.close()
		s.mu.Lock()
		delete(s.bridges, current)
		s.mu.Unlock()
		s.wg.Done()
	}()
	current.run()
}

func (s *Server) checkAdmission(ctx context.Context) error {
	if s.admissionURL == nil {
		return nil
	}
	for {
		admissionNow := time.Now()
		s.admissionMu.Lock()
		if admissionNow.Before(s.admissionUntil) {
			result := s.admissionResult
			s.admissionMu.Unlock()
			return result
		}
		if flight := s.admissionFlight; flight != nil {
			s.admissionMu.Unlock()
			select {
			case <-flight:
				continue
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		flight := make(chan struct{})
		s.admissionFlight = flight
		s.admissionMu.Unlock()

		result := s.fetchAdmission()
		s.admissionMu.Lock()
		s.admissionResult = result
		s.admissionUntil = time.Now().Add(admissionCacheDuration)
		s.admissionFlight = nil
		close(flight)
		s.admissionMu.Unlock()
		return result
	}
}

func (s *Server) fetchAdmission() error {
	request, err := http.NewRequestWithContext(s.admissionCtx, http.MethodGet, s.admissionURL.String(), nil)
	if err != nil {
		return err
	}
	request.Header.Set("X-OpenSumi-Gateway-Admission", "1")
	response, err := s.admissionClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4*1024))
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return fmt.Errorf("node readiness returned HTTP %d", response.StatusCode)
	}
	return nil
}

type bridge struct {
	webSocket          *websocket.Conn
	backend            net.Conn
	config             Config
	stats              *gatewayStats
	directFileRPCSlots chan struct{}
	writeMu            sync.Mutex
	closeOnce          sync.Once
}

func newBridge(
	webSocket *websocket.Conn,
	backend net.Conn,
	config Config,
	stats *gatewayStats,
	directFileRPCSlots chan struct{},
) *bridge {
	return &bridge{
		webSocket:          webSocket,
		backend:            backend,
		config:             config,
		stats:              stats,
		directFileRPCSlots: directFileRPCSlots,
	}
}

func (b *bridge) run() {
	done := make(chan struct{})
	copyErrors := make(chan error, 2)
	heartbeatErrors := make(chan error, 1)
	go func() { copyErrors <- b.copyBrowserToNode() }()
	go func() { copyErrors <- b.copyNodeToBrowser() }()
	if b.config.HeartbeatInterval > 0 {
		go b.heartbeat(done, heartbeatErrors)
	}
	copiesRemaining := 2
	select {
	case <-copyErrors:
		copiesRemaining--
	case <-heartbeatErrors:
	}
	close(done)
	b.close()
	// Both copy loops own network reads. Closing both connections releases the
	// loop that did not report the first error, so no per-connection goroutine is left behind.
	for copiesRemaining > 0 {
		<-copyErrors
		copiesRemaining--
	}
}

func (b *bridge) copyBrowserToNode() error {
	if b.config.HeartbeatInterval > 0 {
		_ = b.webSocket.SetReadDeadline(time.Now().Add(2 * b.config.HeartbeatInterval))
		b.webSocket.SetPongHandler(func(string) error {
			return b.webSocket.SetReadDeadline(time.Now().Add(2 * b.config.HeartbeatInterval))
		})
	}
	for {
		messageType, payload, err := b.webSocket.ReadMessage()
		if err != nil {
			return err
		}
		if messageType != websocket.BinaryMessage {
			return fmt.Errorf("unsupported websocket message type %d", messageType)
		}
		if int64(len(payload)) > b.config.MaxPayloadBytes {
			return fmt.Errorf("websocket payload of %d bytes exceeds limit", len(payload))
		}
		if b.config.DirectFileRPC {
			select {
			case b.directFileRPCSlots <- struct{}{}:
				response, release, method, contentBytes, handled := tryDirectFileRPC(
					payload,
					b.config.DirectFileReadMaxBytes,
					b.config.DirectFileMetadataMaxBytes,
				)
				<-b.directFileRPCSlots
				if handled {
					released := false
					releaseOnce := func() {
						if !released {
							released = true
							if release != nil {
								release()
							}
						}
					}
					if int64(len(response)) <= b.config.MaxPayloadBytes {
						if err := b.writeBrowserPayload(response); err != nil {
							releaseOnce()
							return fmt.Errorf("write direct file RPC response: %w", err)
						}
						releaseOnce()
						b.stats.directFileRPCs.Add(1)
						switch method {
						case directFileRPCRead:
							b.stats.directFileReads.Add(1)
							b.stats.directFileReadBytes.Add(uint64(contentBytes))
						case directFileRPCAccess:
							b.stats.directFileAccesses.Add(1)
						case directFileRPCReadDirectory:
							b.stats.directDirectoryReads.Add(1)
						case directFileRPCStat:
							b.stats.directFileStats.Add(1)
						}
						continue
					}
					releaseOnce()
					// The response exceeds the WebSocket payload limit, so the
					// browser request stays unanswered by the Go path and Node
					// remains the compatibility fallback below.
				}
			default:
				// Preserve availability under burst load: Node remains the compatibility fallback.
			}
		}
		if err := writeFrame(b.backend, payload, b.config.WriteTimeout); err != nil {
			return fmt.Errorf("write node channel frame: %w", err)
		}
		b.stats.browserFramesForwarded.Add(1)
	}
}

func (b *bridge) copyNodeToBrowser() error {
	for {
		payload, err := readFrame(b.backend, b.config.MaxPayloadBytes)
		if err != nil {
			return fmt.Errorf("read node channel frame: %w", err)
		}
		err = b.writeBrowserPayload(payload)
		if err != nil {
			return fmt.Errorf("write websocket message: %w", err)
		}
		b.stats.nodeFramesForwarded.Add(1)
	}
}

func (b *bridge) writeBrowserPayload(payload []byte) error {
	b.writeMu.Lock()
	defer b.writeMu.Unlock()
	if b.config.WriteTimeout > 0 {
		if err := b.webSocket.SetWriteDeadline(time.Now().Add(b.config.WriteTimeout)); err != nil {
			return err
		}
	}
	return b.webSocket.WriteMessage(websocket.BinaryMessage, payload)
}

func (b *bridge) heartbeat(done <-chan struct{}, heartbeatErrors chan<- error) {
	ticker := time.NewTicker(b.config.HeartbeatInterval)
	defer ticker.Stop()
	for {
		select {
		case <-done:
			return
		case <-ticker.C:
			deadline := time.Now().Add(b.config.WriteTimeout)
			if b.config.WriteTimeout == 0 {
				deadline = time.Now().Add(defaultWriteTimeout)
			}
			if err := b.webSocket.WriteControl(websocket.PingMessage, nil, deadline); err != nil {
				select {
				case heartbeatErrors <- fmt.Errorf("write websocket ping: %w", err):
				case <-done:
				}
				return
			}
		}
	}
}

func (b *bridge) close() {
	b.closeOnce.Do(func() {
		deadline := time.Now().Add(time.Second)
		_ = b.webSocket.WriteControl(websocket.CloseMessage, nil, deadline)
		_ = b.webSocket.Close()
		_ = b.backend.Close()
	})
}

func writeFrame(writer net.Conn, payload []byte, timeout time.Duration) error {
	if uint64(len(payload)) > uint64(^uint32(0)) {
		return errors.New("payload exceeds uint32 frame limit")
	}
	if timeout > 0 {
		if err := writer.SetWriteDeadline(time.Now().Add(timeout)); err != nil {
			return err
		}
	}
	header := make([]byte, 8)
	copy(header, frameIndicator[:])
	binary.LittleEndian.PutUint32(header[4:], uint32(len(payload)))
	if err := writeAll(writer, header); err != nil {
		return err
	}
	return writeAll(writer, payload)
}

func readFrame(reader net.Conn, maxPayloadBytes int64) ([]byte, error) {
	header := make([]byte, 8)
	if _, err := io.ReadFull(reader, header); err != nil {
		return nil, err
	}
	if !bytes.Equal(header[:4], frameIndicator[:]) {
		return nil, errors.New("invalid frame indicator")
	}
	length := int64(binary.LittleEndian.Uint32(header[4:]))
	if length > maxPayloadBytes {
		return nil, fmt.Errorf("frame payload of %d bytes exceeds limit", length)
	}
	payload := make([]byte, int(length))
	if _, err := io.ReadFull(reader, payload); err != nil {
		return nil, err
	}
	return payload, nil
}

func writeAll(writer io.Writer, payload []byte) error {
	for len(payload) > 0 {
		written, err := writer.Write(payload)
		if err != nil {
			return err
		}
		if written == 0 {
			return io.ErrShortWrite
		}
		payload = payload[written:]
	}
	return nil
}

func maximumFramePayload() int64 {
	maximum := uint64(^uint32(0))
	if maximumInt := uint64(^uint(0) >> 1); maximumInt < maximum {
		maximum = maximumInt
	}
	return int64(maximum)
}
