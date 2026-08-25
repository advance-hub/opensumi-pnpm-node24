import http from 'http';

import ws from 'ws';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { Doc as YDoc, Map as YMap, YMapEvent, Text as YText, encodeStateAsUpdate } from 'yjs';

import { Autowired, Injectable } from '@opensumi/di';
import { IDisposable } from '@opensumi/ide-core-common';
import { AppConfig, INodeLogger } from '@opensumi/ide-core-node';
import { FileChangeType, IFileService } from '@opensumi/ide-file-service';
import { FileService } from '@opensumi/ide-file-service/lib/node';

import { DEFAULT_COLLABORATION_PORT, IYWebsocketServer, ROOM_NAME } from '../common';

// The package publishes a CommonJS `require` runtime entry but ESM declarations.
// Keep the boundary explicit until this framework package emits ESM.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const websocketServerUtils = require('@y/websocket-server/utils') as {
  docs: Map<string, YDoc>;
  getYDoc(roomName: string): YDoc;
  setupWSConnection(connection: ws.WebSocket, request: http.IncomingMessage, options: { docName: string }): void;
};
const { docs: serverDocs, getYDoc: getServerYDoc, setupWSConnection } = websocketServerUtils;

interface PendingContentRequest {
  cancelled: boolean;
  reject(reason: Error): void;
}

const DEFAULT_MAX_PAYLOAD = 2 * 1024 * 1024;
const DEFAULT_MAX_CONNECTIONS = 64;
const DEFAULT_MAX_BUFFERED_AMOUNT = 2 * 1024 * 1024;
const DEFAULT_MAX_DOCUMENTS = 128;
const DEFAULT_MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_STATE_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_PENDING_DOCUMENTS = 32;
const DEFAULT_IDLE_TIMEOUT = 60_000;
const PRESSURE_CHECK_INTERVAL = 10_000;

function positiveOrFallback(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

@Injectable()
export class YWebsocketServerImpl implements IYWebsocketServer {
  @Autowired(INodeLogger)
  private logger: INodeLogger;

  @Autowired(IFileService)
  private fileService: FileService;

  @Autowired(AppConfig)
  private appConfig: AppConfig;

  private yDoc: YDoc;

  private yMap: YMap<YText>;

  private websocketServer: ws.Server;

  private server: http.Server;

  private pendingContentRequests = new Map<string, Set<PendingContentRequest>>();

  private contentReferences = new Map<string, number>();

  private pressureCheckTimer: NodeJS.Timeout | undefined;

  private idleCleanupTimer: NodeJS.Timeout | undefined;

  private fileChangeDisposable: IDisposable | undefined;

  private yMapObserver: ((event: YMapEvent<YText>) => void) | undefined;

  private yDocUpdateObserver: ((update: Uint8Array) => void) | undefined;

  private accumulatedUpdateBytes = 0;

  private documentPressureExceeded = false;

  initialize() {
    this.logger.debug('init y-websocket server');

    this.server = http.createServer((req, res) => {
      res.writeHead(200);
      res.end('hello');
    });
    this.server.on('error', (error) => {
      this.logger.error('[Collaboration] HTTP server error', error);
    });

    const collaborationOptions = this.appConfig.collaborationOptions;
    this.websocketServer = new ws.Server({
      noServer: true,
      clientTracking: true,
      maxPayload: positiveOrFallback(collaborationOptions?.maxPayload, DEFAULT_MAX_PAYLOAD),
      perMessageDeflate: false,
    });

    this.websocketServer.on('error', (error) => {
      this.logger.error('[Collaboration] websocket server error', error);
    });
    this.websocketServer.on('connection', (connection, request) => {
      if (this.idleCleanupTimer) {
        clearTimeout(this.idleCleanupTimer);
        this.idleCleanupTimer = undefined;
      }
      connection.on('error', (error) => {
        this.logger.warn('[Collaboration] websocket connection error', error);
      });
      connection.on('close', () => this.scheduleIdleCleanup(this.documentPressureExceeded ? 0 : undefined));
      setupWSConnection(connection, request, { docName: ROOM_NAME });
    });

    this.server.on('upgrade', (req, socket, head) => {
      const requestUrl = new URL(req.url || '/', 'ws://localhost');
      const room = decodeURIComponent(requestUrl.pathname.replace(/^\/+/, ''));
      if (room !== ROOM_NAME) {
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        socket.destroy();
        return;
      }

      if (collaborationOptions?.shouldAcceptConnection && !collaborationOptions.shouldAcceptConnection()) {
        socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        socket.destroy();
        return;
      }

      const maxConnections = positiveOrFallback(collaborationOptions?.maxConnections, DEFAULT_MAX_CONNECTIONS);
      if (this.websocketServer.clients.size >= maxConnections) {
        socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        socket.destroy();
        return;
      }

      const handleAuth = (ws) => {
        this.websocketServer.emit('connection', ws, req);
      };
      try {
        this.websocketServer.handleUpgrade(req, socket, head, handleAuth);
      } catch (error) {
        this.logger.error('[Collaboration] websocket upgrade failed', error);
        socket.destroy();
      }
    });

    const maxBufferedAmount = positiveOrFallback(collaborationOptions?.maxBufferedAmount, DEFAULT_MAX_BUFFERED_AMOUNT);
    this.pressureCheckTimer = setInterval(() => {
      this.websocketServer.clients.forEach((connection) => {
        if (connection.bufferedAmount > maxBufferedAmount) {
          this.logger.warn(`[Collaboration] terminate slow client with ${connection.bufferedAmount} buffered bytes`);
          connection.terminate();
        }
      });
      this.checkDocumentPressure();
    }, PRESSURE_CHECK_INTERVAL);
    this.pressureCheckTimer.unref?.();

    const listenPort = positiveOrFallback(collaborationOptions?.port, DEFAULT_COLLABORATION_PORT);

    // Initialize the shared document before accepting the first connection.
    this.attachSharedDocument();

    this.server.listen(listenPort, () => {
      this.logger.log(`y-websocket server listening on port ${listenPort}`);
    });

    this.fileChangeDisposable = this.fileService.onFilesChanged((e) => {
      e.changes
        .filter((e) => e.type === FileChangeType.DELETED)
        .forEach((e) => {
          if (e.type === FileChangeType.DELETED) {
            this.logger.debug('on file event deleted', e);
            this.removeYText(e.uri);
            this.logger.debug('removed YText of', e.uri);
          }
        });

      e.changes
        .filter((e) => e.type === FileChangeType.ADDED)
        .forEach((e) => {
          this.logger.debug('on file event added', e);
          void this.requestInitContent(e.uri).catch((error) => {
            this.logger.debug('[Collaboration] file initialization was cancelled', e.uri, error);
          });
        });
    });
  }

  private attachSharedDocument() {
    this.yDoc = this.getYDoc(ROOM_NAME);
    this.yMap = this.yDoc.getMap();
    this.yMapObserver = (event) => {
      event.changes.keys.forEach((change, key) => {
        this.logger.debug(`[Collaboration] operation ${change.action} occurs on key ${key}`);
      });
    };
    this.yDocUpdateObserver = (update) => {
      this.accumulatedUpdateBytes += update.byteLength;
    };
    this.yMap.observe(this.yMapObserver);
    this.yDoc.on('update', this.yDocUpdateObserver);
  }

  private detachSharedDocument() {
    if (this.yMapObserver) {
      this.yMap.unobserve(this.yMapObserver);
      this.yMapObserver = undefined;
    }
    if (this.yDocUpdateObserver) {
      this.yDoc.off('update', this.yDocUpdateObserver);
      this.yDocUpdateObserver = undefined;
    }
  }

  private cancelPendingContentRequests(reason: string) {
    this.pendingContentRequests.forEach((requests, uri) => {
      requests.forEach((request) => {
        request.cancelled = true;
        request.reject(new Error(`${reason}: ${uri}`));
      });
    });
    this.pendingContentRequests.clear();
  }

  private resetSharedDocument() {
    for (const uri of Array.from(this.yMap.keys())) {
      this.removeYText(uri);
    }
    this.cancelPendingContentRequests('Collaboration document was reset while loading content');
    this.contentReferences.clear();
    this.detachSharedDocument();
    serverDocs.delete(ROOM_NAME);
    this.yDoc.destroy();
    this.accumulatedUpdateBytes = 0;
    this.documentPressureExceeded = false;
    this.attachSharedDocument();
  }

  private checkDocumentPressure() {
    const maxStateBytes = positiveOrFallback(
      this.appConfig.collaborationOptions?.maxStateBytes,
      DEFAULT_MAX_STATE_BYTES,
    );
    if (this.accumulatedUpdateBytes <= maxStateBytes) {
      return;
    }

    const stateBytes = encodeStateAsUpdate(this.yDoc).byteLength;
    this.accumulatedUpdateBytes = stateBytes;
    if (stateBytes <= maxStateBytes) {
      return;
    }

    this.documentPressureExceeded = true;
    this.logger.error(
      `[Collaboration] shared state reached ${stateBytes} bytes; terminating clients and resetting the room`,
    );
    this.websocketServer.clients.forEach((connection) => connection.terminate());
    this.scheduleIdleCleanup(0);
  }

  removeYText(uri: string) {
    this.logger.debug('trying to remove uri', uri);
    this.contentReferences.delete(uri);

    // break all still-awaiting promise
    const pendingRequests = this.pendingContentRequests.get(uri);
    if (pendingRequests) {
      this.pendingContentRequests.delete(uri);
      pendingRequests.forEach((pendingRequest) => {
        pendingRequest.cancelled = true;
        pendingRequest.reject(new Error(`File was removed while loading collaboration content: ${uri}`));
      });
      pendingRequests.clear();
    }

    if (this.yMap.has(uri)) {
      this.yMap.delete(uri);
      this.logger.debug('removed', uri);
    }
  }

  private async doRequestInitContent(uri: string, pendingRequest: PendingContentRequest): Promise<void> {
    try {
      if (this.yMap.has(uri)) {
        return;
      }
      // load content from disk, not client
      const { content } = await this.fileService.resolveContent(uri);
      const maxDocumentBytes = positiveOrFallback(
        this.appConfig.collaborationOptions?.maxDocumentBytes,
        DEFAULT_MAX_DOCUMENT_BYTES,
      );
      const contentBytes = Buffer.byteLength(content, 'utf8');
      if (contentBytes > maxDocumentBytes) {
        throw new Error(
          `Collaboration document is ${contentBytes} bytes, exceeding the ${maxDocumentBytes}-byte limit: ${uri}`,
        );
      }
      this.logger.debug('resolved content', content.substring(0, 20), 'from', uri);
      if (!pendingRequest.cancelled && !this.yMap.has(uri)) {
        const yText = new YText(content); // create yText with initial content
        this.yMap.set(uri, yText);
      }
    } catch (e) {
      this.logger.error(e);
      throw e;
    }
  }

  async requestInitContent(uri: string): Promise<void> {
    let requestsForUri = this.pendingContentRequests.get(uri);
    if (!requestsForUri) {
      const maxDocuments = positiveOrFallback(this.appConfig.collaborationOptions?.maxDocuments, DEFAULT_MAX_DOCUMENTS);
      if (!this.yMap.has(uri) && this.yMap.size >= maxDocuments) {
        throw new Error(`Collaboration document limit (${maxDocuments}) reached`);
      }
      const maxPendingDocuments = positiveOrFallback(
        this.appConfig.collaborationOptions?.maxPendingDocuments,
        DEFAULT_MAX_PENDING_DOCUMENTS,
      );
      if (this.pendingContentRequests.size >= maxPendingDocuments) {
        throw new Error(`Collaboration pending document limit (${maxPendingDocuments}) reached`);
      }
      requestsForUri = new Set();
      this.pendingContentRequests.set(uri, requestsForUri);
    }

    let pendingRequest!: PendingContentRequest;
    const promise = new Promise<void>((resolve, reject) => {
      pendingRequest = { cancelled: false, reject };
      requestsForUri.add(pendingRequest);
      void this.doRequestInitContent(uri, pendingRequest).then(resolve, reject);
    });

    try {
      await promise;
      if (!pendingRequest.cancelled && this.yMap.has(uri)) {
        this.contentReferences.set(uri, (this.contentReferences.get(uri) || 0) + 1);
      }
    } finally {
      requestsForUri.delete(pendingRequest!);
      if (requestsForUri.size === 0 && this.pendingContentRequests.get(uri) === requestsForUri) {
        this.pendingContentRequests.delete(uri);
      }
    }
  }

  releaseContent(uri: string): void {
    const references = this.contentReferences.get(uri);
    if (!references) {
      return;
    }
    if (references > 1) {
      this.contentReferences.set(uri, references - 1);
      return;
    }
    this.removeYText(uri);
  }

  private scheduleIdleCleanup(delay?: number): void {
    if (this.idleCleanupTimer) {
      clearTimeout(this.idleCleanupTimer);
    }
    const idleTimeout =
      delay ?? positiveOrFallback(this.appConfig.collaborationOptions?.idleTimeout, DEFAULT_IDLE_TIMEOUT);
    this.idleCleanupTimer = setTimeout(() => {
      this.idleCleanupTimer = undefined;
      if (this.websocketServer.clients.size === 0) {
        this.resetSharedDocument();
      }
    }, idleTimeout);
    this.idleCleanupTimer.unref?.();
  }

  destroy() {
    if (this.pressureCheckTimer) {
      clearInterval(this.pressureCheckTimer);
      this.pressureCheckTimer = undefined;
    }
    if (this.idleCleanupTimer) {
      clearTimeout(this.idleCleanupTimer);
      this.idleCleanupTimer = undefined;
    }
    this.fileChangeDisposable?.dispose();
    this.fileChangeDisposable = undefined;
    this.cancelPendingContentRequests('Collaboration server stopped while loading content');
    this.contentReferences.clear();
    this.websocketServer.clients.forEach((connection) => connection.terminate());
    this.websocketServer.close();
    this.server.close();
    this.detachSharedDocument();
    serverDocs.delete(ROOM_NAME);
    this.yDoc.destroy();
  }

  getYDoc(room: string): YDoc {
    return getServerYDoc(room);
  }
}
