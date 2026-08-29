import net from 'net';

import { Deferred, IDisposable } from '@opensumi/ide-core-common';

// eslint-disable-next-line import-x/no-restricted-paths
import { WSChannelHandler } from '../../src/browser';
import { IRuntimeSocketConnection } from '../../src/common/connection';
import { CommonChannelPathHandler } from '../../src/common/server-handler';
import { MultiplexElectronChannelHandler } from '../../src/electron';

const preface = Buffer.from('OMUX1\n');
const headerBytes = 9;
const openFrame = 1;
const dataFrame = 2;
const closeFrame = 3;

class TestMultiplexConnection implements IRuntimeSocketConnection<Uint8Array> {
  private readonly messageListeners = new Set<(data: Uint8Array) => void>();
  private readonly closeListeners = new Set<(code?: number, reason?: string) => void>();
  private readonly openListeners = new Set<() => void>();
  private open = true;

  constructor(
    readonly streamId: number,
    private readonly transport: TestMultiplexTransport,
  ) {}

  send(data: Uint8Array): void {
    this.transport.writeFrame(dataFrame, this.streamId, data);
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

  onOpen(cb: () => void): IDisposable {
    this.openListeners.add(cb);
    return { dispose: () => this.openListeners.delete(cb) };
  }

  onClose(cb: (code?: number, reason?: string) => void): IDisposable {
    this.closeListeners.add(cb);
    return { dispose: () => this.closeListeners.delete(cb) };
  }

  isOpen(): boolean {
    return this.open;
  }

  destroy(): void {
    if (!this.open) {
      return;
    }
    this.transport.writeFrame(closeFrame, this.streamId, Buffer.alloc(0));
    this.acceptClose();
  }

  dispose(): void {
    this.destroy();
  }

  acceptData(data: Uint8Array): void {
    this.messageListeners.forEach((listener) => listener(data));
  }

  acceptClose(code = 0, reason = ''): void {
    if (!this.open) {
      return;
    }
    this.open = false;
    const listeners = Array.from(this.closeListeners);
    this.closeListeners.clear();
    this.messageListeners.clear();
    this.openListeners.clear();
    listeners.forEach((listener) => listener(code, reason));
  }
}

class TestMultiplexTransport {
  private buffer: Buffer = Buffer.alloc(0);
  private nextStreamId = 0;
  private readonly streams = new Map<number, TestMultiplexConnection>();

  constructor(readonly socket: net.Socket) {
    socket.on('data', (chunk) => this.accept(chunk));
    socket.once('close', () => {
      this.streams.forEach((stream) => stream.acceptClose(1, 'physical transport closed'));
      this.streams.clear();
    });
  }

  open(): TestMultiplexConnection {
    const stream = new TestMultiplexConnection(++this.nextStreamId, this);
    this.streams.set(stream.streamId, stream);
    this.writeFrame(openFrame, stream.streamId, Buffer.alloc(0));
    return stream;
  }

  writeFrame(frameType: number, streamId: number, data: Uint8Array): void {
    const frame = Buffer.allocUnsafe(headerBytes + data.byteLength);
    frame.writeUInt8(frameType, 0);
    frame.writeUInt32LE(streamId, 1);
    frame.writeUInt32LE(data.byteLength, 5);
    Buffer.from(data.buffer, data.byteOffset, data.byteLength).copy(frame, headerBytes);
    this.socket.write(frame);
  }

  private accept(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= headerBytes) {
      const frameType = this.buffer.readUInt8(0);
      const streamId = this.buffer.readUInt32LE(1);
      const payloadLength = this.buffer.readUInt32LE(5);
      const frameLength = headerBytes + payloadLength;
      if (this.buffer.length < frameLength) {
        return;
      }
      const payload = this.buffer.subarray(headerBytes, frameLength);
      this.buffer = this.buffer.subarray(frameLength);
      const stream = this.streams.get(streamId);
      if (!stream) {
        throw new Error(`response for unknown stream ${streamId}`);
      }
      if (frameType === dataFrame) {
        stream.acceptData(payload);
      } else if (frameType === closeFrame) {
        this.streams.delete(streamId);
        stream.acceptClose();
      } else {
        throw new Error(`unexpected response frame type ${frameType}`);
      }
    }
  }
}

function listen(server: net.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('server did not announce a TCP address'));
        return;
      }
      resolve(address.port);
    });
  });
}

function connect(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

describe('multiplex channel handler', () => {
  it('keeps two logical RPC connections isolated on one physical socket', async () => {
    const server = net.createServer();
    let physicalConnections = 0;
    server.on('connection', () => physicalConnections++);
    const port = await listen(server);
    const paths = new CommonChannelPathHandler();
    const logger = { log() {}, warn() {}, error() {} };
    const nodeHandler = new MultiplexElectronChannelHandler(server, paths, logger);
    nodeHandler.listen();
    paths.register('echo', {
      handler(channel, clientId) {
        channel.onMessage((message) => channel.send(`${clientId}:${message}`));
      },
      dispose() {},
    });

    const socket = await connect(port);
    socket.write(preface.subarray(0, 2));
    socket.write(preface.subarray(2));
    const transport = new TestMultiplexTransport(socket);
    const firstConnection = transport.open();
    const secondConnection = transport.open();
    const firstHandler = new WSChannelHandler(firstConnection, 'first-client', { logger });
    const secondHandler = new WSChannelHandler(secondConnection, 'second-client', { logger });
    await Promise.all([firstHandler.initHandler(), secondHandler.initHandler()]);
    const [firstChannel, secondChannel] = await Promise.all([
      firstHandler.openChannel('echo'),
      secondHandler.openChannel('echo'),
    ]);

    const firstResponse = new Deferred<string>();
    const secondResponse = new Deferred<string>();
    firstChannel.onMessage((message) => firstResponse.resolve(message));
    secondChannel.onMessage((message) => secondResponse.resolve(message));
    firstChannel.send('one');
    secondChannel.send('two');
    await expect(Promise.all([firstResponse.promise, secondResponse.promise])).resolves.toEqual([
      'first-client:one',
      'second-client:two',
    ]);
    expect(physicalConnections).toBe(1);

    firstConnection.destroy();
    const stillOpenResponse = new Deferred<string>();
    secondChannel.onMessage((message) => stillOpenResponse.resolve(message));
    secondChannel.send('still-open');
    await expect(stillOpenResponse.promise).resolves.toBe('second-client:still-open');

    firstHandler.dispose();
    secondHandler.dispose();
    secondConnection.destroy();
    socket.destroy();
    nodeHandler.dispose();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });
});
