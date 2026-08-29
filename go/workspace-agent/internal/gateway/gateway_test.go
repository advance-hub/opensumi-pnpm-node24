package gateway

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestGatewayProxiesHTTPAndBridgesWebSocketFrames(t *testing.T) {
	nodeHTTP := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Node-Path", r.URL.Path)
		_, _ = io.WriteString(w, "node-http")
	}))
	defer nodeHTTP.Close()

	channelListener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer channelListener.Close()
	backendClosed := make(chan error, 1)
	go func() {
		connection, acceptErr := channelListener.Accept()
		if acceptErr != nil {
			backendClosed <- acceptErr
			return
		}
		defer connection.Close()
		payload, readErr := readFrame(connection, 1024)
		if readErr != nil {
			backendClosed <- readErr
			return
		}
		if string(payload) != "hello" {
			backendClosed <- errors.New("unexpected browser payload")
			return
		}
		if writeErr := writeFrame(connection, []byte("world"), time.Second); writeErr != nil {
			backendClosed <- writeErr
			return
		}
		_ = connection.SetReadDeadline(time.Now().Add(2 * time.Second))
		oneByte := make([]byte, 1)
		_, closeErr := connection.Read(oneByte)
		backendClosed <- closeErr
	}()

	gateway, err := New(Config{
		NodeHTTPURL:       nodeHTTP.URL,
		ChannelNetwork:    "tcp",
		ChannelAddress:    channelListener.Addr().String(),
		MaxPayloadBytes:   1024,
		HeartbeatInterval: time.Hour,
	})
	if err != nil {
		t.Fatal(err)
	}
	public := httptest.NewServer(gateway.Handler())
	defer public.Close()

	response, err := http.Get(public.URL + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(response.Body)
	response.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK || string(body) != "node-http" || response.Header.Get("X-Node-Path") != "/healthz" {
		t.Fatalf("unexpected HTTP proxy response: status=%d body=%q headers=%v", response.StatusCode, body, response.Header)
	}

	webSocketURL := "ws" + strings.TrimPrefix(public.URL, "http") + "/service"
	client, _, err := websocket.DefaultDialer.Dial(webSocketURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := client.WriteMessage(websocket.BinaryMessage, []byte("hello")); err != nil {
		t.Fatal(err)
	}
	messageType, payload, err := client.ReadMessage()
	if err != nil {
		t.Fatal(err)
	}
	if messageType != websocket.BinaryMessage || string(payload) != "world" {
		t.Fatalf("unexpected websocket response: type=%d payload=%q", messageType, payload)
	}
	_ = client.Close()

	select {
	case closeErr := <-backendClosed:
		if closeErr == nil {
			t.Fatal("node channel did not report EOF after browser close")
		}
		var networkErr net.Error
		if errors.As(closeErr, &networkErr) && networkErr.Timeout() {
			t.Fatalf("node channel remained open after browser close: %v", closeErr)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for node channel close")
	}
}

func TestGatewayMultiplexesLogicalStreamsOverOneNodeConnection(t *testing.T) {
	nodeHTTP := httptest.NewServer(http.NotFoundHandler())
	defer nodeHTTP.Close()
	channelListener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer channelListener.Close()

	var accepts atomic.Int32
	backendDone := make(chan error, 1)
	go func() {
		connection, acceptErr := channelListener.Accept()
		if acceptErr != nil {
			backendDone <- acceptErr
			return
		}
		accepts.Add(1)
		defer connection.Close()
		preface := make([]byte, len(multiplexPreface))
		if _, readErr := io.ReadFull(connection, preface); readErr != nil {
			backendDone <- readErr
			return
		}
		if !strings.EqualFold(string(preface), string(multiplexPreface)) {
			backendDone <- fmt.Errorf("unexpected multiplex preface %q", preface)
			return
		}
		openStreams := make(map[uint32]bool)
		for {
			frameType, streamID, payload, readErr := readMultiplexFrame(connection, 1024)
			if readErr != nil {
				if errors.Is(readErr, io.EOF) || errors.Is(readErr, net.ErrClosed) {
					backendDone <- nil
				} else {
					backendDone <- readErr
				}
				return
			}
			switch frameType {
			case multiplexOpen:
				if len(payload) != 0 || openStreams[streamID] {
					backendDone <- fmt.Errorf("invalid OPEN stream=%d payload=%d", streamID, len(payload))
					return
				}
				openStreams[streamID] = true
			case multiplexData:
				if !openStreams[streamID] {
					backendDone <- fmt.Errorf("DATA for unopened stream %d", streamID)
					return
				}
				responses := [][]byte{append([]byte("reply:"), payload...)}
				if string(payload) == "burst" {
					responses = [][]byte{[]byte("burst:one"), []byte("burst:two")}
				}
				for _, response := range responses {
					if writeErr := writeMultiplexTestFrame(connection, multiplexData, streamID, response); writeErr != nil {
						backendDone <- writeErr
						return
					}
				}
			case multiplexClose:
				delete(openStreams, streamID)
			default:
				backendDone <- fmt.Errorf("unexpected frame type %d", frameType)
				return
			}
		}
	}()

	gateway, err := New(Config{
		NodeHTTPURL:       nodeHTTP.URL,
		ChannelNetwork:    "tcp",
		ChannelAddress:    channelListener.Addr().String(),
		ChannelMode:       channelModeMultiplexV1,
		MaxPayloadBytes:   1024,
		HeartbeatInterval: time.Hour,
	})
	if err != nil {
		t.Fatal(err)
	}
	public := httptest.NewServer(gateway.Handler())
	defer public.Close()
	webSocketURL := "ws" + strings.TrimPrefix(public.URL, "http") + "/service"

	first, _, err := websocket.DefaultDialer.Dial(webSocketURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	second, _, err := websocket.DefaultDialer.Dial(webSocketURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()

	if err := first.WriteMessage(websocket.BinaryMessage, []byte("first")); err != nil {
		t.Fatal(err)
	}
	if err := second.WriteMessage(websocket.BinaryMessage, []byte("second")); err != nil {
		t.Fatal(err)
	}
	for index, expectation := range []struct {
		client  *websocket.Conn
		payload string
	}{{first, "reply:first"}, {second, "reply:second"}} {
		messageType, payload, readErr := expectation.client.ReadMessage()
		if readErr != nil {
			t.Fatalf("read client %d: %v", index, readErr)
		}
		if messageType != websocket.BinaryMessage || string(payload) != expectation.payload {
			t.Fatalf("unexpected client %d response: type=%d payload=%q", index, messageType, payload)
		}
	}
	if got := accepts.Load(); got != 1 {
		t.Fatalf("Gateway opened %d physical Node connections, want 1", got)
	}
	if err := first.WriteMessage(websocket.BinaryMessage, []byte("burst")); err != nil {
		t.Fatal(err)
	}
	for index, expected := range []string{"burst:one", "burst:two"} {
		_, payload, readErr := first.ReadMessage()
		if readErr != nil {
			t.Fatalf("read burst response %d: %v", index, readErr)
		}
		if string(payload) != expected {
			t.Fatalf("unexpected burst response %d: %q", index, payload)
		}
	}

	_ = first.Close()
	_ = second.Close()
	shutdownContext, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := gateway.Shutdown(shutdownContext); err != nil {
		t.Fatal(err)
	}
	select {
	case backendErr := <-backendDone:
		if backendErr != nil {
			t.Fatal(backendErr)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("multiplexed Node transport remained open after shutdown")
	}
}

func writeMultiplexTestFrame(writer io.Writer, frameType byte, streamID uint32, payload []byte) error {
	frame := make([]byte, multiplexHeaderBytes+len(payload))
	frame[0] = frameType
	binary.LittleEndian.PutUint32(frame[1:5], streamID)
	binary.LittleEndian.PutUint32(frame[5:9], uint32(len(payload)))
	copy(frame[multiplexHeaderBytes:], payload)
	return writeAll(writer, frame)
}

func TestGatewayRejectsConnectionAboveLimit(t *testing.T) {
	nodeHTTP := httptest.NewServer(http.NotFoundHandler())
	defer nodeHTTP.Close()
	channelListener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer channelListener.Close()
	accepted := make(chan net.Conn, 1)
	go func() {
		connection, acceptErr := channelListener.Accept()
		if acceptErr == nil {
			accepted <- connection
		}
	}()

	gateway, err := New(Config{
		NodeHTTPURL:       nodeHTTP.URL,
		ChannelNetwork:    "tcp",
		ChannelAddress:    channelListener.Addr().String(),
		MaxConnections:    1,
		HeartbeatInterval: time.Hour,
	})
	if err != nil {
		t.Fatal(err)
	}
	public := httptest.NewServer(gateway.Handler())
	defer public.Close()
	webSocketURL := "ws" + strings.TrimPrefix(public.URL, "http") + "/service"

	first, _, err := websocket.DefaultDialer.Dial(webSocketURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	backend := <-accepted
	defer backend.Close()

	second, response, err := websocket.DefaultDialer.Dial(webSocketURL, nil)
	if second != nil {
		second.Close()
	}
	if err == nil {
		t.Fatal("second websocket connection unexpectedly succeeded")
	}
	if response == nil || response.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("unexpected connection-limit response: %#v", response)
	}
}

func TestGatewayRejectsWebSocketWhenNodeIsNotReady(t *testing.T) {
	nodeHTTP := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/readyz" {
			http.Error(w, "memory pressure", http.StatusServiceUnavailable)
			return
		}
		http.NotFound(w, r)
	}))
	defer nodeHTTP.Close()
	channelListener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer channelListener.Close()

	gateway, err := New(Config{
		NodeHTTPURL:       nodeHTTP.URL,
		ChannelNetwork:    "tcp",
		ChannelAddress:    channelListener.Addr().String(),
		AdmissionPath:     "/readyz",
		HeartbeatInterval: time.Hour,
	})
	if err != nil {
		t.Fatal(err)
	}
	public := httptest.NewServer(gateway.Handler())
	defer public.Close()
	webSocketURL := "ws" + strings.TrimPrefix(public.URL, "http") + "/service"

	connection, response, err := websocket.DefaultDialer.Dial(webSocketURL, nil)
	if connection != nil {
		connection.Close()
	}
	if err == nil {
		t.Fatal("websocket connection unexpectedly bypassed Node readiness")
	}
	if response == nil || response.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("unexpected admission response: %#v", response)
	}
}

func TestGatewayCoalescesAndBrieflyCachesConcurrentAdmissionChecks(t *testing.T) {
	var requests atomic.Int32
	nodeHTTP := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/readyz" {
			http.NotFound(w, r)
			return
		}
		requests.Add(1)
		time.Sleep(25 * time.Millisecond)
		w.WriteHeader(http.StatusOK)
	}))
	defer nodeHTTP.Close()

	gateway, err := New(Config{
		NodeHTTPURL:    nodeHTTP.URL,
		ChannelNetwork: "tcp",
		ChannelAddress: "127.0.0.1:1",
		AdmissionPath:  "/readyz",
	})
	if err != nil {
		t.Fatal(err)
	}

	start := make(chan struct{})
	var waitGroup sync.WaitGroup
	errorsByCaller := make(chan error, 32)
	for range 32 {
		waitGroup.Add(1)
		go func() {
			defer waitGroup.Done()
			<-start
			errorsByCaller <- gateway.checkAdmission(context.Background())
		}()
	}
	close(start)
	waitGroup.Wait()
	close(errorsByCaller)
	for admissionErr := range errorsByCaller {
		if admissionErr != nil {
			t.Fatalf("concurrent admission failed: %v", admissionErr)
		}
	}
	if got := requests.Load(); got != 1 {
		t.Fatalf("concurrent admission issued %d Node requests, want 1", got)
	}

	if err := gateway.checkAdmission(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := requests.Load(); got != 1 {
		t.Fatalf("cached admission issued %d Node requests, want 1", got)
	}

	time.Sleep(admissionCacheDuration + 20*time.Millisecond)
	if err := gateway.checkAdmission(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := requests.Load(); got != 2 {
		t.Fatalf("expired admission cache issued %d Node requests, want 2", got)
	}
}

func TestGatewayShutdownCancelsSharedAdmissionCheck(t *testing.T) {
	requestStarted := make(chan struct{})
	nodeHTTP := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(requestStarted)
		<-r.Context().Done()
	}))
	defer nodeHTTP.Close()

	gateway, err := New(Config{
		NodeHTTPURL:    nodeHTTP.URL,
		ChannelNetwork: "tcp",
		ChannelAddress: "127.0.0.1:1",
		AdmissionPath:  "/readyz",
		DialTimeout:    5 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	admissionDone := make(chan error, 1)
	go func() { admissionDone <- gateway.checkAdmission(context.Background()) }()
	select {
	case <-requestStarted:
	case <-time.After(time.Second):
		t.Fatal("admission request did not start")
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := gateway.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-admissionDone:
		if err == nil {
			t.Fatal("admission check unexpectedly succeeded after shutdown")
		}
	case <-time.After(time.Second):
		t.Fatal("shared admission check survived gateway shutdown")
	}
}

func TestGatewayShutdownClosesActiveBridge(t *testing.T) {
	nodeHTTP := httptest.NewServer(http.NotFoundHandler())
	defer nodeHTTP.Close()
	channelListener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer channelListener.Close()
	accepted := make(chan net.Conn, 1)
	go func() {
		connection, acceptErr := channelListener.Accept()
		if acceptErr == nil {
			accepted <- connection
		}
	}()

	gateway, err := New(Config{
		NodeHTTPURL:       nodeHTTP.URL,
		ChannelNetwork:    "tcp",
		ChannelAddress:    channelListener.Addr().String(),
		HeartbeatInterval: time.Hour,
	})
	if err != nil {
		t.Fatal(err)
	}
	public := httptest.NewServer(gateway.Handler())
	defer public.Close()
	webSocketURL := "ws" + strings.TrimPrefix(public.URL, "http") + "/service"
	client, _, err := websocket.DefaultDialer.Dial(webSocketURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	backend := <-accepted
	defer backend.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := gateway.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	_ = backend.SetReadDeadline(time.Now().Add(time.Second))
	oneByte := make([]byte, 1)
	if _, err := backend.Read(oneByte); err == nil {
		t.Fatal("node channel remained open after gateway shutdown")
	}
}
