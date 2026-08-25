import { MatchFunction, match } from 'path-to-regexp';
import WS from 'ws';

import { ILogger } from '../common';
import { WSWebSocketConnection } from '../common/connection';
import { BaseCommonChannelHandler, CommonChannelPathHandler } from '../common/server-handler';

import { CommonChannelHandlerOptions, WebSocketHandler } from './ws';

export interface WebSocketConnection extends WS {
  isAlive: boolean;
  routeParam: {
    pathname: string;
  };
}

const DEFAULT_MAX_PAYLOAD = 32 * 1024 * 1024;
const DEFAULT_MAX_CONNECTIONS = 1_000;
const DEFAULT_MAX_BUFFERED_AMOUNT = 16 * 1024 * 1024;

/**
 * Channel Handler for nodejs
 */
export class CommonChannelHandler extends BaseCommonChannelHandler implements WebSocketHandler {
  private wsServer: WS.Server;
  protected handlerRoute: MatchFunction;

  constructor(
    routePath: string,
    protected commonChannelPathHandler: CommonChannelPathHandler,
    logger: ILogger = console,
    private options: CommonChannelHandlerOptions = {},
  ) {
    super('node-channel-handler', commonChannelPathHandler, logger, {
      heartbeatInterval: options.heartbeatInterval,
    });
    this.handlerRoute = match(routePath, options.pathMatchOptions);
    this.initWSServer();
  }

  doHeartbeat(connection: WSWebSocketConnection): void {
    const socket = connection.socket as WebSocketConnection;
    if (socket.readyState !== WS.OPEN) {
      return;
    }

    const maxBufferedAmount = this.options.maxBufferedAmount ?? DEFAULT_MAX_BUFFERED_AMOUNT;
    if (socket.bufferedAmount > maxBufferedAmount) {
      this.logger.warn(`terminate slow websocket client with ${socket.bufferedAmount} buffered bytes`);
      socket.terminate();
      return;
    }

    if (!socket.isAlive) {
      this.logger.warn('terminate unresponsive websocket client');
      socket.terminate();
      return;
    }

    socket.isAlive = false;
    socket.ping();
  }

  private initWSServer() {
    this.logger.log('init common channel handler');
    this.wsServer = new WS.Server({
      maxPayload: DEFAULT_MAX_PAYLOAD,
      perMessageDeflate: false,
      ...this.options.wsServerOptions,
      noServer: true,
    });
    this.wsServer.on('error', (error) => {
      this.logger.error('websocket server error', error);
    });
    this.wsServer.on('connection', (connection: WebSocketConnection) => {
      connection.isAlive = true;
      connection.on('pong', () => {
        connection.isAlive = true;
      });
      connection.on('error', (error) => {
        this.logger.warn('websocket connection error', error);
      });
      const wsConnection = new WSWebSocketConnection(connection, {
        maxBufferedAmount: this.options.maxBufferedAmount ?? DEFAULT_MAX_BUFFERED_AMOUNT,
        onBackpressure: (bufferedAmount, messageSize) => {
          this.logger.warn(
            `terminate slow websocket client before buffering ${messageSize} bytes with ${bufferedAmount} bytes pending`,
          );
        },
        onSendError: (error) => {
          this.logger.warn('websocket send failed', error);
        },
      });
      this.receiveConnection(wsConnection);
    });
  }

  public handleUpgrade(pathname: string, request: any, socket: any, head: any): boolean {
    const routeResult = this.handlerRoute(pathname);

    if (routeResult) {
      if (this.options.shouldAcceptConnection && !this.options.shouldAcceptConnection()) {
        socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        socket.destroy();
        return true;
      }

      const maxConnections = this.options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
      if (this.wsServer.clients.size >= maxConnections) {
        socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        socket.destroy();
        return true;
      }

      try {
        this.wsServer.handleUpgrade(request, socket, head, (connection) => {
          (connection as WebSocketConnection).routeParam = {
            pathname,
          };

          this.wsServer.emit('connection', connection, request);
        });
      } catch (error) {
        this.logger.error('websocket upgrade failed', error);
        socket.destroy();
      }
      return true;
    }

    return false;
  }

  override dispose() {
    super.dispose();
    this.wsServer.clients.forEach((connection) => connection.terminate());
    this.wsServer.close();
  }
}
