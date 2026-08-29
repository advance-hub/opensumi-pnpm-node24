package gateway

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"io"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
)

const (
	channelMessageBinary = byte(5)

	furyNotNullValue = int8(-1)
	furyRefValue     = int8(0)
	furyNull         = int8(-3)
	furyTypeBool     = int16(1)
	furyTypeString   = int16(13)
	furyTypeBinary   = int16(14)
	furyTypeTuple    = int16(25)
	furyTypeObject   = int16(256)

	binaryMessageHash  = int32(16_784)
	requestHeadersHash = int32(528)
	uriComponentsHash  = int32(499_101_532)

	directFileReadMethod        = "DiskFileService:readFile"
	directFileAccessMethod      = "DiskFileService:access"
	directFileDirectoryMethod   = "DiskFileService:readDirectory"
	directFileStatMethod        = "DiskFileService:stat"
	defaultDirectFileReadMaxLen = int64(8 * 1024 * 1024)

	anyTypeString     = byte(0)
	anyTypeNumber     = byte(2)
	anyTypeJSONObject = byte(3)
	anyTypeArray      = byte(5)
	anyTypeUndefined  = byte(7)
	anyTypeNull       = byte(8)
	anyTypeBoolean    = byte(9)
)

var (
	binaryTagHeader = []byte{0x00, 0x94, 0x98, 0x76, 0xab, 0x3f, 0xeb, 0xdc, 0x42, 0x06, 0x00,
		'b', 'i', 'n', 'a', 'r', 'y'}
	responseHeadersTagHeader = []byte{0x00, 0xf2, 0x4f, 0x22, 0x85, 0x46, 0x45, 0xec, 0xd2, 0x0c, 0x00,
		'r', 'e', 's', 'p', '-', 'h', 'e', 'a', 'd', 'e', 'r', 's'}
)

type directFileReadRequest struct {
	channelID string
	requestID uint32
	uri       fileURIComponents
}

type directFileRPCMethod byte

const (
	directFileRPCRead directFileRPCMethod = iota + 1
	directFileRPCAccess
	directFileRPCReadDirectory
	directFileRPCStat
)

type fileURIComponents struct {
	authority string
	fragment  string
	path      string
	query     string
	scheme    string
}

type furyReader struct {
	data   []byte
	offset int
}

func parseDirectFileReadRequest(payload []byte) (directFileReadRequest, bool) {
	channelID, requestID, method, rpc, ok := parseRPCRequestEnvelope(payload)
	if !ok || method != directFileReadMethod || !rpc.typedHeader(furyTypeTuple) {
		return directFileReadRequest{}, false
	}
	argumentCount, ok := rpc.varUint32()
	if !ok || argumentCount != 1 || !rpc.objectHeader("uri-components", uriComponentsHash) {
		return directFileReadRequest{}, false
	}
	authority, ok := rpc.furyString()
	if !ok {
		return directFileReadRequest{}, false
	}
	fragment, ok := rpc.furyString()
	if !ok {
		return directFileReadRequest{}, false
	}
	uriPath, ok := rpc.furyString()
	if !ok {
		return directFileReadRequest{}, false
	}
	query, ok := rpc.furyString()
	if !ok {
		return directFileReadRequest{}, false
	}
	scheme, ok := rpc.furyString()
	if !ok || !rpc.done() {
		return directFileReadRequest{}, false
	}
	return directFileReadRequest{
		channelID: channelID,
		requestID: requestID,
		uri: fileURIComponents{
			authority: authority,
			fragment:  fragment,
			path:      uriPath,
			query:     query,
			scheme:    scheme,
		},
	}, true
}

func parseRPCRequestEnvelope(payload []byte) (string, uint32, string, *furyReader, bool) {
	reader := furyReader{data: payload}
	kind, ok := reader.uint8()
	if !ok || kind != channelMessageBinary || !reader.objectHeader("binary", binaryMessageHash) {
		return "", 0, "", nil, false
	}
	inner, ok := reader.furyBinary()
	if !ok {
		return "", 0, "", nil, false
	}
	channelID, ok := reader.furyString()
	if !ok || !reader.done() {
		return "", 0, "", nil, false
	}
	rpc := &furyReader{data: inner}
	prefix, ok := rpc.uint16()
	if !ok || prefix != 0x0001 {
		return "", 0, "", nil, false
	}
	requestID, ok := rpc.uint32()
	if !ok {
		return "", 0, "", nil, false
	}
	method, ok := rpc.rawString()
	if !ok || !rpc.requestHeaders() {
		return "", 0, "", nil, false
	}
	return channelID, requestID, method, rpc, true
}

func tryDirectFileRPC(payload []byte, maxReadBytes, maxMetadataBytes int64) ([]byte, func(), directFileRPCMethod, int64, bool) {
	request, ok := parseDirectFileReadRequest(payload)
	if ok {
		filePath, pathOK := request.uri.localPath()
		if !pathOK {
			return nil, nil, 0, 0, false
		}
		response, release, contentBytes, readOK := respondDirectFileRead(request, filePath, maxReadBytes)
		if !readOK {
			return nil, nil, 0, 0, false
		}
		return response, release, directFileRPCRead, contentBytes, true
	}
	channelID, requestID, method, rpc, ok := parseRPCRequestEnvelope(payload)
	if !ok || !rpc.anyArrayHeader() {
		return nil, nil, 0, 0, false
	}
	argumentCount, ok := rpc.varUint32()
	if !ok || argumentCount == 0 {
		return nil, nil, 0, 0, false
	}
	uri, ok := rpc.anyFileURI()
	if !ok {
		return nil, nil, 0, 0, false
	}
	filePath, ok := uri.localPath()
	if !ok {
		return nil, nil, 0, 0, false
	}
	switch method {
	case directFileAccessMethod:
		if argumentCount > 2 {
			return nil, nil, 0, 0, false
		}
		if argumentCount == 2 {
			mode, numberOK := rpc.anyNumber()
			if !numberOK || mode != 0 {
				return nil, nil, 0, 0, false
			}
		}
		if !rpc.done() {
			return nil, nil, 0, 0, false
		}
		_, statErr := os.Stat(filePath)
		response := encodeBinaryChannelMessage(channelID, encodeAnyResponse(requestID, method, func(writer *bytes.Buffer) {
			writer.WriteByte(anyTypeBoolean)
			if statErr == nil {
				writer.WriteByte(1)
			} else {
				writer.WriteByte(0)
			}
		}))
		return response, nil, directFileRPCAccess, 0, true
	case directFileDirectoryMethod:
		if argumentCount != 1 || !rpc.done() {
			return nil, nil, 0, 0, false
		}
		entries, withinLimit := readDirectoryEntries(filePath, maxMetadataBytes)
		if !withinLimit {
			return nil, nil, 0, 0, false
		}
		response := encodeBinaryChannelMessage(channelID, encodeAnyResponse(requestID, method, func(writer *bytes.Buffer) {
			writeDirectoryEntries(writer, entries)
		}))
		return response, nil, directFileRPCReadDirectory, 0, true
	case directFileStatMethod:
		if argumentCount > 2 {
			return nil, nil, 0, 0, false
		}
		if argumentCount == 2 && !rpc.anyStatOptions() {
			return nil, nil, 0, 0, false
		}
		if !rpc.done() {
			return nil, nil, 0, 0, false
		}
		serialized, statOK := buildDirectFileStatJSON(uri, filePath, maxMetadataBytes)
		if !statOK {
			return nil, nil, 0, 0, false
		}
		response := encodeBinaryChannelMessage(channelID, encodeAnyResponse(requestID, method, func(writer *bytes.Buffer) {
			writer.WriteByte(anyTypeJSONObject)
			writeRawString(writer, string(serialized))
		}))
		return response, nil, directFileRPCStat, 0, true
	default:
		return nil, nil, 0, 0, false
	}
}

func tryDirectFileRead(payload []byte, maxBytes int64) ([]byte, int64, bool) {
	response, _, _, contentBytes, handled := tryDirectFileRPC(payload, maxBytes, maxBytes)
	return response, contentBytes, handled
}

type directDirectoryEntry struct {
	name     string
	fileType float64
}

func readDirectoryEntries(filePath string, maxBytes int64) ([]directDirectoryEntry, bool) {
	if maxBytes <= 0 {
		maxBytes = defaultDirectFileReadMaxLen
	}
	directory, err := os.Open(filePath)
	if err != nil {
		return []directDirectoryEntry{}, true
	}
	defer directory.Close()
	result := make([]directDirectoryEntry, 0, 64)
	encodedBytes := int64(256) // Reserve the RPC/channel envelope and the outer array header.
	for {
		entries, readErr := directory.ReadDir(256)
		for _, entry := range entries {
			entryBytes := int64(len(entry.Name()) + 16)
			if encodedBytes > maxBytes-entryBytes {
				return nil, false
			}
			encodedBytes += entryBytes
			fileType := float64(0)
			if entry.Type()&os.ModeSymlink != 0 {
				info, statErr := os.Stat(filepath.Join(filePath, entry.Name()))
				if statErr != nil {
					sort.Slice(result, func(left, right int) bool { return result[left].name < result[right].name })
					return result, true
				}
				if info.IsDir() {
					fileType = 2
				} else if info.Mode().IsRegular() {
					fileType = 1
				}
			} else if entry.IsDir() {
				fileType = 2
			} else if entry.Type().IsRegular() {
				fileType = 1
			}
			result = append(result, directDirectoryEntry{name: entry.Name(), fileType: fileType})
		}
		if readErr != nil {
			sort.Slice(result, func(left, right int) bool { return result[left].name < result[right].name })
			return result, true
		}
	}
}

func encodeAnyResponse(requestID uint32, method string, writeResult func(*bytes.Buffer)) []byte {
	var response bytes.Buffer
	writeUint16(&response, 0x0201)
	writeUint32(&response, requestID)
	writeRawString(&response, method)
	writeObjectHeader(&response, responseHeadersTagHeader, requestHeadersHash)
	response.WriteByte(0xfd)
	writeResult(&response)
	return response.Bytes()
}

func writeDirectoryEntries(writer *bytes.Buffer, entries []directDirectoryEntry) {
	writer.WriteByte(anyTypeArray)
	writeVarUint32(writer, uint32(len(entries)))
	for _, entry := range entries {
		writer.WriteByte(anyTypeArray)
		writeVarUint32(writer, 2)
		writer.WriteByte(anyTypeString)
		writeRawString(writer, entry.name)
		writer.WriteByte(anyTypeNumber)
		writeFloat64(writer, entry.fileType)
	}
}

func readBoundedRegularFile(filePath string, maxBytes int64) ([]byte, bool) {
	if maxBytes <= 0 {
		maxBytes = defaultDirectFileReadMaxLen
	}
	file, err := os.Open(filePath)
	if err != nil {
		return nil, false
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > maxBytes {
		return nil, false
	}
	content, err := io.ReadAll(io.LimitReader(file, maxBytes+1))
	if err != nil || int64(len(content)) > maxBytes {
		return nil, false
	}
	return content, true
}

// readResponsePool recycles the response buffers backing readFile payloads.
// The direct read path previously allocated the file content, the inner Fury
// response and the outer channel message separately, so every request held a
// 3x payload copy in flight; reading straight into one pooled buffer keeps a
// single copy per request and removes the steady-state allocation churn.
const maxPooledReadResponseBytes = 16 << 20

var readResponsePool = sync.Pool{
	New: func() any {
		buffer := new(bytes.Buffer)
		buffer.Grow(64 << 10)
		return buffer
	},
}

func getPooledReadResponseBuffer() *bytes.Buffer {
	return readResponsePool.Get().(*bytes.Buffer)
}

func putPooledReadResponseBuffer(buffer *bytes.Buffer) {
	if buffer.Cap() > maxPooledReadResponseBytes {
		return
	}
	buffer.Reset()
	readResponsePool.Put(buffer)
}

// encodeDirectFileReadResponseInto writes the complete outer binary channel
// message for a readFile response, reserving room for exactly contentLen
// content bytes that the caller then reads into the buffer tail.
func encodeDirectFileReadResponseInto(buffer *bytes.Buffer, channelID string, requestID uint32, contentLen int64) {
	innerLen := lenDirectFileReadResponse(requestID, contentLen)
	encodeBinaryChannelMessagePrefix(buffer, innerLen)
	encodeDirectFileReadResponseHeader(buffer, requestID, contentLen)
}

func lenDirectFileReadResponse(requestID uint32, contentLen int64) int {
	return 2 /* writeUint16 */ + 4 /* writeUint32 */ +
		lenRawString(directFileReadMethod) +
		1 + 2 + len(responseHeadersTagHeader) + 4 /* writeObjectHeader */ +
		1 /* 0xfd */ +
		3 /* writeTypedHeader */ + 1 /* binary arity */ +
		4 /* writeUint32 content length */ +
		int(contentLen)
}

func lenRawString(value string) int {
	return 1 + lenVarUint32(uint32(len(value))) + len(value)
}

func lenVarUint32(value uint32) int {
	length := 1
	for value >= 0x80 {
		length++
		value >>= 7
	}
	return length
}

func encodeDirectFileReadResponseHeader(buffer *bytes.Buffer, requestID uint32, contentLen int64) {
	writeUint16(buffer, 0x0201)
	writeUint32(buffer, requestID)
	writeRawString(buffer, directFileReadMethod)
	writeObjectHeader(buffer, responseHeadersTagHeader, requestHeadersHash)
	buffer.WriteByte(0xfd)
	writeTypedHeader(buffer, furyTypeBinary)
	buffer.WriteByte(1)
	writeUint32(buffer, uint32(contentLen))
}

// respondDirectFileRead streams the file directly into one pooled response
// buffer. It reports handled=false for any input the Node implementation must
// answer instead, mirroring readBoundedRegularFile's eligibility rules. The
// release callback returns the buffer to the pool and must run only after the
// payload has been written to the browser connection.
func respondDirectFileRead(request directFileReadRequest, filePath string, maxBytes int64) ([]byte, func(), int64, bool) {
	if maxBytes <= 0 {
		maxBytes = defaultDirectFileReadMaxLen
	}
	file, err := os.Open(filePath)
	if err != nil {
		return nil, nil, 0, false
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > maxBytes {
		return nil, nil, 0, false
	}
	contentLen := info.Size()
	totalLen := binaryChannelMessageLen(request.channelID, lenDirectFileReadResponse(request.requestID, contentLen))
	if totalLen > maxPooledReadResponseBytes {
		return nil, nil, 0, false
	}
	buffer := getPooledReadResponseBuffer()
	if buffer.Cap() < int(totalLen) {
		buffer.Grow(int(totalLen))
	}
	encodeDirectFileReadResponseInto(buffer, request.channelID, request.requestID, contentLen)
	// The channel string trailer is written after the content, so it is part
	// of the expected total but not of the current length yet.
	if int64(buffer.Len())+contentLen+int64(lenRawString(request.channelID)) != int64(totalLen) {
		// The size model drifted from the encoders; fall back to Node rather
		// than emitting a framing the browser cannot parse.
		putPooledReadResponseBuffer(buffer)
		return nil, nil, 0, false
	}
	if _, err := io.CopyN(buffer, file, contentLen); err != nil {
		// A short or failed read (concurrent truncation) must not emit a
		// malformed response: let Node answer instead.
		putPooledReadResponseBuffer(buffer)
		return nil, nil, 0, false
	}
	writeBinaryChannelMessageTrailer(buffer, request.channelID)
	response := buffer.Bytes()
	returned := false
	release := func() {
		// Idempotent by contract: the bridge may release on both the written
		// and the error path, and a double put would corrupt the pool.
		if !returned {
			returned = true
			putPooledReadResponseBuffer(buffer)
		}
	}
	return response, release, contentLen, true
}

func (uri fileURIComponents) localPath() (string, bool) {
	if uri.scheme != "file" || uri.query != "" || uri.fragment != "" || uri.path == "" {
		return "", false
	}
	if runtime.GOOS != "windows" {
		if uri.authority != "" || !strings.HasPrefix(uri.path, "/") {
			return "", false
		}
		return filepath.FromSlash(uri.path), true
	}
	if uri.authority != "" {
		return `\\` + uri.authority + filepath.FromSlash(uri.path), true
	}
	path := uri.path
	if len(path) >= 3 && path[0] == '/' && path[2] == ':' {
		path = path[1:]
	}
	if len(path) < 2 || path[1] != ':' {
		return "", false
	}
	return filepath.FromSlash(path), true
}

func encodeDirectFileReadResponse(requestID uint32, content []byte) []byte {
	var response bytes.Buffer
	writeUint16(&response, 0x0201)
	writeUint32(&response, requestID)
	writeRawString(&response, directFileReadMethod)
	writeObjectHeader(&response, responseHeadersTagHeader, requestHeadersHash)
	response.WriteByte(0xfd)
	writeTypedHeader(&response, furyTypeBinary)
	response.WriteByte(1)
	writeUint32(&response, uint32(len(content)))
	response.Write(content)
	return response.Bytes()
}

// encodeBinaryChannelMessagePrefix writes everything encodeBinaryChannelMessage
// emits before the inner payload. The channel string is written after the
// payload by writeBinaryChannelMessageTrailer, mirroring the reference encoder.
func encodeBinaryChannelMessagePrefix(buffer *bytes.Buffer, innerLen int) {
	buffer.WriteByte(channelMessageBinary)
	writeObjectHeader(buffer, binaryTagHeader, binaryMessageHash)
	writeTypedHeader(buffer, furyTypeBinary)
	buffer.WriteByte(1)
	writeUint32(buffer, uint32(innerLen))
}

func writeBinaryChannelMessageTrailer(buffer *bytes.Buffer, channelID string) {
	writeFuryString(buffer, channelID)
}

func binaryChannelMessageLen(channelID string, innerLen int) int {
	return 1 /* message type */ +
		1 + 2 + len(binaryTagHeader) + 4 /* writeObjectHeader */ +
		3 /* writeTypedHeader */ + 1 /* arity */ +
		4 /* inner length */ +
		lenRawString(channelID) +
		innerLen
}

func encodeBinaryChannelMessage(channelID string, inner []byte) []byte {
	var response bytes.Buffer
	response.WriteByte(channelMessageBinary)
	writeObjectHeader(&response, binaryTagHeader, binaryMessageHash)
	writeTypedHeader(&response, furyTypeBinary)
	response.WriteByte(1)
	writeUint32(&response, uint32(len(inner)))
	response.Write(inner)
	writeFuryString(&response, channelID)
	return response.Bytes()
}

func writeObjectHeader(writer *bytes.Buffer, tagHeader []byte, hash int32) {
	writer.WriteByte(0xff)
	writeUint16(writer, uint16(furyTypeObject))
	writer.Write(tagHeader)
	writeUint32(writer, uint32(hash))
}

func writeTypedHeader(writer *bytes.Buffer, wireType int16) {
	writer.WriteByte(0xff)
	writeUint16(writer, uint16(wireType))
}

func writeFuryString(writer *bytes.Buffer, value string) {
	writeTypedHeader(writer, furyTypeString)
	writeRawString(writer, value)
}

func writeRawString(writer *bytes.Buffer, value string) {
	encoding := byte(0)
	for _, current := range value {
		if current > 0x7f {
			encoding = 1
			break
		}
	}
	writer.WriteByte(encoding)
	writeVarUint32(writer, uint32(len(value)))
	writer.WriteString(value)
}

func writeUint16(writer *bytes.Buffer, value uint16) {
	var encoded [2]byte
	binary.LittleEndian.PutUint16(encoded[:], value)
	writer.Write(encoded[:])
}

func writeUint32(writer *bytes.Buffer, value uint32) {
	var encoded [4]byte
	binary.LittleEndian.PutUint32(encoded[:], value)
	writer.Write(encoded[:])
}

func writeFloat64(writer *bytes.Buffer, value float64) {
	var encoded [8]byte
	binary.LittleEndian.PutUint64(encoded[:], math.Float64bits(value))
	writer.Write(encoded[:])
}

func writeVarUint32(writer *bytes.Buffer, value uint32) {
	for value >= 0x80 {
		writer.WriteByte(byte(value) | 0x80)
		value >>= 7
	}
	writer.WriteByte(byte(value))
}

func (reader *furyReader) done() bool {
	return reader.offset == len(reader.data)
}

func (reader *furyReader) bytes(length int) ([]byte, bool) {
	if length < 0 || reader.offset > len(reader.data)-length {
		return nil, false
	}
	value := reader.data[reader.offset : reader.offset+length]
	reader.offset += length
	return value, true
}

func (reader *furyReader) uint8() (byte, bool) {
	value, ok := reader.bytes(1)
	if !ok {
		return 0, false
	}
	return value[0], true
}

func (reader *furyReader) int8() (int8, bool) {
	value, ok := reader.uint8()
	return int8(value), ok
}

func (reader *furyReader) uint16() (uint16, bool) {
	value, ok := reader.bytes(2)
	if !ok {
		return 0, false
	}
	return binary.LittleEndian.Uint16(value), true
}

func (reader *furyReader) int16() (int16, bool) {
	value, ok := reader.uint16()
	return int16(value), ok
}

func (reader *furyReader) uint32() (uint32, bool) {
	value, ok := reader.bytes(4)
	if !ok {
		return 0, false
	}
	return binary.LittleEndian.Uint32(value), true
}

func (reader *furyReader) int32() (int32, bool) {
	value, ok := reader.uint32()
	return int32(value), ok
}

func (reader *furyReader) float64() (float64, bool) {
	value, ok := reader.bytes(8)
	if !ok {
		return 0, false
	}
	return math.Float64frombits(binary.LittleEndian.Uint64(value)), true
}

func (reader *furyReader) varUint32() (uint32, bool) {
	var value uint32
	for shift := uint(0); shift < 35; shift += 7 {
		current, ok := reader.uint8()
		if !ok || (shift == 28 && current > 0x0f) {
			return 0, false
		}
		value |= uint32(current&0x7f) << shift
		if current&0x80 == 0 {
			return value, true
		}
	}
	return 0, false
}

func (reader *furyReader) rawString() (string, bool) {
	encoding, ok := reader.uint8()
	if !ok || (encoding != 0 && encoding != 1) {
		return "", false
	}
	length, ok := reader.varUint32()
	if !ok || uint64(length) > uint64(len(reader.data)-reader.offset) {
		return "", false
	}
	value, ok := reader.bytes(int(length))
	if !ok {
		return "", false
	}
	return string(value), true
}

func (reader *furyReader) typedHeader(wireType int16) bool {
	flag, ok := reader.int8()
	if !ok || (flag != furyNotNullValue && flag != furyRefValue) {
		return false
	}
	actualType, ok := reader.int16()
	return ok && actualType == wireType
}

func (reader *furyReader) furyString() (string, bool) {
	if !reader.typedHeader(furyTypeString) {
		return "", false
	}
	return reader.rawString()
}

func (reader *furyReader) furyBinary() ([]byte, bool) {
	if !reader.typedHeader(furyTypeBinary) {
		return nil, false
	}
	inBand, ok := reader.uint8()
	if !ok || inBand != 1 {
		return nil, false
	}
	length, ok := reader.uint32()
	if !ok || uint64(length) > uint64(len(reader.data)-reader.offset) {
		return nil, false
	}
	return reader.bytes(int(length))
}

func (reader *furyReader) objectHeader(expectedTag string, expectedHash int32) bool {
	if !reader.typedHeader(furyTypeObject) || !reader.tag(expectedTag) {
		return false
	}
	hash, ok := reader.int32()
	return ok && hash == expectedHash
}

func (reader *furyReader) tag(expected string) bool {
	flag, ok := reader.uint8()
	if !ok {
		return false
	}
	switch flag {
	case 0:
		if _, ok := reader.bytes(8); !ok {
			return false
		}
		length, ok := reader.int16()
		if !ok || length < 0 {
			return false
		}
		value, ok := reader.bytes(int(length))
		return ok && string(value) == expected
	case 1:
		_, ok := reader.int16()
		return ok
	default:
		return false
	}
}

func (reader *furyReader) requestHeaders() bool {
	if !reader.objectHeader("req-headers", requestHeadersHash) {
		return false
	}
	flag, ok := reader.int8()
	if !ok {
		return false
	}
	if flag == furyNull {
		return true
	}
	if flag != furyNotNullValue && flag != furyRefValue {
		return false
	}
	wireType, ok := reader.int16()
	if !ok || wireType != furyTypeBool {
		return false
	}
	_, ok = reader.uint8()
	return ok
}

func (reader *furyReader) anyArrayHeader() bool {
	wireType, ok := reader.uint8()
	return ok && wireType == anyTypeArray
}

func (reader *furyReader) anyNumber() (float64, bool) {
	wireType, ok := reader.uint8()
	if !ok || wireType != anyTypeNumber {
		return 0, false
	}
	return reader.float64()
}

func (reader *furyReader) anyStatOptions() bool {
	wireType, ok := reader.uint8()
	if !ok {
		return false
	}
	switch wireType {
	case anyTypeUndefined, anyTypeNull:
		return true
	case anyTypeJSONObject:
		serialized, ok := reader.rawString()
		if !ok {
			return false
		}
		var options map[string]json.RawMessage
		return json.Unmarshal([]byte(serialized), &options) == nil
	default:
		return false
	}
}

func (reader *furyReader) anyFileURI() (fileURIComponents, bool) {
	wireType, ok := reader.uint8()
	if !ok || wireType != anyTypeJSONObject {
		return fileURIComponents{}, false
	}
	serialized, ok := reader.rawString()
	if !ok {
		return fileURIComponents{}, false
	}
	var uri struct {
		Authority string `json:"authority"`
		Fragment  string `json:"fragment"`
		Path      string `json:"path"`
		Query     string `json:"query"`
		Scheme    string `json:"scheme"`
	}
	if json.Unmarshal([]byte(serialized), &uri) != nil {
		return fileURIComponents{}, false
	}
	return fileURIComponents{
		authority: uri.Authority,
		fragment:  uri.Fragment,
		path:      uri.Path,
		query:     uri.Query,
		scheme:    uri.Scheme,
	}, true
}
