import assert from 'assert';
import http from 'http';

import ws from 'ws';

export abstract class WebSocketHandler {
  abstract handlerId: string;
  abstract handleUpgrade(pathname: string, request: any, socket: any, head: any): boolean;
  init?(): void;
  dispose?(): void;
}

export interface CommonChannelHandlerOptions {
  wsServerOptions?: ws.ServerOptions;
  heartbeatInterval?: number;
  maxConnections?: number;
  maxBufferedAmount?: number;
  shouldAcceptConnection?: () => boolean;
  pathMatchOptions?: {
    // When true the regexp will match to the end of the string.
    end?: boolean;
  };
}

export class WebSocketServerRoute {
  public server: http.Server;
  public port?: number;
  private wsServerHandlerArr: WebSocketHandler[];

  private upgradeListener: ((request: http.IncomingMessage, socket: any, head: Buffer) => void) | undefined;

  private disposed = false;

  constructor(
    server: http.Server,
    private logger: any = console,
    port = 8729,
    wsServerHandlerArr: WebSocketHandler[] = [],
  ) {
    if (server) {
      this.server = server as http.Server;
    }

    this.port = port;
    this.wsServerHandlerArr = wsServerHandlerArr;
  }

  public registerHandler(handler: WebSocketHandler) {
    const wsServerHandlerArr = this.wsServerHandlerArr;
    const findHandler = (h: WebSocketHandler) => h.handlerId === handler!.handlerId;

    if (wsServerHandlerArr.findIndex(findHandler) === -1) {
      this.wsServerHandlerArr.push(handler);
    }
  }

  public deleteHandler(handler: WebSocketHandler | string) {
    let handlerId: string;
    if ((handler as WebSocketHandler).handlerId) {
      handlerId = (handler as WebSocketHandler).handlerId;
    } else {
      handlerId = handler as string;
    }

    const handlerIndex = this.wsServerHandlerArr.findIndex((handler) => handler.handlerId === handlerId);

    if (handlerIndex !== -1) {
      const [removedHandler] = this.wsServerHandlerArr.splice(handlerIndex, 1);
      removedHandler.dispose?.();
      return true;
    } else {
      return false;
    }
  }

  public init() {
    this.initServer();
    this.initHandler();
    this.handleUpgrade();
  }
  private initServer() {
    if (!this.server) {
      this.server = http.createServer();
      this.server.listen(this.port, () => {
        this.logger.log(`websocket server listen on ${this.port}`);
      });
    }
  }
  private initHandler() {
    this.wsServerHandlerArr.forEach((handler) => {
      if (handler.init) {
        handler.init.call(handler);
      }
    });
  }
  private handleUpgrade() {
    if (this.upgradeListener) {
      return;
    }
    const server = this.server;
    const wsServerHandlerArr = this.wsServerHandlerArr;

    this.upgradeListener = (request, socket, head) => {
      assert(request.url, 'cannot parse url from http request');

      // request.url: `/path?query=a#hash`
      const url = new URL(request.url, 'wss://base');
      const wsPathname: string = url.pathname;

      let wsHandlerIndex = 0;
      const wsHandlerLength = wsServerHandlerArr.length;

      for (; wsHandlerIndex < wsHandlerLength; wsHandlerIndex++) {
        const handler = wsServerHandlerArr[wsHandlerIndex];
        const handleResult = handler.handleUpgrade(wsPathname, request, socket, head);
        if (handleResult) {
          break;
        }
      }

      if (wsHandlerIndex === wsHandlerLength) {
        this.logger.error(`request.url ${request.url} mismatch!`);
        socket.destroy();
      }
    };
    server.on('upgrade', this.upgradeListener);
    server.once('close', () => this.dispose());
  }

  public dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.upgradeListener) {
      this.server.off('upgrade', this.upgradeListener);
      this.upgradeListener = undefined;
    }
    this.wsServerHandlerArr.splice(0).forEach((handler) => handler.dispose?.());
  }
}
