import { mkdir } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

import KoaRouter from '@koa/router';
import Koa from 'koa';
import serveStatic from 'koa-static';

import { Injector } from '@opensumi/di';
import { ExtensionHostRuntimeStatus, ModuleConstructor, ServerApp } from '@opensumi/ide-core-node';
import {
  WorkspaceAgentClient,
  WorkspaceAgentClientToken,
  WorkspaceAgentMode,
  WorkspaceAgentRuntimeStatus,
  parseWorkspaceAgentMode,
} from '@opensumi/ide-file-service/lib/node/workspace-agent';
import {
  IExternalFileArgs,
  IExternalUrlArgs,
  IRemoteOpenerClient,
  RemoteOpenerClientToken,
  RemoteOpenerServiceToken,
} from '@opensumi/ide-remote-opener/lib/common';
import { RemoteOpenerServiceImpl } from '@opensumi/ide-remote-opener/lib/node';

import { resolveMarketplaceExtensionDirectory } from './extension-directory';
import { configureWorkspaceAgentDefaultModes, hasRunnableWorkspaceAgentPackage } from './workspace-agent-defaults';
import { WsGatewayChannelMode, WsGatewayHealthStatus, WsGatewayRuntime, disabledWsGatewayStatus } from './ws-gateway';
import { hasRunnableWsGatewayPackage, resolveWsGatewayMode } from './ws-gateway-defaults';

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

type WorkspaceAgentHealthState = WorkspaceAgentRuntimeStatus['state'] | 'disabled' | 'diagnostic-unavailable';

interface WorkspaceAgentHealthStatus {
  configured: {
    watch: WorkspaceAgentMode;
    search: WorkspaceAgentMode;
    fileSearch: WorkspaceAgentMode;
  };
  state: WorkspaceAgentHealthState;
  degraded: boolean;
  affectsReadiness: false;
  pid?: number;
  protocol?: WorkspaceAgentRuntimeStatus['protocol'];
  services?: string[];
  buildRevision?: string;
  activeStreams?: number;
  sharedWatches?: number;
  restart?: WorkspaceAgentRuntimeStatus['restart'];
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

function getWorkspaceAgentHealthStatus(injector: Injector): WorkspaceAgentHealthStatus {
  const configured = {
    watch: parseWorkspaceAgentMode(process.env.OPENSUMI_WORKSPACE_AGENT_WATCH_MODE),
    search: parseWorkspaceAgentMode(process.env.OPENSUMI_WORKSPACE_AGENT_SEARCH_MODE),
    fileSearch: parseWorkspaceAgentMode(process.env.OPENSUMI_WORKSPACE_AGENT_FILE_SEARCH_MODE),
  };
  if (configured.watch === 'off' && configured.search === 'off' && configured.fileSearch === 'off') {
    return {
      configured,
      state: 'disabled',
      degraded: false,
      affectsReadiness: false,
    };
  }

  try {
    const runtime = (injector.get(WorkspaceAgentClientToken) as WorkspaceAgentClient).getStatus();
    return {
      configured,
      ...runtime,
      degraded: ['restart-backoff', 'restart-ready', 'exhausted', 'disposed'].includes(runtime.state),
      affectsReadiness: false,
    };
  } catch {
    // Keep diagnostics non-gating: Node remains the supported fallback if the optional Agent cannot be inspected.
    return {
      configured,
      state: 'diagnostic-unavailable',
      degraded: true,
      affectsReadiness: false,
    };
  }
}

function listenHTTPServer(server: http.Server, options: number | { host: string; port: number }): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    if (typeof options === 'number') {
      server.listen(options);
    } else {
      server.listen(options.port, options.host);
    }
  });
}

export async function startServer({ modules, injector, mountStaticPath }: StartServerOptions): Promise<http.Server> {
  const app = new Koa();
  const router = new KoaRouter();
  const rootDirectory = path.resolve(__dirname, '../..');
  const extensionDirectory = path.join(rootDirectory, 'tools/extensions');
  const marketplaceExtensionDirectory = resolveMarketplaceExtensionDirectory(rootDirectory);
  const extensionLogService = path.join(
    __dirname,
    path.extname(__filename) === '.ts' ? 'mock-log-service.ts' : 'mock-log-service.js',
  );
  configureWorkspaceAgentDefaultModes(process.env, hasRunnableWorkspaceAgentPackage(rootDirectory));
  const wsGatewayMode = resolveWsGatewayMode(process.env, hasRunnableWsGatewayPackage(rootDirectory));
  const wsGatewayEnabled = wsGatewayMode.mode === 'gateway';
  const wsGatewayChannelMode = process.env.OPENSUMI_WS_GATEWAY_CHANNEL_MODE || 'multiplex-v1';
  if (wsGatewayChannelMode !== 'direct' && wsGatewayChannelMode !== 'multiplex-v1') {
    throw new Error(`OPENSUMI_WS_GATEWAY_CHANNEL_MODE must be direct or multiplex-v1, got ${wsGatewayChannelMode}`);
  }
  const wsGatewayFileRPCMode = process.env.OPENSUMI_WS_GATEWAY_FILE_RPC_MODE || 'enabled';
  if (wsGatewayFileRPCMode !== 'off' && wsGatewayFileRPCMode !== 'enabled') {
    throw new Error(`OPENSUMI_WS_GATEWAY_FILE_RPC_MODE must be off or enabled, got ${wsGatewayFileRPCMode}`);
  }
  const extensionHostConfig = {
    activationDiagnosticsEnabled: ['1', 'enabled'].includes(process.env.EXTENSION_HOST_ACTIVATION_DIAGNOSTICS || ''),
    idleTimeoutMs: readPositiveInteger('EXTENSION_HOST_IDLE_TIMEOUT', 60_000),
    limit: readPositiveInteger('MAX_EXTENSION_HOSTS', 3),
    maxOldSpaceSizeMiB: readPositiveInteger('EXTENSION_HOST_MAX_OLD_SPACE_SIZE', 256),
    shutdownTimeoutMs: readPositiveInteger('EXTENSION_HOST_SHUTDOWN_TIMEOUT', 2_000),
    startupTimeoutMs: readPositiveInteger('EXTENSION_HOST_STARTUP_TIMEOUT', 15_000),
  };
  let extensionHostStatus: ExtensionHostRuntimeStatus = {
    active: 0,
    disconnected: 0,
    clientServiceProxies: 0,
    mainThreadConnections: 0,
    limit: extensionHostConfig.limit,
    saturated: false,
    counters: {
      created: 0,
      crashed: 0,
      disposed: 0,
      reclaimed: 0,
      rejected: 0,
      startupTimeouts: 0,
    },
  };
  let wsGatewayRuntime: WsGatewayRuntime | undefined;
  let wsGatewayStaticStatus: WsGatewayHealthStatus = disabledWsGatewayStatus();
  const getWsGatewayHealthStatus = () => wsGatewayRuntime?.getStatus() ?? wsGatewayStaticStatus;

  // A fresh clone has no downloaded extensions yet. Keep the directory
  // present so the extension scanner starts quietly before the first install.
  await mkdir(extensionDirectory, { recursive: true });
  if (marketplaceExtensionDirectory) {
    await mkdir(marketplaceExtensionDirectory, { recursive: true });
  }

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
    const wsGateway = getWsGatewayHealthStatus();
    context.body = {
      status: wsGateway.degraded ? 'degraded' : 'ok',
      uptimeSeconds: process.uptime(),
      ...getMemoryStatus(),
      workspaceAgent: getWorkspaceAgentHealthStatus(injector),
      extensionHost: {
        ...extensionHostStatus,
        configured: extensionHostConfig,
        affectsReadiness: false,
      },
      wsGateway,
    };
  });

  router.get('/readyz', (context) => {
    const status = getMemoryStatus();
    const wsGateway = getWsGatewayHealthStatus();
    const ready = status.ready && (!wsGateway.affectsReadiness || wsGateway.state === 'running');
    context.status = ready ? 200 : 503;
    context.body = {
      status: ready ? 'ready' : status.ready ? 'gateway-unavailable' : 'memory-pressure',
      ...status,
      ready,
      workspaceAgent: getWorkspaceAgentHealthStatus(injector),
      extensionHost: {
        ...extensionHostStatus,
        configured: extensionHostConfig,
        affectsReadiness: false,
      },
      wsGateway,
    };
  });

  app.use(
    serveStatic(mountStaticPath || path.join(rootDirectory, 'client/dist'), {
      maxage: 30 * 24 * 60 * 60 * 1000,
    }),
  );
  app.use(router.routes());

  const buildServerAppOptions = (netChannelMode: WsGatewayChannelMode) => ({
    injector,
    modules,
    use: app.use.bind(app),
    webSocketHandler: [],
    marketplace: {
      showBuiltinExtensions: true,
      ...(marketplaceExtensionDirectory ? { extensionDir: marketplaceExtensionDirectory } : {}),
    },
    processCloseExitThreshold: extensionHostConfig.idleTimeoutMs,
    terminalPtyCloseThreshold: readPositiveInteger('TERMINAL_IDLE_TIMEOUT', 30_000),
    terminalPersistentSessionTimeout: readPositiveInteger('TERMINAL_PERSISTENT_SESSION_TIMEOUT', 30 * 60_000),
    maxExtProcessCount: extensionHostConfig.limit,
    extensionHostActivationDiagnostics: extensionHostConfig.activationDiagnosticsEnabled,
    extensionHostStartupTimeout: extensionHostConfig.startupTimeoutMs,
    extensionHostShutdownTimeout: extensionHostConfig.shutdownTimeoutMs,
    extHostForkOptions: {
      execArgv: [`--max-old-space-size=${extensionHostConfig.maxOldSpaceSizeMiB}`],
    },
    watcherHostForkOptions: {
      execArgv: [`--max-old-space-size=${readPositiveInteger('WATCHER_HOST_MAX_OLD_SPACE_SIZE', 256)}`],
    },
    wsHeartbeatInterval: readPositiveInteger('WS_HEARTBEAT_INTERVAL', 30_000),
    wsMaxConnections: readPositiveInteger('WS_MAX_CONNECTIONS', 512),
    wsMaxBufferedAmount: readPositiveInteger('WS_MAX_BUFFERED_AMOUNT', 16 * 1024 * 1024),
    wsShouldAcceptConnection: () => getMemoryStatus().ready,
    netChannelMode,
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
    staticAllowPath: [
      path.join(rootDirectory, 'packages/extension'),
      extensionDirectory,
      ...(marketplaceExtensionDirectory && marketplaceExtensionDirectory !== extensionDirectory
        ? [marketplaceExtensionDirectory]
        : []),
      '/',
    ],
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
    onDidChangeExtensionHostStatus: (status) => {
      extensionHostStatus = status;
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
  const port = Number(process.env.PORT || process.env.IDE_SERVER_PORT || 8000);

  // The Go gateway is probe-launched before any Node wiring so a default-enabled
  // deployment can still fall back to direct sockets when the launch fails.
  const launchWsGateway = async (): Promise<void> => {
    const runtime = await WsGatewayRuntime.create();
    try {
      await listenHTTPServer(server, { host: '127.0.0.1', port: 0 });
      const privateAddress = server.address();
      if (!privateAddress || typeof privateAddress === 'string' || privateAddress.address !== '127.0.0.1') {
        throw new Error(`Node HTTP backend announced an invalid private address: ${String(privateAddress)}`);
      }
      const nodeHTTPURL = `http://127.0.0.1:${privateAddress.port}`;
      await runtime.launch({
        publicListenAddress: process.env.WS_GATEWAY_LISTEN_ADDRESS || `:${port}`,
        nodeHTTPURL,
        channelMode: wsGatewayChannelMode,
        servicePath: '/service',
        maxPayloadBytes: readPositiveInteger('WS_MAX_PAYLOAD', 32 * 1024 * 1024),
        maxBufferedBytes: readPositiveInteger('WS_MAX_BUFFERED_AMOUNT', 16 * 1024 * 1024),
        maxConnections: readPositiveInteger('WS_MAX_CONNECTIONS', 512),
        heartbeatIntervalMs: readPositiveInteger('WS_HEARTBEAT_INTERVAL', 30_000),
        writeTimeoutMs: readPositiveInteger('WS_GATEWAY_WRITE_TIMEOUT', 10_000),
        dialTimeoutMs: readPositiveInteger('WS_GATEWAY_DIAL_TIMEOUT', 5_000),
        directFileRPC: wsGatewayFileRPCMode === 'enabled',
        directFileReadMaxBytes: readPositiveInteger('WS_GATEWAY_FILE_RPC_MAX_BYTES', 8 * 1024 * 1024),
        directFileMetadataMaxBytes: readPositiveInteger('WS_GATEWAY_FILE_RPC_METADATA_MAX_BYTES', 1024 * 1024),
        directFileRPCMaxConcurrent: readPositiveInteger('WS_GATEWAY_FILE_RPC_MAX_CONCURRENT', 16),
        onUnexpectedExit: (error) => {
          // eslint-disable-next-line no-console
          console.error(error.message);
          process.exitCode = 1;
          server.close();
          void runtime.stop().finally(() => process.exit(1));
        },
      });
      const stopGatewayOnSignal = () => void runtime.stop();
      process.once('SIGINT', stopGatewayOnSignal);
      process.once('SIGTERM', stopGatewayOnSignal);
      server.once('close', () => {
        process.off('SIGINT', stopGatewayOnSignal);
        process.off('SIGTERM', stopGatewayOnSignal);
        void runtime.stop();
      });
      wsGatewayRuntime = runtime;
    } catch (error) {
      if (server.listening) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      await runtime.stop();
      throw error;
    }
  };

  let serverAppChannelMode: WsGatewayChannelMode = 'direct';
  if (wsGatewayEnabled) {
    try {
      await launchWsGateway();
      serverAppChannelMode = wsGatewayChannelMode;
    } catch (error) {
      if (wsGatewayMode.source === 'explicit') {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      // eslint-disable-next-line no-console
      console.error(`WS Gateway launch failed; continuing with direct Node sockets: ${message}`);
      wsGatewayStaticStatus = { ...disabledWsGatewayStatus(), error: `fallback: ${message}` };
    }
  }

  const serverApp = new ServerApp(buildServerAppOptions(serverAppChannelMode));
  if (wsGatewayRuntime) {
    await serverApp.start(wsGatewayRuntime.channelServer);
    // eslint-disable-next-line no-console
    console.log(
      `server listen through Go WS Gateway on http://localhost:${port} (Node HTTP ${wsGatewayRuntime.getStatus().nodeHTTPURL})`,
    );
    return server;
  }
  await serverApp.start(server);
  await listenHTTPServer(server, port);
  // eslint-disable-next-line no-console
  console.log(`server listen on http://localhost:${port}`);
  return server;
}
