package gateway

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
	"sync/atomic"
	"time"
)

const (
	multiplexHeaderBytes     = 9
	multiplexOpen            = byte(1)
	multiplexData            = byte(2)
	multiplexClose           = byte(3)
	multiplexMaxQueuedFrames = 256
)

var multiplexPreface = []byte("OMUX1\n")

type multiplexBackend struct {
	config Config
	conn   net.Conn

	writeMu  sync.Mutex
	streamMu sync.Mutex
	streams  map[uint32]*multiplexStream
	nextID   atomic.Uint32

	closed    chan struct{}
	closeOnce sync.Once
}

func newMultiplexBackend(config Config) (*multiplexBackend, error) {
	dialContext, cancel := context.WithTimeout(context.Background(), config.DialTimeout)
	defer cancel()
	connection, err := (&net.Dialer{}).DialContext(dialContext, config.ChannelNetwork, config.ChannelAddress)
	if err != nil {
		return nil, fmt.Errorf("dial multiplexed node channel: %w", err)
	}
	backend := &multiplexBackend{
		config:  config,
		conn:    connection,
		streams: make(map[uint32]*multiplexStream),
		closed:  make(chan struct{}),
	}
	if err := backend.writeRaw(multiplexPreface); err != nil {
		_ = connection.Close()
		return nil, fmt.Errorf("write multiplexed node channel preface: %w", err)
	}
	go backend.readLoop()
	return backend, nil
}

func (b *multiplexBackend) openStream() (*multiplexStream, error) {
	select {
	case <-b.closed:
		return nil, net.ErrClosed
	default:
	}
	streamID := b.nextID.Add(1)
	if streamID == 0 {
		return nil, errors.New("multiplexed channel stream identifiers exhausted")
	}
	stream := &multiplexStream{
		backend:       b,
		id:            streamID,
		incomingReady: make(chan struct{}, 1),
		incomingLimit: b.config.MaxBufferedBytes,
		closed:        make(chan struct{}),
	}
	b.streamMu.Lock()
	select {
	case <-b.closed:
		b.streamMu.Unlock()
		return nil, net.ErrClosed
	default:
		b.streams[streamID] = stream
	}
	b.streamMu.Unlock()
	if err := b.writeFrame(multiplexOpen, streamID, nil); err != nil {
		b.closeStream(streamID, false, err)
		return nil, err
	}
	return stream, nil
}

func (b *multiplexBackend) writeFrame(frameType byte, streamID uint32, payload []byte) error {
	if streamID == 0 || int64(len(payload)) > b.config.MaxPayloadBytes {
		return errors.New("invalid multiplexed channel frame")
	}
	frame := make([]byte, multiplexHeaderBytes+len(payload))
	frame[0] = frameType
	binary.LittleEndian.PutUint32(frame[1:5], streamID)
	binary.LittleEndian.PutUint32(frame[5:9], uint32(len(payload)))
	copy(frame[multiplexHeaderBytes:], payload)
	if err := b.writeRaw(frame); err != nil {
		b.close()
		return err
	}
	return nil
}

func (b *multiplexBackend) writeRaw(payload []byte) error {
	b.writeMu.Lock()
	defer b.writeMu.Unlock()
	if b.config.WriteTimeout > 0 {
		if err := b.conn.SetWriteDeadline(time.Now().Add(b.config.WriteTimeout)); err != nil {
			return err
		}
	}
	return writeAll(b.conn, payload)
}

func (b *multiplexBackend) readLoop() {
	for {
		frameType, streamID, payload, err := readMultiplexFrame(b.conn, b.config.MaxPayloadBytes)
		if err != nil {
			b.close()
			return
		}
		b.streamMu.Lock()
		stream := b.streams[streamID]
		b.streamMu.Unlock()
		if stream == nil {
			b.close()
			return
		}
		switch frameType {
		case multiplexData:
			if !stream.deliver(payload) {
				b.closeStream(streamID, true, errors.New("multiplexed stream consumer is too slow"))
			}
		case multiplexClose:
			if len(payload) != 0 {
				b.close()
				return
			}
			b.closeStream(streamID, false, io.EOF)
		default:
			b.close()
			return
		}
	}
}

func (b *multiplexBackend) closeStream(streamID uint32, notifyPeer bool, cause error) {
	b.streamMu.Lock()
	stream := b.streams[streamID]
	if stream != nil {
		delete(b.streams, streamID)
	}
	b.streamMu.Unlock()
	if stream == nil {
		return
	}
	if notifyPeer {
		_ = b.writeFrame(multiplexClose, streamID, nil)
	}
	stream.terminate(cause)
}

func (b *multiplexBackend) close() {
	b.closeOnce.Do(func() {
		_ = b.conn.Close()
		close(b.closed)
		b.streamMu.Lock()
		streams := make([]*multiplexStream, 0, len(b.streams))
		for _, stream := range b.streams {
			streams = append(streams, stream)
		}
		clear(b.streams)
		b.streamMu.Unlock()
		for _, stream := range streams {
			stream.terminate(net.ErrClosed)
		}
	})
}

func readMultiplexFrame(reader io.Reader, maxPayloadBytes int64) (byte, uint32, []byte, error) {
	var header [multiplexHeaderBytes]byte
	if _, err := io.ReadFull(reader, header[:]); err != nil {
		return 0, 0, nil, err
	}
	streamID := binary.LittleEndian.Uint32(header[1:5])
	payloadLength := binary.LittleEndian.Uint32(header[5:9])
	if streamID == 0 || int64(payloadLength) > maxPayloadBytes {
		return 0, 0, nil, errors.New("invalid multiplexed channel frame header")
	}
	payload := make([]byte, payloadLength)
	if _, err := io.ReadFull(reader, payload); err != nil {
		return 0, 0, nil, err
	}
	return header[0], streamID, payload, nil
}

type multiplexStream struct {
	backend *multiplexBackend
	id      uint32

	incomingMu    sync.Mutex
	incomingQueue [][]byte
	incomingBytes int64
	incomingReady chan struct{}
	incomingLimit int64
	closed        chan struct{}
	closeOnce     sync.Once
	closeErr      error

	readMu      sync.Mutex
	readBuffer  []byte
	writeMu     sync.Mutex
	writeBuffer []byte
}

func (s *multiplexStream) deliver(payload []byte) bool {
	select {
	case <-s.closed:
		return false
	default:
	}
	s.incomingMu.Lock()
	defer s.incomingMu.Unlock()
	if len(s.incomingQueue) >= multiplexMaxQueuedFrames ||
		(s.incomingBytes > 0 && s.incomingBytes+int64(len(payload)) > s.incomingLimit) {
		return false
	}
	s.incomingQueue = append(s.incomingQueue, payload)
	s.incomingBytes += int64(len(payload))
	select {
	case s.incomingReady <- struct{}{}:
	default:
	}
	return true
}

func (s *multiplexStream) Read(target []byte) (int, error) {
	s.readMu.Lock()
	defer s.readMu.Unlock()
	if len(s.readBuffer) == 0 {
		select {
		case <-s.closed:
			return 0, s.readError()
		default:
		}
		payload, err := s.nextPayload()
		if err != nil {
			return 0, err
		}
		s.readBuffer = encodeBridgeFrame(payload)
	}
	count := copy(target, s.readBuffer)
	s.readBuffer = s.readBuffer[count:]
	return count, nil
}

func (s *multiplexStream) nextPayload() ([]byte, error) {
	for {
		select {
		case <-s.closed:
			return nil, s.readError()
		default:
		}
		s.incomingMu.Lock()
		if len(s.incomingQueue) > 0 {
			payload := s.incomingQueue[0]
			s.incomingQueue[0] = nil
			s.incomingQueue = s.incomingQueue[1:]
			s.incomingBytes -= int64(len(payload))
			if len(s.incomingQueue) > 0 {
				select {
				case s.incomingReady <- struct{}{}:
				default:
				}
			}
			s.incomingMu.Unlock()
			return payload, nil
		}
		s.incomingMu.Unlock()
		select {
		case <-s.incomingReady:
		case <-s.closed:
			return nil, s.readError()
		}
	}
}

func (s *multiplexStream) Write(frame []byte) (int, error) {
	select {
	case <-s.closed:
		return 0, s.readError()
	default:
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	s.writeBuffer = append(s.writeBuffer, frame...)
	if int64(len(s.writeBuffer)) > s.backend.config.MaxPayloadBytes+8 {
		return 0, errors.New("buffered bridge frame exceeds payload limit")
	}
	for len(s.writeBuffer) >= 8 {
		if !bytes.Equal(s.writeBuffer[:4], frameIndicator[:]) {
			return 0, errors.New("invalid bridge frame on multiplexed stream")
		}
		payloadLength := int(binary.LittleEndian.Uint32(s.writeBuffer[4:8]))
		if int64(payloadLength) > s.backend.config.MaxPayloadBytes {
			return 0, errors.New("bridge frame exceeds payload limit")
		}
		frameLength := payloadLength + 8
		if len(s.writeBuffer) < frameLength {
			break
		}
		payload := s.writeBuffer[8:frameLength]
		if err := s.backend.writeFrame(multiplexData, s.id, payload); err != nil {
			return 0, err
		}
		s.writeBuffer = s.writeBuffer[frameLength:]
	}
	return len(frame), nil
}

func (s *multiplexStream) Close() error {
	s.backend.closeStream(s.id, true, net.ErrClosed)
	return nil
}

func (s *multiplexStream) LocalAddr() net.Addr              { return multiplexAddress("gateway") }
func (s *multiplexStream) RemoteAddr() net.Addr             { return multiplexAddress("node") }
func (s *multiplexStream) SetDeadline(time.Time) error      { return nil }
func (s *multiplexStream) SetReadDeadline(time.Time) error  { return nil }
func (s *multiplexStream) SetWriteDeadline(time.Time) error { return nil }

func (s *multiplexStream) terminate(cause error) {
	s.closeOnce.Do(func() {
		if cause == nil {
			cause = io.EOF
		}
		s.closeErr = cause
		close(s.closed)
	})
}

func (s *multiplexStream) readError() error {
	if s.closeErr == nil {
		return io.EOF
	}
	return s.closeErr
}

func encodeBridgeFrame(payload []byte) []byte {
	frame := make([]byte, 8+len(payload))
	copy(frame, frameIndicator[:])
	binary.LittleEndian.PutUint32(frame[4:8], uint32(len(payload)))
	copy(frame[8:], payload)
	return frame
}

type multiplexAddress string

func (a multiplexAddress) Network() string { return channelModeMultiplexV1 }
func (a multiplexAddress) String() string  { return string(a) }
