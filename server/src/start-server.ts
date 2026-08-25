import { mkdir } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

import KoaRouter from '@koa/router';
import Koa from 'koa';
import serveStatic from 'koa-static';

import { Injector } from '@opensumi/di';
import { ModuleConstructor, ServerApp } from '@opensumi/ide-core-node';
import {
  IExternalFileArgs,
  IExternalUrlArgs,
  IRemoteOpenerClient,
  RemoteOpenerClientToken,
  RemoteOpenerServiceToken,
} from '@opensumi/ide-remote-opener/lib/common';
import { RemoteOpenerServiceImpl } from '@opensumi/ide-remote-opener/lib/node';

export interface StartServerOptions {
  modules: ModuleConstructor[];
  injector: Injector;
  mountStaticPath?: string;
}

interface MemoryStatus {
  ready: boolean;
  limits: {
    heapUsedBytes: number;
    rssBytes: number;
  };
  memory: NodeJS.MemoryUsage;
}

function readPositiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function getMemoryStatus(): MemoryStatus {
  const memory = process.memoryUsage();
  const limits = {
    heapUsedBytes: readPositiveInteger('SERVER_MAX_HEAP_USED_MB', 448) * 1024 * 1024,
    rssBytes: readPositiveInteger('SERVER_MAX_RSS_MB', 768) * 1024 * 1024,
  };
  return {
    ready: memory.heapUsed < limits.heapUsedBytes && memory.rss < limits.rssBytes,
    limits,
    memory,
  };
}

export async function startServer({ modules, injector, mountStaticPath }: StartServerOptions): Promise<http.Server> {
  const app = new Koa();
  const router = new KoaRouter();
  const rootDirectory = path.resolve(__dirname, '../..');
  const extensionDirectory = path.join(rootDirectory, 'tools/extensions');
  const extensionLogService = path.join(
    __dirname,
    path.extname(__filename) === '.ts' ? 'mock-log-service.ts' : 'mock-log-service.js',
  );

  // A fresh clone has no downloaded extensions yet. Keep the directory
  // present so the extension scanner starts quietly before the first install.
  await mkdir(extensionDirectory, { recursive: true });

  injector.addProviders({
    token: RemoteOpenerServiceToken,
    useClass: RemoteOpenerServiceImpl,
  });

  router.get('/open', (context) => {
    const openerService: IRemoteOpenerClient = injector.get(RemoteOpenerClientToken);
    try {
      openerService.openExternal(
        context.query as unknown as IExternalFileArgs | IExternalUrlArgs,
        context.query.clientId as unknown as string,
      );
      context.body = 'successful';
    } catch (error) {
      context.status = 500;
      context.body = `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
  });

  router.get('/', (context) => {
    context.body = 'OpenSumi';
  });

  router.get('/healthz', (context) => {
    context.body = {
      status: 'ok',
      uptimeSeconds: process.uptime(),
      ...getMemoryStatus(),
    };
  });

  router.get('/readyz', (context) => {
    const status = getMemoryStatus();
    context.status = status.ready ? 200 : 503;
    context.body = {
      status: status.ready ? 'ready' : 'memory-pressure',
      ...status,
    };
  });

  app.use(
    serveStatic(mountStaticPath || path.join(rootDirectory, 'client/dist'), {
      maxage: 30 * 24 * 60 * 60 * 1000,
    }),
  );
  app.use(router.routes());

  const serverApp = new ServerApp({
    injector,
    modules,
    use: app.use.bind(app),
    webSocketHandler: [],
    marketplace: { showBuiltinExtensions: true },
    processCloseExitThreshold: readPositiveInteger('EXTENSION_HOST_IDLE_TIMEOUT', 60_000),
    terminalPtyCloseThreshold: readPositiveInteger('TERMINAL_IDLE_TIMEOUT', 30_000),
    maxExtProcessCount: readPositiveInteger('MAX_EXTENSION_HOSTS', 2),
    extensionHostShutdownTimeout: readPositiveInteger('EXTENSION_HOST_SHUTDOWN_TIMEOUT', 2_000),
    extHostForkOptions: {
      execArgv: [`--max-old-space-size=${readPositiveInteger('EXTENSION_HOST_MAX_OLD_SPACE_SIZE', 512)}`],
    },
    watcherHostForkOptions: {
      execArgv: [`--max-old-space-size=${readPositiveInteger('WATCHER_HOST_MAX_OLD_SPACE_SIZE', 256)}`],
    },
    wsHeartbeatInterval: readPositiveInteger('WS_HEARTBEAT_INTERVAL', 30_000),
    wsMaxConnections: readPositiveInteger('WS_MAX_CONNECTIONS', 512),
    wsMaxBufferedAmount: readPositiveInteger('WS_MAX_BUFFERED_AMOUNT', 16 * 1024 * 1024),
    wsShouldAcceptConnection: () => getMemoryStatus().ready,
    wsServerOptions: {
      maxPayload: readPositiveInteger('WS_MAX_PAYLOAD', 32 * 1024 * 1024),
      perMessageDeflate: false,
    },
    collaborationOptions: {
      port: readPositiveInteger('COLLABORATION_PORT', 12_345),
      maxPayload: readPositiveInteger('COLLABORATION_MAX_PAYLOAD', 2 * 1024 * 1024),
      maxConnections: readPositiveInteger('COLLABORATION_MAX_CONNECTIONS', 64),
      maxBufferedAmount: readPositiveInteger('COLLABORATION_MAX_BUFFERED_AMOUNT', 2 * 1024 * 1024),
      maxDocuments: readPositiveInteger('COLLABORATION_MAX_DOCUMENTS', 128),
      maxDocumentBytes: readPositiveInteger('COLLABORATION_MAX_DOCUMENT_BYTES', 2 * 1024 * 1024),
      maxStateBytes: readPositiveInteger('COLLABORATION_MAX_STATE_BYTES', 32 * 1024 * 1024),
      maxPendingDocuments: readPositiveInteger('COLLABORATION_MAX_PENDING_DOCUMENTS', 32),
      idleTimeout: readPositiveInteger('COLLABORATION_IDLE_TIMEOUT', 60_000),
      shouldAcceptConnection: () => getMemoryStatus().ready,
    },
    staticAllowOrigin: '*',
    staticAllowPath: [path.join(rootDirectory, 'packages/extension'), extensionDirectory, '/'],
    // Node 24 can load erasable TypeScript directly during `tsx` development;
    // production continues to use the JavaScript emitted into server/dist.
    extLogServiceClassPath: extensionLogService,
    extHost:
      process.env.EXTENSION_HOST_ENTRY || path.join(rootDirectory, 'packages/extension/lib/hosted/ext.process.js'),
    watcherHost:
      process.env.WATCHER_HOST_ENTRY ||
      path.join(rootDirectory, 'packages/file-service/lib/node/hosted/watcher.process.js'),
    onDidCreateExtensionHostProcess: (extensionHostProcess) => {
      // eslint-disable-next-line no-console
      console.log(`Extension host process ${extensionHostProcess.pid} created`);
    },
  });

  const server = http.createServer(
    {
      headersTimeout: readPositiveInteger('HTTP_HEADERS_TIMEOUT', 15_000),
      keepAliveTimeout: readPositiveInteger('HTTP_KEEP_ALIVE_TIMEOUT', 5_000),
      maxHeaderSize: readPositiveInteger('HTTP_MAX_HEADER_SIZE', 16 * 1024),
      requestTimeout: readPositiveInteger('HTTP_REQUEST_TIMEOUT', 30_000),
    },
    app.callback(),
  );
  server.maxConnections = readPositiveInteger('HTTP_MAX_CONNECTIONS', 512);
  server.maxHeadersCount = readPositiveInteger('HTTP_MAX_HEADERS_COUNT', 100);
  server.maxRequestsPerSocket = readPositiveInteger('HTTP_MAX_REQUESTS_PER_SOCKET', 1_000);
  await serverApp.start(server);

  const port = Number(process.env.PORT || process.env.IDE_SERVER_PORT || 8000);
  return new Promise<http.Server>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      server.off('error', reject);
      // eslint-disable-next-line no-console
      console.log(`server listen on http://localhost:${port}`);
      resolve(server);
    });
  });
}
