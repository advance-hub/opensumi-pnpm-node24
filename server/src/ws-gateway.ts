import { ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

const STARTUP_TIMEOUT_MS = 5_000;
const SHUTDOWN_TIMEOUT_MS = 2_000;
const READY_LINE_LIMIT_BYTES = 64 * 1024;

export type WsGatewayChannelMode = 'direct' | 'multiplex-v1';

export interface WsGatewayReadyEvent {
  event: 'opensumi-ws-gateway-ready';
  address: string;
  revision: string;
  channelMode: WsGatewayChannelMode;
  directFileRPC: boolean;
}

export interface WsGatewayHealthStatus {
  configured: boolean;
  state: 'disabled' | 'starting' | 'running' | 'failed' | 'stopped';
  degraded: boolean;
  affectsReadiness: boolean;
  pid?: number;
  publicAddress?: string;
  nodeHTTPURL?: string;
  channelTransport?: 'unix' | 'tcp-loopback';
  channelMode?: WsGatewayChannelMode;
  directFileRPC?: boolean;
  buildRevision?: string;
  error?: string;
}

export interface WsGatewayPackageManifest {
  schemaVersion: number;
  protocol: 'opensumi-ws-bridge-v1';
  goos: string;
  goarch: string;
  revision: string;
  binary: string;
  sha256: string;
}

interface PrivateChannelListener {
  server: net.Server;
  network: 'unix' | 'tcp';
  address: string;
  transport: 'unix' | 'tcp-loopback';
  socketDirectory?: string;
  /**
   * The gateway dials this listener the moment it starts, which is always
   * before ServerApp.start attaches the multiplex handler. Node's net.Server
   * silently drops connections accepted before any 'connection' listener
   * exists, so the very first (and only) gateway transport would be
   * blackholed. Connections are therefore held here, paused, and replayed
   * once the real handler is wired.
   */
  holdConnection(socket: net.Socket): void;
  heldConnections: net.Socket[];
}

export interface WsGatewayLaunchOptions {
  publicListenAddress: string;
  nodeHTTPURL: string;
  channelMode: WsGatewayChannelMode;
  servicePath: string;
  maxPayloadBytes: number;
  maxBufferedBytes: number;
  maxConnections: number;
  heartbeatIntervalMs: number;
  writeTimeoutMs: number;
  dialTimeoutMs: number;
  directFileRPC: boolean;
  directFileReadMaxBytes: number;
  directFileMetadataMaxBytes: number;
  directFileRPCMaxConcurrent: number;
  onUnexpectedExit(error: Error): void;
}

export function parseWsGatewayReadyLine(line: string): WsGatewayReadyEvent | undefined {
  let event: Partial<WsGatewayReadyEvent>;
  try {
    event = JSON.parse(line) as Partial<WsGatewayReadyEvent>;
  } catch {
    return undefined;
  }
  if (
    event.event !== 'opensumi-ws-gateway-ready' ||
    typeof event.address !== 'string' ||
    event.address.length === 0 ||
    typeof event.revision !== 'string' ||
    event.revision.length === 0 ||
    (event.channelMode !== 'direct' && event.channelMode !== 'multiplex-v1') ||
    typeof event.directFileRPC !== 'boolean'
  ) {
    return undefined;
  }
  return event as WsGatewayReadyEvent;
}

function platformTarget(): { goos: string; goarch: string } {
  const goos = process.platform === 'win32' ? 'windows' : process.platform;
  const goarch = process.arch === 'x64' ? 'amd64' : process.arch;
  if (!['darwin', 'linux', 'windows'].includes(goos) || !['amd64', 'arm64'].includes(goarch)) {
    throw new Error(`WS Gateway is not supported on ${process.platform}/${process.arch}`);
  }
  return { goos, goarch };
}

export function validateWsGatewayPackage(
  binaryPath: string,
  requireManifest = false,
): WsGatewayPackageManifest | undefined {
  const manifestPath = path.join(path.dirname(binaryPath), 'ws-gateway.manifest.json');
  if (!existsSync(manifestPath)) {
    if (requireManifest) {
      throw new Error(`WS Gateway package manifest is required at ${manifestPath}`);
    }
    return undefined;
  }
  let manifest: WsGatewayPackageManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as WsGatewayPackageManifest;
  } catch (error) {
    throw new Error(`WS Gateway package manifest is invalid at ${manifestPath}`, { cause: error });
  }
  if (
    manifest.schemaVersion !== 1 ||
    manifest.protocol !== 'opensumi-ws-bridge-v1' ||
    typeof manifest.revision !== 'string' ||
    manifest.revision.length === 0 ||
    typeof manifest.binary !== 'string'
  ) {
    throw new Error('WS Gateway package manifest is malformed or incompatible');
  }
  const target = platformTarget();
  if (manifest.goos !== target.goos || manifest.goarch !== target.goarch) {
    throw new Error(
      `WS Gateway package targets ${manifest.goos}/${manifest.goarch}, current runtime is ${target.goos}/${target.goarch}`,
    );
  }
  if (manifest.binary !== path.basename(binaryPath)) {
    throw new Error(`WS Gateway package manifest references ${manifest.binary}, not ${path.basename(binaryPath)}`);
  }
  const digest = createHash('sha256').update(readFileSync(binaryPath)).digest('hex');
  if (!/^[a-f0-9]{64}$/.test(manifest.sha256) || digest !== manifest.sha256) {
    throw new Error('WS Gateway package checksum does not match its manifest');
  }
  return manifest;
}

function resolveWsGatewayBinary(): string {
  const rootDirectory = path.resolve(__dirname, '../..');
  const binaryName = process.platform === 'win32' ? 'ws-gateway.exe' : 'ws-gateway';
  const configured = process.env.OPENSUMI_WS_GATEWAY_PATH;
  const candidates = [
    configured ? path.resolve(configured) : undefined,
    path.join(rootDirectory, 'server/dist/workspace-agent', binaryName),
    path.join(rootDirectory, 'go/workspace-agent/bin', binaryName),
  ].filter((candidate): candidate is string => Boolean(candidate));
  const binaryPath = candidates.find((candidate) => existsSync(candidate));
  if (!binaryPath) {
    throw new Error(
      `WS Gateway binary was not found; checked ${candidates.join(', ')}. Run pnpm build:ws-gateway or package:workspace-agent first.`,
    );
  }
  validateWsGatewayPackage(binaryPath, process.env.NODE_ENV === 'production');
  return binaryPath;
}

function listen(server: net.Server, options: net.ListenOptions | string): Promise<void> {
  return new Promise((resolve, reject) => {
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
    server.listen(options as net.ListenOptions);
  });
}

async function createPrivateChannelListener(): Promise<PrivateChannelListener> {
  const server = net.createServer();
  const heldConnections: net.Socket[] = [];
  const holdConnection = (socket: net.Socket) => {
    heldConnections.push(socket);
    // Paused sockets keep the preface bytes buffered until the multiplex
    // handler adopts them.
    socket.pause();
  };
  server.on('connection', holdConnection);
  const listener: PrivateChannelListener = {
    server,
    network: 'tcp',
    address: '',
    transport: 'tcp-loopback',
    holdConnection,
    heldConnections,
  };
  if (process.platform === 'win32') {
    await listen(server, { host: '127.0.0.1', port: 0 });
    const address = server.address();
    if (!address || typeof address === 'string' || address.address !== '127.0.0.1') {
      server.close();
      throw new Error(`WS Gateway channel listener announced an invalid loopback address: ${String(address)}`);
    }
    listener.address = `127.0.0.1:${address.port}`;
    return listener;
  }

  const socketDirectory = await mkdtemp(path.join(tmpdir(), 'opensumi-ws-gateway-'));
  const address = path.join(socketDirectory, 'node-channel.sock');
  try {
    await listen(server, address);
    await chmod(address, 0o600);
    listener.network = 'unix';
    listener.address = address;
    listener.transport = 'unix';
    listener.socketDirectory = socketDirectory;
    return listener;
  } catch (error) {
    server.off('connection', holdConnection);
    server.close();
    await rm(socketDirectory, { force: true, recursive: true });
    throw error;
  }
}

function waitForReadyAnnouncement(child: ChildProcess): Promise<WsGatewayReadyEvent> {
  if (!child.stdout) {
    return Promise.reject(new Error('WS Gateway stdout is unavailable'));
  }
  const stdout = child.stdout;
  return new Promise((resolve, reject) => {
    let buffer = '';
    let bufferBytes = 0;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      stdout.off('data', onData);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    const finish = (error?: Error, event?: WsGatewayReadyEvent) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (error) {
        reject(error);
      } else {
        resolve(event!);
      }
    };
    const onData = (chunk: Buffer | string) => {
      let remaining = String(chunk);
      for (;;) {
        const newline = remaining.indexOf('\n');
        const piece = newline < 0 ? remaining : remaining.slice(0, newline);
        const pieceBytes = Buffer.byteLength(piece);
        if (bufferBytes + pieceBytes > READY_LINE_LIMIT_BYTES) {
          finish(new Error(`WS Gateway ready announcement exceeded ${READY_LINE_LIMIT_BYTES} bytes`));
          return;
        }
        buffer += piece;
        bufferBytes += pieceBytes;
        if (newline < 0) {
          return;
        }
        const event = parseWsGatewayReadyLine(buffer.trim());
        buffer = '';
        bufferBytes = 0;
        if (event) {
          finish(undefined, event);
          return;
        }
        remaining = remaining.slice(newline + 1);
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(new Error(`WS Gateway exited before readiness (code ${code}, signal ${signal})`));
    };
    const onError = (error: Error) => finish(error);
    const timer = setTimeout(
      () => finish(new Error('WS Gateway did not announce readiness before timeout')),
      STARTUP_TIMEOUT_MS,
    );
    timer.unref?.();
    stdout.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.off('exit', onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    child.once('exit', onExit);
  });
}

function closeServer(server: net.Server): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }
  return new Promise((resolve) => server.close(() => resolve()));
}

export class WsGatewayRuntime {
  readonly channelServer: net.Server;
  private readonly channel: PrivateChannelListener;
  private child?: ChildProcess;
  private stopping = false;
  private stopPromise?: Promise<void>;
  private status: WsGatewayHealthStatus = {
    configured: true,
    state: 'starting',
    degraded: false,
    affectsReadiness: true,
  };

  private constructor(channel: PrivateChannelListener) {
    this.channel = channel;
    this.channelServer = channel.server;
    this.status.channelTransport = channel.transport;
  }

  static async create(): Promise<WsGatewayRuntime> {
    return new WsGatewayRuntime(await createPrivateChannelListener());
  }

  /**
   * Hands the connections the gateway dialed before ServerApp.start wired the
   * multiplex handler to that handler. Must run exactly once, right after
   * ServerApp.start(channelServer) registered the real 'connection' listener:
   * replaying through emit() delivers the paused sockets synchronously to the
   * now-registered handler.
   */
  adoptHeldChannelConnections(): void {
    const { server, holdConnection, heldConnections } = this.channel;
    server.off('connection', holdConnection);
    for (const socket of heldConnections.splice(0)) {
      socket.resume();
      server.emit('connection', socket);
    }
  }

  getStatus(): WsGatewayHealthStatus {
    return { ...this.status };
  }

  async launch(options: WsGatewayLaunchOptions): Promise<void> {
    if (this.child) {
      throw new Error('WS Gateway is already running');
    }
    const binaryPath = resolveWsGatewayBinary();
    const child = spawn(
      binaryPath,
      [
        '--listen',
        options.publicListenAddress,
        '--node-http',
        options.nodeHTTPURL,
        '--channel-network',
        this.channel.network,
        '--channel-address',
        this.channel.address,
        '--channel-mode',
        options.channelMode,
        '--service-path',
        options.servicePath,
        '--admission-path',
        '/readyz',
        '--max-payload-bytes',
        String(options.maxPayloadBytes),
        '--max-buffered-bytes',
        String(options.maxBufferedBytes),
        '--max-connections',
        String(options.maxConnections),
        '--heartbeat-interval',
        `${options.heartbeatIntervalMs}ms`,
        '--write-timeout',
        `${options.writeTimeoutMs}ms`,
        '--dial-timeout',
        `${options.dialTimeoutMs}ms`,
        ...(options.directFileRPC ? ['--direct-file-rpc'] : []),
        '--direct-file-read-max-bytes',
        String(options.directFileReadMaxBytes),
        '--direct-file-metadata-max-bytes',
        String(options.directFileMetadataMaxBytes),
        '--direct-file-rpc-max-concurrent',
        String(options.directFileRPCMaxConcurrent),
        '--diagnostics-path',
        '/_opensumi/ws-gateway',
      ],
      {
        env: { ...process.env, OPENSUMI_GATEWAY_PARENT_PID: String(process.pid) },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    this.child = child;
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr = `${stderr}${String(chunk)}`.slice(-8 * 1024);
    });

    try {
      const ready = await waitForReadyAnnouncement(child);
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(
          `WS Gateway exited immediately after readiness (code ${child.exitCode}, signal ${child.signalCode})`,
        );
      }
      child.stdout?.resume();
      this.status = {
        configured: true,
        state: 'running',
        degraded: false,
        affectsReadiness: true,
        pid: child.pid,
        publicAddress: ready.address,
        nodeHTTPURL: options.nodeHTTPURL,
        channelTransport: this.channel.transport,
        channelMode: ready.channelMode,
        directFileRPC: ready.directFileRPC,
        buildRevision: ready.revision,
      };
      child.once('exit', (code, signal) => {
        if (this.stopping) {
          return;
        }
        const error = new Error(
          `WS Gateway exited unexpectedly (code ${code}, signal ${signal})${stderr.trim() ? `: ${stderr.trim()}` : ''}`,
        );
        this.status = {
          ...this.status,
          state: 'failed',
          degraded: true,
          pid: undefined,
          error: error.message,
        };
        options.onUnexpectedExit(error);
      });
    } catch (error) {
      this.status = {
        ...this.status,
        state: 'failed',
        degraded: true,
        error: error instanceof Error ? error.message : String(error),
      };
      await this.stop();
      throw error;
    }
  }

  stop(): Promise<void> {
    this.stopPromise ||= this.stopNow();
    return this.stopPromise;
  }

  private async stopNow(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (child && !(await waitForExit(child, 0))) {
      child.kill('SIGTERM');
      if (!(await waitForExit(child, SHUTDOWN_TIMEOUT_MS))) {
        child.kill('SIGKILL');
        await waitForExit(child, 1_000);
      }
    }
    await closeServer(this.channelServer);
    if (this.channel.socketDirectory) {
      await rm(this.channel.socketDirectory, { force: true, recursive: true });
    }
    this.status = {
      ...this.status,
      state: this.status.state === 'failed' ? 'failed' : 'stopped',
      degraded: this.status.state === 'failed',
      pid: undefined,
    };
  }
}

export function disabledWsGatewayStatus(): WsGatewayHealthStatus {
  return {
    configured: false,
    state: 'disabled',
    degraded: false,
    affectsReadiness: false,
  };
}
