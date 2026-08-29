package gateway

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

var (
	requestHeadersTagHeader = []byte{0x00, 0x62, 0x32, 0xb6, 0x74, 0xfb, 0x24, 0xf9, 0xc1, 0x0b, 0x00,
		'r', 'e', 'q', '-', 'h', 'e', 'a', 'd', 'e', 'r', 's'}
	uriComponentsTagHeader = []byte{0x00, 0x90, 0xb5, 0x16, 0x83, 0x66, 0xf5, 0x6b, 0x58, 0x0e, 0x00,
		'u', 'r', 'i', '-', 'c', 'o', 'm', 'p', 'o', 'n', 'e', 'n', 't', 's'}
)

func TestParseDirectFileReadRequestFromJavaScriptFixture(t *testing.T) {
	fixture, err := hex.DecodeString("05ff000100949876ab3febdc42060062696e61727990410000ff0e00018900000001000700000000184469736b46696c65536572766963653a7265616446696c65ff0001006232b674fb24f9c10b007265712d6865616465727310020000fdff190001ff00010090b5168366f56b580e007572692d636f6d706f6e656e74735cafbf1dff0d000000ff0d000000ff0d00000a2f746d702f612e747874ff0d000000ff0d00000466696c65ff0d0000046368616e")
	if err != nil {
		t.Fatal(err)
	}
	request, ok := parseDirectFileReadRequest(fixture)
	if !ok {
		t.Fatal("JavaScript Fury request was not recognized")
	}
	if request.channelID != "chan" || request.requestID != 7 || request.uri.scheme != "file" || request.uri.path != "/tmp/a.txt" {
		t.Fatalf("unexpected request: %#v", request)
	}
}

func TestEncodeDirectFileReadResponseMatchesJavaScriptFixture(t *testing.T) {
	expected, err := hex.DecodeString("05ff000100949876ab3febdc42060062696e61727990410000ff0e00014a00000001020700000000184469736b46696c65536572766963653a7265616446696c65ff000100f24f22854645ecd20c00726573702d6865616465727310020000fdff0e000103000000414243ff0d0000046368616e")
	if err != nil {
		t.Fatal(err)
	}
	actual := encodeBinaryChannelMessage("chan", encodeDirectFileReadResponse(7, []byte("ABC")))
	if !bytes.Equal(actual, expected) {
		t.Fatalf("Go response differs from JavaScript Fury output:\n got %x\nwant %x", actual, expected)
	}
}

func TestAnyFileRPCJavaScriptFixtures(t *testing.T) {
	accessRequest, err := hex.DecodeString("01000100000000164469736b46696c65536572766963653a616363657373ff0001006232b674fb24f9c10b007265712d6865616465727310020000fd05020300477b22736368656d65223a2266696c65222c22617574686f72697479223a22222c2270617468223a222f746d70222c227175657279223a22222c22667261676d656e74223a22227d020000000000000000")
	if err != nil {
		t.Fatal(err)
	}
	assertAnyFileRPCFixture(t, accessRequest, 1, directFileAccessMethod, 2, "/tmp")

	directoryRequest, err := hex.DecodeString("010002000000001d4469736b46696c65536572766963653a726561644469726563746f7279ff000101000010020000fd05010300477b22736368656d65223a2266696c65222c22617574686f72697479223a22222c2270617468223a222f746d70222c227175657279223a22222c22667261676d656e74223a22227d")
	if err != nil {
		t.Fatal(err)
	}
	assertAnyFileRPCFixture(t, directoryRequest, 2, directFileDirectoryMethod, 1, "/tmp")

	accessResponse, err := hex.DecodeString("01020100000000164469736b46696c65536572766963653a616363657373ff000100f24f22854645ecd20c00726573702d6865616465727310020000fd0901")
	if err != nil {
		t.Fatal(err)
	}
	actualAccess := encodeAnyResponse(1, directFileAccessMethod, func(writer *bytes.Buffer) {
		writer.WriteByte(anyTypeBoolean)
		writer.WriteByte(1)
	})
	if !bytes.Equal(actualAccess, accessResponse) {
		t.Fatalf("Go access response differs from JavaScript output:\n got %x\nwant %x", actualAccess, accessResponse)
	}

	directoryResponse, err := hex.DecodeString("010202000000001d4469736b46696c65536572766963653a726561644469726563746f7279ff000100f24f22854645ecd20c00726573702d6865616465727310020000fd05020502000005612e74787402000000000000f03f0502000003646972020000000000000040")
	if err != nil {
		t.Fatal(err)
	}
	actualDirectory := encodeAnyResponse(2, directFileDirectoryMethod, func(writer *bytes.Buffer) {
		writeDirectoryEntries(writer, []directDirectoryEntry{{name: "a.txt", fileType: 1}, {name: "dir", fileType: 2}})
	})
	if !bytes.Equal(actualDirectory, directoryResponse) {
		t.Fatalf("Go directory response differs from JavaScript output:\n got %x\nwant %x", actualDirectory, directoryResponse)
	}
}

func TestFileStatJavaScriptFixtures(t *testing.T) {
	requestFixture, err := hex.DecodeString("01000700000000144469736b46696c65536572766963653a73746174ff0001006232b674fb24f9c10b007265712d6865616465727310020000fd050103004d7b22736368656d65223a2266696c65222c22617574686f72697479223a22222c2270617468223a222f746d702f612e747874222c227175657279223a22222c22667261676d656e74223a22227d")
	if err != nil {
		t.Fatal(err)
	}
	assertAnyFileRPCFixture(t, requestFixture, 7, directFileStatMethod, 1, "/tmp/a.txt")

	fileResponse, err := hex.DecodeString("01020700000000144469736b46696c65536572766963653a73746174ff000100f24f22854645ecd20c00726573702d6865616465727310020000fd030082017b22757269223a2266696c653a2f2f2f746d702f612e747874222c226c6173744d6f64696669636174696f6e223a313233342c2263726561746554696d65223a313230302c22697353796d626f6c69634c696e6b223a66616c73652c2269734469726563746f7279223a66616c73652c2273697a65223a332c2274797065223a317d")
	if err != nil {
		t.Fatal(err)
	}
	file := &directFileStat{
		uri:              "file:///tmp/a.txt",
		lastModification: 1234,
		createTime:       1200,
		isSymbolicLink:   false,
		isDirectory:      false,
		size:             3,
		fileType:         1,
	}
	if actual := encodeDirectFileStatTestResponse(7, file); !bytes.Equal(actual, fileResponse) {
		t.Fatalf("Go file stat response differs from JavaScript output:\n got %x\nwant %x", actual, fileResponse)
	}

	directoryResponse, err := hex.DecodeString("01020800000000144469736b46696c65536572766963653a73746174ff000100f24f22854645ecd20c00726573702d6865616465727310020000fd030082027b22757269223a2266696c653a2f2f2f746d70222c226c6173744d6f64696669636174696f6e223a313330302c2263726561746554696d65223a313130302c2269734469726563746f7279223a747275652c22697353796d626f6c69634c696e6b223a66616c73652c226368696c6472656e223a5b7b22757269223a2266696c653a2f2f2f746d702f612e747874222c226c6173744d6f64696669636174696f6e223a313233342c2263726561746554696d65223a313230302c22697353796d626f6c69634c696e6b223a66616c73652c2269734469726563746f7279223a66616c73652c2273697a65223a332c2274797065223a317d5d2c2274797065223a327d")
	if err != nil {
		t.Fatal(err)
	}
	directory := &directFileStat{
		uri:              "file:///tmp",
		lastModification: 1300,
		createTime:       1100,
		isDirectory:      true,
		isSymbolicLink:   false,
		children:         []*directFileStat{file},
		fileType:         2,
	}
	if actual := encodeDirectFileStatTestResponse(8, directory); !bytes.Equal(actual, directoryResponse) {
		t.Fatalf("Go directory stat response differs from JavaScript output:\n got %x\nwant %x", actual, directoryResponse)
	}
}

func TestNodeTimespecMillisMatchesJavaScriptDateRounding(t *testing.T) {
	tests := []struct {
		seconds     int64
		nanoseconds int64
		want        int64
	}{
		{seconds: 100, nanoseconds: 499_999, want: 100_000},
		{seconds: 100, nanoseconds: 500_000, want: 100_001},
		{seconds: 100, nanoseconds: 999_999_999, want: 101_000},
		{seconds: -1, nanoseconds: 999_400_000, want: -1},
	}
	for _, test := range tests {
		if got := nodeTimespecMillis(test.seconds, test.nanoseconds); got != test.want {
			t.Fatalf("nodeTimespecMillis(%d, %d) = %d, want %d", test.seconds, test.nanoseconds, got, test.want)
		}
	}
}

func TestTryDirectFileRPCHandlesBoundedFileStatsWithFallbacks(t *testing.T) {
	root := t.TempDir()
	filePath := filepath.Join(root, "a.txt")
	if err := os.WriteFile(filePath, []byte("abc"), 0o600); err != nil {
		t.Fatal(err)
	}
	directoryPath := filepath.Join(root, "dir")
	if err := os.Mkdir(directoryPath, 0o700); err != nil {
		t.Fatal(err)
	}
	fileURI := fileURIComponents{scheme: "file", path: filepath.ToSlash(filePath)}
	request := encodeAnyFileRPCTestRequest("rpc", 21, directFileStatMethod, fileURI, nil)
	response, _, method, _, handled := tryDirectFileRPC(request, 1024, 16*1024)
	if !handled || method != directFileRPCStat || len(response) == 0 {
		t.Fatalf("file stat was not handled in Go: handled=%v method=%d response=%x", handled, method, response)
	}
	serialized, ok := buildDirectFileStatJSON(fileURI, filePath, 16*1024)
	if !ok {
		t.Fatal("could not build the expected file stat")
	}
	var stat map[string]any
	if err := json.Unmarshal(serialized, &stat); err != nil {
		t.Fatal(err)
	}
	if stat["uri"] != fileURI.string() || stat["size"] != float64(3) || stat["type"] != float64(1) || stat["isDirectory"] != false {
		t.Fatalf("unexpected file stat: %#v", stat)
	}

	rootURI := fileURIComponents{scheme: "file", path: filepath.ToSlash(root)}
	rootRequest := encodeAnyFileRPCTestRequest("rpc", 22, directFileStatMethod, rootURI, nil)
	if _, _, method, _, handled := tryDirectFileRPC(rootRequest, 1024, 16*1024); !handled || method != directFileRPCStat {
		t.Fatal("directory stat was not handled in Go")
	}
	rootJSON, ok := buildDirectFileStatJSON(rootURI, root, 16*1024)
	if !ok {
		t.Fatal("could not build the expected directory stat")
	}
	var rootStat struct {
		Type     float64 `json:"type"`
		Children []struct {
			URI      string `json:"uri"`
			Type     int    `json:"type"`
			Children []any  `json:"children"`
		} `json:"children"`
	}
	if err := json.Unmarshal(rootJSON, &rootStat); err != nil {
		t.Fatal(err)
	}
	if rootStat.Type != 2 || len(rootStat.Children) != 2 || rootStat.Children[0].URI == "" || rootStat.Children[1].URI == "" {
		t.Fatalf("unexpected directory stat: %s", rootJSON)
	}

	linkPath := filepath.Join(root, "a-link")
	if err := os.Symlink(filePath, linkPath); err == nil {
		linkURI := fileURIComponents{scheme: "file", path: filepath.ToSlash(linkPath)}
		linkJSON, ok := buildDirectFileStatJSON(linkURI, linkPath, 16*1024)
		if !ok {
			t.Fatal("could not build the expected symbolic-link stat")
		}
		var linkStat map[string]any
		if err := json.Unmarshal(linkJSON, &linkStat); err != nil {
			t.Fatal(err)
		}
		realPath, err := filepath.EvalSymlinks(filePath)
		if err != nil {
			t.Fatal(err)
		}
		realURI, ok := fileURIFromLocalPath(realPath)
		if !ok {
			t.Fatal("could not create the expected real file URI")
		}
		if linkStat["uri"] != linkURI.string() || linkStat["realUri"] != realURI.string() || linkStat["type"] != float64(64) || linkStat["isSymbolicLink"] != true {
			t.Fatalf("unexpected symbolic-link stat: %#v", linkStat)
		}
	}

	if _, _, _, _, handled := tryDirectFileRPC(rootRequest, 1024, 300); handled {
		t.Fatal("oversized stat response bypassed Node fallback")
	}
	missingURI := fileURIComponents{scheme: "file", path: filepath.ToSlash(filepath.Join(root, "missing"))}
	if _, _, _, _, handled := tryDirectFileRPC(encodeAnyFileRPCTestRequest("rpc", 23, directFileStatMethod, missingURI, nil), 1024, 16*1024); handled {
		t.Fatal("missing stat bypassed Node fallback")
	}
}

func TestTryDirectFileRPCHandlesAccessAndDirectoryWithFallbacks(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "a.txt"), []byte("a"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "dir"), 0o700); err != nil {
		t.Fatal(err)
	}
	uri := fileURIComponents{scheme: "file", path: filepath.ToSlash(root)}

	accessRequest := encodeAnyFileRPCTestRequest("rpc", 11, directFileAccessMethod, uri, nil)
	accessResponse, _, method, _, handled := tryDirectFileRPC(accessRequest, 1024, 1024)
	expectedAccess := encodeBinaryChannelMessage("rpc", encodeAnyResponse(11, directFileAccessMethod, func(writer *bytes.Buffer) {
		writer.WriteByte(anyTypeBoolean)
		writer.WriteByte(1)
	}))
	if !handled || method != directFileRPCAccess || !bytes.Equal(accessResponse, expectedAccess) {
		t.Fatalf("access was not handled in Go: handled=%v method=%d response=%x", handled, method, accessResponse)
	}

	mode := float64(4)
	if _, _, _, _, handled := tryDirectFileRPC(encodeAnyFileRPCTestRequest("rpc", 12, directFileAccessMethod, uri, &mode), 1024, 1024); handled {
		t.Fatal("non-F_OK access mode bypassed Node fallback")
	}

	directoryRequest := encodeAnyFileRPCTestRequest("rpc", 13, directFileDirectoryMethod, uri, nil)
	directoryResponse, _, method, _, handled := tryDirectFileRPC(directoryRequest, 1024, 1024)
	expectedDirectory := encodeBinaryChannelMessage("rpc", encodeAnyResponse(13, directFileDirectoryMethod, func(writer *bytes.Buffer) {
		writeDirectoryEntries(writer, []directDirectoryEntry{{name: "a.txt", fileType: 1}, {name: "dir", fileType: 2}})
	}))
	if !handled || method != directFileRPCReadDirectory || !bytes.Equal(directoryResponse, expectedDirectory) {
		t.Fatalf("directory read was not handled in Go: handled=%v method=%d response=%x", handled, method, directoryResponse)
	}
	if _, _, _, _, handled := tryDirectFileRPC(directoryRequest, 1024, 260); handled {
		t.Fatal("oversized directory response bypassed Node fallback")
	}

	unsupportedURI := fileURIComponents{scheme: "http", path: "/tmp"}
	if _, _, _, _, handled := tryDirectFileRPC(encodeAnyFileRPCTestRequest("rpc", 14, directFileDirectoryMethod, unsupportedURI, nil), 1024, 1024); handled {
		t.Fatal("unsupported URI bypassed Node fallback")
	}
}

func TestTryDirectFileReadUsesGoForBoundedRegularFiles(t *testing.T) {
	filePath := filepath.Join(t.TempDir(), "direct-read.txt")
	if err := os.WriteFile(filePath, []byte("direct-from-go"), 0o600); err != nil {
		t.Fatal(err)
	}
	request := encodeDirectFileReadTestRequest("file-channel", 42, fileURIComponents{
		scheme: "file",
		path:   filepath.ToSlash(filePath),
	})
	response, contentBytes, handled := tryDirectFileRead(request, 1024)
	if !handled || contentBytes != int64(len("direct-from-go")) || len(response) == 0 {
		t.Fatalf("direct read failed: handled=%v bytes=%d response=%d", handled, contentBytes, len(response))
	}
	if _, _, handled := tryDirectFileRead(request, 4); handled {
		t.Fatal("oversized file bypassed Node fallback")
	}
	if err := os.Remove(filePath); err != nil {
		t.Fatal(err)
	}
	if _, _, handled := tryDirectFileRead(request, 1024); handled {
		t.Fatal("missing file bypassed Node fallback")
	}
}

func TestRespondDirectFileReadMatchesReferenceEncoderAndPoolRelease(t *testing.T) {
	content := []byte("pooled-read-payload")
	filePath := filepath.Join(t.TempDir(), "pooled-read.bin")
	if err := os.WriteFile(filePath, content, 0o600); err != nil {
		t.Fatal(err)
	}
	request := encodeDirectFileReadTestRequest("pooled-channel", 7, fileURIComponents{
		scheme: "file",
		path:   filepath.ToSlash(filePath),
	})
	parsed, ok := parseDirectFileReadRequest(request)
	if !ok {
		t.Fatal("request did not parse")
	}
	filePathResolved, ok := parsed.uri.localPath()
	if !ok {
		t.Fatal("uri did not resolve")
	}
	for round := 0; round < 3; round++ {
		response, release, contentBytes, handled := respondDirectFileRead(parsed, filePathResolved, 1024)
		if !handled || contentBytes != int64(len(content)) {
			t.Fatalf("round %d: pooled read failed handled=%v bytes=%d", round, handled, contentBytes)
		}
		expected := encodeBinaryChannelMessage("pooled-channel", encodeDirectFileReadResponse(7, content))
		if !bytes.Equal(response, expected) {
			t.Fatalf("round %d: pooled response diverges from reference encoder", round)
		}
		release()
		release() // must be idempotent
	}
}

func TestGatewayTerminatesDirectFileRPCsWithoutForwardingThemToNode(t *testing.T) {
	filePath := filepath.Join(t.TempDir(), "gateway-direct-read.txt")
	content := []byte("gateway-owned-file-content")
	if err := os.WriteFile(filePath, content, 0o600); err != nil {
		t.Fatal(err)
	}
	nodeHTTP := httptest.NewServer(http.NotFoundHandler())
	defer nodeHTTP.Close()
	channelListener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer channelListener.Close()
	backendObservation := make(chan error, 1)
	go func() {
		connection, acceptErr := channelListener.Accept()
		if acceptErr != nil {
			backendObservation <- acceptErr
			return
		}
		defer connection.Close()
		_ = connection.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
		_, readErr := readFrame(connection, 1024*1024)
		var networkErr net.Error
		if errors.As(readErr, &networkErr) && networkErr.Timeout() {
			backendObservation <- nil
			return
		}
		backendObservation <- readErr
	}()

	gateway, err := New(Config{
		NodeHTTPURL:       nodeHTTP.URL,
		ChannelNetwork:    "tcp",
		ChannelAddress:    channelListener.Addr().String(),
		DirectFileRPC:     true,
		MaxPayloadBytes:   1024 * 1024,
		HeartbeatInterval: time.Hour,
	})
	if err != nil {
		t.Fatal(err)
	}
	public := httptest.NewServer(gateway.Handler())
	defer public.Close()
	client, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(public.URL, "http")+"/service", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	request := encodeDirectFileReadTestRequest("rpc", 9, fileURIComponents{
		scheme: "file",
		path:   filepath.ToSlash(filePath),
	})
	if err := client.WriteMessage(websocket.BinaryMessage, request); err != nil {
		t.Fatal(err)
	}
	messageType, response, err := client.ReadMessage()
	if err != nil {
		t.Fatal(err)
	}
	expected := encodeBinaryChannelMessage("rpc", encodeDirectFileReadResponse(9, content))
	if messageType != websocket.BinaryMessage || !bytes.Equal(response, expected) {
		t.Fatalf("unexpected direct response: type=%d payload=%x", messageType, response)
	}
	fileURI := fileURIComponents{scheme: "file", path: filepath.ToSlash(filePath)}
	if err := client.WriteMessage(websocket.BinaryMessage, encodeAnyFileRPCTestRequest("rpc", 10, directFileAccessMethod, fileURI, nil)); err != nil {
		t.Fatal(err)
	}
	messageType, response, err = client.ReadMessage()
	if err != nil {
		t.Fatal(err)
	}
	expected = encodeBinaryChannelMessage("rpc", encodeAnyResponse(10, directFileAccessMethod, func(writer *bytes.Buffer) {
		writer.WriteByte(anyTypeBoolean)
		writer.WriteByte(1)
	}))
	if messageType != websocket.BinaryMessage || !bytes.Equal(response, expected) {
		t.Fatalf("unexpected direct access response: type=%d payload=%x", messageType, response)
	}
	directoryURI := fileURIComponents{scheme: "file", path: filepath.ToSlash(filepath.Dir(filePath))}
	if err := client.WriteMessage(websocket.BinaryMessage, encodeAnyFileRPCTestRequest("rpc", 11, directFileDirectoryMethod, directoryURI, nil)); err != nil {
		t.Fatal(err)
	}
	messageType, response, err = client.ReadMessage()
	if err != nil {
		t.Fatal(err)
	}
	expected = encodeBinaryChannelMessage("rpc", encodeAnyResponse(11, directFileDirectoryMethod, func(writer *bytes.Buffer) {
		writeDirectoryEntries(writer, []directDirectoryEntry{{name: filepath.Base(filePath), fileType: 1}})
	}))
	if messageType != websocket.BinaryMessage || !bytes.Equal(response, expected) {
		t.Fatalf("unexpected direct directory response: type=%d payload=%x", messageType, response)
	}
	if err := client.WriteMessage(websocket.BinaryMessage, encodeAnyFileRPCTestRequest("rpc", 12, directFileStatMethod, fileURI, nil)); err != nil {
		t.Fatal(err)
	}
	messageType, response, err = client.ReadMessage()
	if err != nil {
		t.Fatal(err)
	}
	statJSON, ok := buildDirectFileStatJSON(fileURI, filePath, defaultDirectFileReadMaxLen)
	if !ok {
		t.Fatal("could not build expected Gateway stat")
	}
	expected = encodeBinaryChannelMessage("rpc", encodeAnyResponse(12, directFileStatMethod, func(writer *bytes.Buffer) {
		writer.WriteByte(anyTypeJSONObject)
		writeRawString(writer, string(statJSON))
	}))
	if messageType != websocket.BinaryMessage || !bytes.Equal(response, expected) {
		t.Fatalf("unexpected direct stat response: type=%d payload=%x", messageType, response)
	}
	if observation := <-backendObservation; observation != nil {
		t.Fatalf("direct file RPC reached Node: %v", observation)
	}
	stats := gateway.Stats()
	if !stats.DirectFileRPCEnabled || stats.DirectFileRPCs != 4 || stats.DirectFileReads != 1 || stats.DirectFileReadBytes != uint64(len(content)) || stats.DirectFileAccesses != 1 || stats.DirectDirectoryReads != 1 || stats.DirectFileStats != 1 || stats.BrowserFramesForwarded != 0 {
		t.Fatalf("unexpected gateway stats: %#v", stats)
	}
	responseHTTP, err := http.Get(public.URL + defaultDiagnosticsPath)
	if err != nil {
		t.Fatal(err)
	}
	defer responseHTTP.Body.Close()
	var reported Stats
	if err := json.NewDecoder(responseHTTP.Body).Decode(&reported); err != nil {
		t.Fatal(err)
	}
	if reported.DirectFileRPCs != 4 || reported.DirectFileReads != 1 || reported.DirectFileAccesses != 1 || reported.DirectDirectoryReads != 1 || reported.DirectFileStats != 1 {
		t.Fatalf("diagnostics did not expose all direct file RPCs: %#v", reported)
	}
	shutdownContext, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := gateway.Shutdown(shutdownContext); err != nil {
		t.Fatal(err)
	}
}

func assertAnyFileRPCFixture(t *testing.T, inner []byte, expectedID uint32, expectedMethod string, expectedArguments uint32, expectedPath string) {
	t.Helper()
	payload := encodeBinaryChannelMessage("rpc", inner)
	channelID, requestID, method, reader, ok := parseRPCRequestEnvelope(payload)
	if !ok || channelID != "rpc" || requestID != expectedID || method != expectedMethod || !reader.anyArrayHeader() {
		t.Fatalf("JavaScript Any RPC envelope was not recognized: channel=%q id=%d method=%q", channelID, requestID, method)
	}
	argumentCount, ok := reader.varUint32()
	if !ok || argumentCount != expectedArguments {
		t.Fatalf("unexpected argument count: %d", argumentCount)
	}
	uri, ok := reader.anyFileURI()
	if !ok || uri.scheme != "file" || uri.path != expectedPath {
		t.Fatalf("unexpected URI: %#v", uri)
	}
	for argumentCount > 1 {
		if _, ok := reader.anyNumber(); !ok {
			t.Fatal("numeric access mode was not decoded")
		}
		argumentCount--
	}
	if !reader.done() {
		t.Fatal("fixture left unread bytes")
	}
}

func encodeAnyFileRPCTestRequest(channelID string, requestID uint32, method string, uri fileURIComponents, mode *float64) []byte {
	var request bytes.Buffer
	writeUint16(&request, 0x0001)
	writeUint32(&request, requestID)
	writeRawString(&request, method)
	writeObjectHeader(&request, requestHeadersTagHeader, requestHeadersHash)
	request.WriteByte(0xfd)
	request.WriteByte(anyTypeArray)
	argumentCount := uint32(1)
	if mode != nil {
		argumentCount++
	}
	writeVarUint32(&request, argumentCount)
	request.WriteByte(anyTypeJSONObject)
	serialized, _ := json.Marshal(struct {
		Scheme    string `json:"scheme"`
		Authority string `json:"authority"`
		Path      string `json:"path"`
		Query     string `json:"query"`
		Fragment  string `json:"fragment"`
	}{uri.scheme, uri.authority, uri.path, uri.query, uri.fragment})
	writeRawString(&request, string(serialized))
	if mode != nil {
		request.WriteByte(anyTypeNumber)
		writeFloat64(&request, *mode)
	}
	return encodeBinaryChannelMessage(channelID, request.Bytes())
}

func encodeDirectFileStatTestResponse(requestID uint32, stat *directFileStat) []byte {
	return encodeAnyResponse(requestID, directFileStatMethod, func(writer *bytes.Buffer) {
		writer.WriteByte(anyTypeJSONObject)
		var serialized bytes.Buffer
		stat.writeJSON(&serialized)
		writeRawString(writer, serialized.String())
	})
}

func encodeDirectFileReadTestRequest(channelID string, requestID uint32, uri fileURIComponents) []byte {
	var request bytes.Buffer
	writeUint16(&request, 0x0001)
	writeUint32(&request, requestID)
	writeRawString(&request, directFileReadMethod)
	writeObjectHeader(&request, requestHeadersTagHeader, requestHeadersHash)
	request.WriteByte(0xfd)
	writeTypedHeader(&request, furyTypeTuple)
	writeVarUint32(&request, 1)
	writeObjectHeader(&request, uriComponentsTagHeader, uriComponentsHash)
	writeFuryString(&request, uri.authority)
	writeFuryString(&request, uri.fragment)
	writeFuryString(&request, uri.path)
	writeFuryString(&request, uri.query)
	writeFuryString(&request, uri.scheme)
	return encodeBinaryChannelMessage(channelID, request.Bytes())
}
