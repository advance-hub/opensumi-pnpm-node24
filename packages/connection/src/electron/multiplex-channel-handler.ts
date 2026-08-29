import net from 'net';

import { IDisposable } from '@opensumi/ide-core-common';

import { ILogger } from '../common';
import { IConnectionShape } from '../common/connection/types';
import { BaseCommonChannelHandler, CommonChannelPathHandler } from '../common/server-handler';

const MULTIPLEX_PREFACE = Buffer.from('OMUX1\n');
const MULTIPLEX_HEADER_BYTES = 9;
const MULTIPLEX_OPEN = 1;
const MULTIPLEX_DATA = 2;
const MULTIPLEX_CLOSE = 3;
const DEFAULT_MAX_PAYLOAD = 32 * 1024 * 1024;
const DEFAULT_MAX_BUFFERED_AMOUNT = 16 * 1024 * 1024;

interface MultiplexChannelHandlerOptions {
  maxPayload?: number;
  maxBufferedAmount?: number;
}

class MultiplexedConnection implements IConnectionShape<Uint8Array> {
  private readonly messageListeners = new Set<(data: Uint8Array) => void>();
  private readonly closeListeners = new Set<(code?: number, reason?: string) => void>();
  private closed = false;

  constructor(
    readonly streamId: number,
    private readonly transport: MultiplexChannelTransport,
  ) {}

  send(data: Uint8Array): void {
    if (!this.closed) {
      this.transport.sendData(this.streamId, data);
    }
  }

  onMessage(cb: (data: Uint8Array) => void): IDisposable {
    this.messageListeners.add(cb);
    return { dispose: () => this.messageListeners.delete(cb) };
  }

  onceClose(cb: (code?: number, reason?: string) => void): IDisposable {
    const wrapper = (code?: number, reason?: string) => {
      this.closeListeners.delete(wrapper);
      cb(code, reason);
    };
    this.closeListeners.add(wrapper);
    return { dispose: () => this.closeListeners.delete(wrapper) };
  }

  receive(data: Uint8Array): void {
    if (!this.closed) {
      this.messageListeners.forEach((listener) => listener(data));
    }
  }

  close(code = 0, reason = ''): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const listeners = Array.from(this.closeListeners);
    this.closeListeners.clear();
    this.messageListeners.clear();
    listeners.forEach((listener) => listener(code, reason));
  }
}

class MultiplexChannelTransport {
  private buffer: Buffer = Buffer.alloc(0);
  private prefaceAccepted = false;
  private closed = false;
  private readonly streams = new Map<number, MultiplexedConnection>();

  constructor(
    private readonly socket: net.Socket,
    private readonly onOpen: (connection: MultiplexedConnection) => void,
    private readonly onClosed: () => void,
    private readonly logger: ILogger,
    private readonly maxPayload: number,
    private readonly maxBufferedAmount: number,
  ) {
    socket.on('data', (chunk) => this.accept(chunk));
    socket.on('error', (error) => this.logger.warn('multiplexed channel transport error', error));
    socket.once('close', (hadError) => this.closeAll(hadError ? 1 : 0, hadError ? 'physical transport error' : ''));
  }

  sendData(streamId: number, data: Uint8Array): void {
    if (this.closed || data.byteLength > this.maxPayload) {
      this.closeStream(streamId, 1, 'outbound payload exceeds limit');
      return;
    }
    this.writeFrame(MULTIPLEX_DATA, streamId, data);
  }

  close(): void {
    if (!this.closed) {
      this.socket.destroy();
    }
  }

  private accept(chunk: Buffer): void {
    if (this.closed) {
      return;
    }
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    if (!this.prefaceAccepted) {
      if (this.buffer.length < MULTIPLEX_PREFACE.length) {
        return;
      }
      if (!this.buffer.subarray(0, MULTIPLEX_PREFACE.length).equals(MULTIPLEX_PREFACE)) {
        this.fail('invalid multiplexed channel preface');
        return;
      }
      this.buffer = this.buffer.subarray(MULTIPLEX_PREFACE.length);
      this.prefaceAccepted = true;
    }
    while (this.buffer.length >= MULTIPLEX_HEADER_BYTES) {
      const frameType = this.buffer.readUInt8(0);
      const streamId = this.buffer.readUInt32LE(1);
      const payloadLength = this.buffer.readUInt32LE(5);
      if (streamId === 0 || payloadLength > this.maxPayload) {
        this.fail(`invalid multiplexed channel frame stream=${streamId} length=${payloadLength}`);
        return;
      }
      const frameLength = MULTIPLEX_HEADER_BYTES + payloadLength;
      if (this.buffer.length < frameLength) {
        return;
      }
      const payload = this.buffer.subarray(MULTIPLEX_HEADER_BYTES, frameLength);
      this.buffer = this.buffer.subarray(frameLength);
      if (!this.dispatch(frameType, streamId, payload)) {
        return;
      }
    }
  }

  private dispatch(frameType: number, streamId: number, payload: Buffer): boolean {
    if (frameType === MULTIPLEX_OPEN) {
      if (payload.length !== 0 || this.streams.has(streamId)) {
        this.fail(`invalid multiplexed channel open for stream ${streamId}`);
        return false;
      }
      const connection = new MultiplexedConnection(streamId, this);
      this.streams.set(streamId, connection);
      this.onOpen(connection);
      return true;
    }
    const connection = this.streams.get(streamId);
    if (!connection) {
      this.fail(`multiplexed channel frame references unknown stream ${streamId}`);
      return false;
    }
    if (frameType === MULTIPLEX_DATA) {
      connection.receive(payload);
      return true;
    }
    if (frameType === MULTIPLEX_CLOSE && payload.length === 0) {
      this.streams.delete(streamId);
      connection.close();
      return true;
    }
    this.fail(`invalid multiplexed channel frame type ${frameType}`);
    return false;
  }

  private writeFrame(frameType: number, streamId: number, data: Uint8Array): void {
    if (this.closed) {
      return;
    }
    const frame = Buffer.allocUnsafe(MULTIPLEX_HEADER_BYTES + data.byteLength);
    frame.writeUInt8(frameType, 0);
    frame.writeUInt32LE(streamId, 1);
    frame.writeUInt32LE(data.byteLength, 5);
    Buffer.from(data.buffer, data.byteOffset, data.byteLength).copy(frame, MULTIPLEX_HEADER_BYTES);
    if (this.socket.writableLength + frame.length > this.maxBufferedAmount) {
      this.fail(`multiplexed channel buffered output exceeds ${this.maxBufferedAmount} bytes`);
      return;
    }
    this.socket.write(frame);
  }

  private closeStream(streamId: number, code: number, reason: string): void {
    const connection = this.streams.get(streamId);
    if (!connection) {
      return;
    }
    this.streams.delete(streamId);
    this.writeFrame(MULTIPLEX_CLOSE, streamId, Buffer.alloc(0));
    connection.close(code, reason);
  }

  private fail(message: string): void {
    this.logger.error(message);
    this.socket.destroy(new Error(message));
  }

  private closeAll(code: number, reason: string): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const streams = Array.from(this.streams.values());
    this.streams.clear();
    streams.forEach((connection) => connection.close(code, reason));
    this.buffer = Buffer.alloc(0);
    this.onClosed();
  }
}

export class MultiplexElectronChannelHandler extends BaseCommonChannelHandler {
  private transport?: MultiplexChannelTransport;

  constructor(
    private readonly server: net.Server,
    protected commonChannelPathHandler: CommonChannelPathHandler,
    logger: ILogger = console,
    private readonly options: MultiplexChannelHandlerOptions = {},
  ) {
    super('multiplex-electron-channel-handler', commonChannelPathHandler, logger);
  }

  doHeartbeat(): void {
    // The public Gateway owns WebSocket ping/pong. This private transport is local and process-scoped.
  }

  listen(): void {
    this.logger.log('init multiplexed Common Channel Handler');
    this.server.on('connection', (socket: net.Socket) => {
      if (this.transport) {
        socket.destroy(new Error('multiplexed Gateway transport is already connected'));
        return;
      }
      const transport = new MultiplexChannelTransport(
        socket,
        (connection) => this.receiveConnection(connection),
        () => {
          if (this.transport === transport) {
            this.transport = undefined;
          }
        },
        this.logger,
        this.options.maxPayload ?? DEFAULT_MAX_PAYLOAD,
        this.options.maxBufferedAmount ?? DEFAULT_MAX_BUFFERED_AMOUNT,
      );
      this.transport = transport;
    });
  }

  override dispose(): void {
    this.transport?.close();
    this.transport = undefined;
    super.dispose();
  }
}
