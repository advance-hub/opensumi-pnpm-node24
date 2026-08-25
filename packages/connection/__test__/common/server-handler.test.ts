import { IConnectionShape } from '../../src/common/connection/types';
import { furySerializer } from '../../src/common/serializer';
import { BaseCommonChannelHandler, CommonChannelPathHandler } from '../../src/common/server-handler';

import type { ChannelMessage } from '../../src/common/channel/types';
import type { WSServerChannel } from '../../src/common/ws-channel';

class TestConnection implements IConnectionShape<Uint8Array> {
  private closeListeners: Array<() => void> = [];

  private messageListeners: Array<(message: Uint8Array) => void> = [];

  send() {}

  onMessage(listener: (message: Uint8Array) => void) {
    this.messageListeners.push(listener);
    return {
      dispose: () => {
        this.messageListeners = this.messageListeners.filter((candidate) => candidate !== listener);
      },
    };
  }

  onceClose(listener: () => void) {
    this.closeListeners.push(listener);
    return { dispose() {} };
  }

  close() {
    this.closeListeners.forEach((listener) => listener());
  }

  message(message: ChannelMessage) {
    const serialized = furySerializer.serialize(message);
    this.messageListeners.forEach((listener) => listener(serialized));
  }
}

class TestChannelHandler extends BaseCommonChannelHandler {
  heartbeats: IConnectionShape<Uint8Array>[] = [];

  constructor(pathHandler: CommonChannelPathHandler) {
    super('test-channel-handler', pathHandler, { log() {}, warn() {}, error() {} }, { heartbeatInterval: 1_000 });
  }

  doHeartbeat(connection: IConnectionShape<Uint8Array>): void {
    this.heartbeats.push(connection);
  }

  get channels(): WSServerChannel[] {
    return Array.from(this.channelMap.values());
  }
}

describe('CommonChannelPathHandler', () => {
  it('basic', () => {
    expect.hasAssertions();
    const handler = new CommonChannelPathHandler();

    let channelOpened = false;
    let channelOpenParams = {} as any;
    let channelDisposed = false;
    handler.register('test/:id', {
      handler(channel, connectionId, params) {
        channelOpened = true;
        channelOpenParams = params;
      },
      dispose() {
        channelDisposed = true;
      },
    });

    const result = handler.getAll();
    expect(result.length).toBe(1);
    expect(result[0].length).toBe(1);

    const params = handler.getParams('test', 'a');
    expect(params).toEqual({
      id: 'a',
    });

    handler.openChannel('test/artin', {} as any, 'test_client_id');
    expect(channelOpened).toBeTruthy();
    expect(channelOpenParams).toEqual({
      id: 'artin',
    });

    handler.disposeConnectionClientId({} as any, 'test_client_id');
    expect(channelDisposed).toBeTruthy();
  });

  it('heartbeats every active connection without replacing earlier connections', () => {
    expect.hasAssertions();
    jest.useFakeTimers();
    const handler = new TestChannelHandler(new CommonChannelPathHandler());
    const first = new TestConnection();
    const second = new TestConnection();

    try {
      handler.receiveConnection(first);
      handler.receiveConnection(second);
      jest.advanceTimersByTime(1_000);

      expect(handler.heartbeats).toEqual([first, second]);

      first.close();
      jest.advanceTimersByTime(1_000);
      expect(handler.heartbeats).toEqual([first, second, second]);

      second.close();
      jest.advanceTimersByTime(2_000);
      expect(handler.heartbeats).toHaveLength(3);
    } finally {
      handler.dispose();
      jest.useRealTimers();
    }
  });

  it('keeps a replacement channel when the old physical connection closes later', () => {
    expect.hasAssertions();
    const pathHandler = new CommonChannelPathHandler();
    const handler = new TestChannelHandler(pathHandler);
    const first = new TestConnection();
    const replacement = new TestConnection();
    const openedChannels: WSServerChannel[] = [];
    const disposedClientIds: string[] = [];

    pathHandler.register('RPCService', {
      handler: (channel) => openedChannels.push(channel as WSServerChannel),
      dispose: (_channel, clientId) => disposedClientIds.push(clientId),
    });

    try {
      handler.receiveConnection(first);
      first.message({
        kind: 'open',
        id: 'same-client:RPCService',
        path: 'RPCService',
        clientId: 'same-client',
        traceId: 'first',
      });

      handler.receiveConnection(replacement);
      replacement.message({
        kind: 'open',
        id: 'same-client:RPCService',
        path: 'RPCService',
        clientId: 'same-client',
        traceId: 'replacement',
      });

      expect(handler.channels).toEqual([openedChannels[1]]);
      first.close();
      expect(handler.channels).toEqual([openedChannels[1]]);
      expect(disposedClientIds).toEqual([]);

      replacement.close();
      expect(handler.channels).toHaveLength(0);
      expect(disposedClientIds).toEqual(['same-client']);
    } finally {
      handler.dispose();
    }
  });

  it('removes parameterized handlers without leaving a stale route entry', () => {
    expect.hasAssertions();
    const pathHandler = new CommonChannelPathHandler();
    const routeHandler = {
      handler() {},
      dispose() {},
    };
    pathHandler.register('test/:id', routeHandler);

    pathHandler.removeHandler('test/:id', routeHandler);

    expect(pathHandler.get('test')).toBeUndefined();
    expect(pathHandler.getAll()).toEqual([]);
  });
});
