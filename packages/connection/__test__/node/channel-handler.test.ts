import net from 'net';

import { NetSocketConnection } from '@opensumi/ide-connection/lib/common/connection';
import { ElectronChannelHandler } from '@opensumi/ide-connection/lib/electron';
import { Deferred } from '@opensumi/ide-core-common';
import { normalizedIpcHandlerPathAsync } from '@opensumi/ide-core-common/src/utils/ipc';

// eslint-disable-next-line import-x/no-restricted-paths
import { WSChannelHandler } from '../../src/browser';
import { CommonChannelPathHandler } from '../../src/common/server-handler';

const commonChannelPathHandler = new CommonChannelPathHandler();

const clientId = 'test-client-id';

describe('channel handler', () => {
  it('can handle websocket channel', async () => {
    expect.assertions(2);

    const server = new net.Server();
    const ipcPath = await normalizedIpcHandlerPathAsync('test', true);
    server.listen(ipcPath);

    const logger = { log() {}, warn() {}, error() {} };
    const nodeChannelHandler = new ElectronChannelHandler(server, commonChannelPathHandler, logger);
    nodeChannelHandler.listen();

    commonChannelPathHandler.register('test', {
      handler(channel) {
        channel.onMessage((msg) => {
          if (msg === 'hello') {
            channel.send('world');
          }
        });
      },
      dispose() {},
    });

    commonChannelPathHandler.register('test2', {
      handler(channel) {
        channel.onMessage((msg) => {
          if (msg === 'ping') {
            channel.send('pong');
          }
        });
      },
      dispose() {},
    });

    const socket = new net.Socket();
    socket.connect(ipcPath);
    const connection = new NetSocketConnection(socket);
    const browserChannel = new WSChannelHandler(connection, clientId, { logger });

    await browserChannel.initHandler();

    const testChannel = await browserChannel.openChannel('test');
    const testChannel2 = await browserChannel.openChannel('test2');

    const deferred = new Deferred<void>();

    testChannel.onMessage((msg) => {
      expect(msg).toBe('world');
      deferred.resolve();
    });
    testChannel.send('hello');

    const deferred2 = new Deferred<void>();
    testChannel2.onMessage((msg) => {
      expect(msg).toBe('pong');
      deferred2.resolve();
    });
    testChannel2.send('ping');

    await deferred.promise;
    await deferred2.promise;

    browserChannel.dispose();
    const socketClosed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    connection.destroy();
    await socketClosed;
    connection.dispose();
    nodeChannelHandler.dispose();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
});
