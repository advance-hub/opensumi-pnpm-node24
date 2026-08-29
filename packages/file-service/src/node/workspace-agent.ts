import { ChildProcess, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  ChannelCredentials,
  Client,
  ClientReadableStream,
  Metadata,
  ServiceError,
  credentials,
  loadPackageDefinition,
  status,
} from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';

import { Autowired, Injectable } from '@opensumi/di';
import { CancellationToken } from '@opensumi/ide-core-common';
import {
  Domain,
  ILogService,
  ILogServiceManager,
  ServerAppContribution,
  SupportLogNamespace,
} from '@opensumi/ide-core-node';

export const WorkspaceAgentClientToken = Symbol('WorkspaceAgentClient');

export type WorkspaceAgentMode = 'off' | 'shadow-read' | 'enabled';

export interface WorkspaceAgentCapabilities {
  protocolMajor: number;
  protocolMinor: number;
  services: string[];
  buildRevision: string;
}

export interface WorkspaceAgentWatchRequest {
  workspaceId: string;
  rootPath: string;
  recursive: boolean;
  excludes: string[];
}

export interface WorkspaceAgentWatchEvent {
  changes?: Array<{ uri: string; type: number }>;
  overflow?: {
    resolvedUri?: string;
    eventCount: number;
    limit: number;
    timestampMs: number;
  };
  failure?: {
    resolvedUri?: string;
    message: string;
    attempts?: number;
    timestampMs: number;
  };
}

export interface WorkspaceAgentSearchRequest {
  requestId: number;
  query: string;
  rootPaths: string[];
  matchCase: boolean;
  matchWholeWord: boolean;
  useRegexp: boolean;
  includeIgnored: boolean;
  include: string[];
  exclude: string[];
  encoding: string;
  followSymlinks: boolean;
  maxResults: number;
  ripgrepPath: string;
}

export interface WorkspaceAgentSearchEvent {
  matches?: Array<{
    path: string;
    line: number;
    lineText: string;
    startByte: number;
    endByte: number;
  }>;
  limitHit?: boolean;
}

export interface WorkspaceAgentFileSearchRoot {
  rootPath: string;
  include: string[];
  exclude: string[];
  useGitIgnore: boolean;
  noIgnoreParent: boolean;
  followSymlinks: boolean;
}

export interface WorkspaceAgentFileSearchRequest {
  pattern: string;
  roots: WorkspaceAgentFileSearchRoot[];
  fuzzyMatch: boolean;
  maxResults: number;
  ripgrepPath: string;
}

export interface WorkspaceAgentFileSearchEvent {
  exactPaths?: string[];
  fuzzyPaths?: string[];
  limitHit?: boolean;
}

export interface WorkspaceAgentFileSearchResult {
  exactPaths: string[];
  fuzzyPaths: string[];
  limitHit: boolean;
}

export interface WorkspaceAgentStreamHandle {
  dispose(options?: { gracePeriodMs?: number }): void;
}

export interface WorkspaceAgentPackageManifest {
  schemaVersion: number;
  protocolMajor: number;
  protocolMinor: number;
  services: string[];
  goos: string;
  goarch: string;
  revision: string;
  binary: string;
  sha256: string;
  nativeStartupVerified?: boolean;
  builtAt?: string;
}

export interface WorkspaceAgentPackageValidationOptions {
  requireManifest?: boolean;
}

export interface WorkspaceAgentRuntimeStatus {
  state: 'idle' | 'starting' | 'running' | 'restart-backoff' | 'restart-ready' | 'exhausted' | 'disposed';
  pid?: number;
  protocol?: { major: number; minor: number };
  services: string[];
  buildRevision?: string;
  activeStreams: number;
  sharedWatches: number;
  restart: {
    failuresInWindow: number;
    maxFailuresPerWindow: number;
    windowMs: number;
    retryAfterMs: number;
  };
}

interface WorkspaceAgentWatchHandlers {
  onEvent(event: WorkspaceAgentWatchEvent): void;
  onError(error: ServiceError): void;
  onEnd(): void;
}

interface SharedWorkspaceAgentWatch {
  key: string;
  stream: ClientReadableStream<WorkspaceAgentWatchEvent>;
  untrack(): void;
  ready: Promise<void>;
  settleReady(error?: unknown): void;
  subscribers: Map<number, WorkspaceAgentWatchHandlers>;
  cleanupTimer?: NodeJS.Timeout;
  ended: boolean;
}

interface AgentControlClient extends Client {
  getCapabilities(
    request: object,
    metadata: Metadata,
    options: { deadline: Date },
    callback: (error: ServiceError | null, response: WorkspaceAgentCapabilities) => void,
  ): void;
  shutdown(
    request: object,
    metadata: Metadata,
    options: { deadline: Date },
    callback: (error: ServiceError | null) => void,
  ): void;
}

interface WorkspaceWatcherClient extends Client {
  watch(request: WorkspaceAgentWatchRequest, metadata: Metadata): ClientReadableStream<WorkspaceAgentWatchEvent>;
}

interface WorkspaceSearchClient extends Client {
  search(request: WorkspaceAgentSearchRequest, metadata: Metadata): ClientReadableStream<WorkspaceAgentSearchEvent>;
}

interface WorkspaceFileSearchClient extends Client {
  find(
    request: WorkspaceAgentFileSearchRequest,
    metadata: Metadata,
  ): ClientReadableStream<WorkspaceAgentFileSearchEvent>;
}

interface AgentClientConstructors {
  AgentControl: new (address: string, channelCredentials: ChannelCredentials) => AgentControlClient;
  WorkspaceWatcher: new (address: string, channelCredentials: ChannelCredentials) => WorkspaceWatcherClient;
  WorkspaceSearch: new (address: string, channelCredentials: ChannelCredentials) => WorkspaceSearchClient;
  WorkspaceFileSearch: new (address: string, channelCredentials: ChannelCredentials) => WorkspaceFileSearchClient;
}

interface WorkspaceAgentLaunchOptions {
  arguments: string[];
  expectedAddress?: string;
}

interface WorkspaceAgentReadyEvent {
  event: 'workspace-agent-ready';
  transport: 'unix' | 'tcp-loopback';
  address: string;
}

interface DetachedWorkspaceAgentRuntime {
  child?: ChildProcess;
  socketDirectory?: string;
  token?: string;
  control?: AgentControlClient;
  watcher?: WorkspaceWatcherClient;
  searchClient?: WorkspaceSearchClient;
  fileSearchClient?: WorkspaceFileSearchClient;
}

interface ActiveWorkspaceAgentRuntime {
  child: ChildProcess;
  token: string;
  capabilities: WorkspaceAgentCapabilities;
  watcher: WorkspaceWatcherClient;
  searchClient: WorkspaceSearchClient;
  fileSearchClient: WorkspaceFileSearchClient;
}

const PROTOCOL_MAJOR = 1;
const WATCH_READY_PROTOCOL_MINOR = 2;
const STARTUP_TIMEOUT_MS = 5_000;
const READY_ANNOUNCEMENT_LINE_LIMIT_BYTES = 64 * 1024;
const SHUTDOWN_TIMEOUT_MS = 2_000;
const RESTART_FAILURE_WINDOW_MS = 60_000;
const MAX_FAILURES_PER_RESTART_WINDOW = 3;
const RESTART_BACKOFF_MS = [250, 1_000] as const;
const protocolPath = path.resolve(__dirname, '../../proto/opensumi/workspace/v1/workspace_agent.proto');

let constructors: AgentClientConstructors | undefined;

export function parseWorkspaceAgentMode(value: string | undefined): WorkspaceAgentMode {
  if (value === 'shadow-read' || value === 'enabled') {
    return value;
  }
  return 'off';
}

export function createWorkspaceAgentLaunchOptions(
  platform: NodeJS.Platform,
  unixSocketPath?: string,
): WorkspaceAgentLaunchOptions {
  if (platform === 'win32') {
    return { arguments: ['--tcp', '127.0.0.1:0'] };
  }
  if (!unixSocketPath || !path.isAbsolute(unixSocketPath)) {
    throw new Error('Workspace Agent requires an absolute Unix socket path');
  }
  return {
    arguments: ['--socket', unixSocketPath],
    expectedAddress: `unix:${unixSocketPath}`,
  };
}

export function parseWorkspaceAgentReadyLine(line: string): WorkspaceAgentReadyEvent | undefined {
  let event: Partial<WorkspaceAgentReadyEvent>;
  try {
    event = JSON.parse(line) as Partial<WorkspaceAgentReadyEvent>;
  } catch {
    return undefined;
  }
  if (
    event.event !== 'workspace-agent-ready' ||
    (event.transport !== 'unix' && event.transport !== 'tcp-loopback') ||
    typeof event.address !== 'string'
  ) {
    return undefined;
  }
  return event as WorkspaceAgentReadyEvent;
}

export function validateWorkspaceAgentReadyAddress(
  event: WorkspaceAgentReadyEvent,
  platform: NodeJS.Platform,
  expectedAddress?: string,
): string {
  if (platform !== 'win32') {
    if (event.transport !== 'unix' || !expectedAddress || event.address !== expectedAddress) {
      throw new Error(`Workspace Agent announced an unexpected Unix address: ${event.address}`);
    }
    return event.address;
  }
  const match = /^127\.0\.0\.1:(\d{1,5})$/.exec(event.address);
  const port = Number(match?.[1] || 0);
  if (event.transport !== 'tcp-loopback' || !match || port < 1 || port > 65_535) {
    throw new Error(`Workspace Agent announced a non-private Windows address: ${event.address}`);
  }
  return event.address;
}

export function validateWorkspaceAgentCapabilities(
  capabilities: WorkspaceAgentCapabilities,
  requiredService: string,
): void {
  if (Number(capabilities.protocolMajor) !== PROTOCOL_MAJOR) {
    throw new Error(
      `Workspace Agent protocol major ${capabilities.protocolMajor} is incompatible with ${PROTOCOL_MAJOR}`,
    );
  }
  if (!capabilities.services?.includes(requiredService)) {
    throw new Error(`Workspace Agent does not provide ${requiredService}`);
  }
}

export function nodePlatformToGoos(platform: NodeJS.Platform): 'darwin' | 'linux' | 'windows' {
  if (platform === 'win32') {
    return 'windows';
  }
  if (platform === 'darwin' || platform === 'linux') {
    return platform;
  }
  throw new Error(`Workspace Agent is not supported on ${platform}`);
}

export function nodeArchitectureToGoarch(architecture: NodeJS.Architecture): 'amd64' | 'arm64' {
  if (architecture === 'x64') {
    return 'amd64';
  }
  if (architecture === 'arm64') {
    return architecture;
  }
  throw new Error(`Workspace Agent is not supported on ${architecture}`);
}

export function validateWorkspaceAgentPackage(
  binaryPath: string,
  options: WorkspaceAgentPackageValidationOptions = {},
): WorkspaceAgentPackageManifest | undefined {
  const manifestPath = path.join(path.dirname(binaryPath), 'workspace-agent.manifest.json');
  if (!existsSync(manifestPath)) {
    if (options.requireManifest) {
      throw new Error(`Workspace Agent package manifest is required at ${manifestPath}`);
    }
    return undefined;
  }
  let manifest: WorkspaceAgentPackageManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as WorkspaceAgentPackageManifest;
  } catch (error) {
    throw new Error(`Workspace Agent package manifest is invalid at ${manifestPath}`, { cause: error });
  }
  if (manifest.schemaVersion !== 1 || manifest.protocolMajor !== PROTOCOL_MAJOR) {
    throw new Error('Workspace Agent package manifest has an incompatible schema or protocol');
  }
  if (
    !Number.isSafeInteger(manifest.protocolMinor) ||
    manifest.protocolMinor < 0 ||
    !Array.isArray(manifest.services) ||
    manifest.services.some((service) => typeof service !== 'string' || service.length === 0) ||
    typeof manifest.revision !== 'string' ||
    manifest.revision.length === 0 ||
    typeof manifest.binary !== 'string'
  ) {
    throw new Error('Workspace Agent package manifest is malformed');
  }
  const currentGoos = nodePlatformToGoos(process.platform);
  const currentGoarch = nodeArchitectureToGoarch(process.arch);
  if (manifest.goos !== currentGoos || manifest.goarch !== currentGoarch) {
    throw new Error(
      `Workspace Agent package targets ${manifest.goos}/${manifest.goarch}, current runtime is ${currentGoos}/${currentGoarch}`,
    );
  }
  if (manifest.binary !== path.basename(binaryPath)) {
    throw new Error(`Workspace Agent package manifest references ${manifest.binary}, not ${path.basename(binaryPath)}`);
  }
  const digest = createHash('sha256').update(readFileSync(binaryPath)).digest('hex');
  if (!/^[a-f0-9]{64}$/.test(manifest.sha256) || digest !== manifest.sha256) {
    throw new Error('Workspace Agent package checksum does not match its manifest');
  }
  return manifest;
}

function loadConstructors(): AgentClientConstructors {
  if (constructors) {
    return constructors;
  }
  const definition = loadSync(protocolPath, {
    defaults: true,
    enums: Number,
    keepCase: false,
    longs: Number,
    oneofs: true,
  });
  const grpcObject = loadPackageDefinition(definition) as unknown as {
    opensumi: { workspace: { v1: AgentClientConstructors } };
  };
  constructors = grpcObject.opensumi.workspace.v1;
  return constructors;
}

export function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
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

function waitForDelay(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, timeoutMs));
}

function createWorkspaceAgentUnavailableError(message: string): ServiceError {
  return Object.assign(new Error(message), {
    code: status.UNAVAILABLE,
    details: message,
    metadata: new Metadata(),
  }) as ServiceError;
}

export function waitForReadyAnnouncement(child: ChildProcess): Promise<WorkspaceAgentReadyEvent> {
  if (!child.stdout) {
    return Promise.reject(new Error('Workspace Agent stdout is unavailable'));
  }
  const stdout = child.stdout;
  return new Promise((resolve, reject) => {
    let buffer = '';
    let bufferBytes = 0;
    let settled = false;
    function cleanup() {
      clearTimeout(timer);
      stdout.off('data', onData);
      child.off('exit', onExit);
      child.off('error', onError);
    }
    function finish(error?: Error, event?: WorkspaceAgentReadyEvent) {
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
    }
    function onData(chunk: Buffer | string) {
      let remaining = String(chunk);
      for (;;) {
        const newline = remaining.indexOf('\n');
        const piece = newline < 0 ? remaining : remaining.slice(0, newline);
        const pieceBytes = Buffer.byteLength(piece);
        if (bufferBytes + pieceBytes > READY_ANNOUNCEMENT_LINE_LIMIT_BYTES) {
          finish(
            new Error(
              `Workspace Agent ready announcement exceeded ${READY_ANNOUNCEMENT_LINE_LIMIT_BYTES} bytes without a valid event`,
            ),
          );
          return;
        }
        buffer += piece;
        bufferBytes += pieceBytes;
        if (newline < 0) {
          return;
        }
        const line = buffer.trim();
        buffer = '';
        bufferBytes = 0;
        const event = parseWorkspaceAgentReadyLine(line);
        if (event) {
          finish(undefined, event);
          return;
        }
        remaining = remaining.slice(newline + 1);
      }
    }
    function onExit(code: number | null, signal: NodeJS.Signals | null) {
      finish(new Error(`Workspace Agent exited before announcing its listener (code ${code}, signal ${signal})`));
    }
    function onError(error: Error) {
      finish(error);
    }
    const timer = setTimeout(
      () => finish(new Error('Workspace Agent did not announce its listener before timeout')),
      STARTUP_TIMEOUT_MS,
    );
    timer.unref?.();
    stdout.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

@Injectable()
export class WorkspaceAgentClient {
  @Autowired(ILogServiceManager)
  private readonly loggerManager: ILogServiceManager;

  private readonly logger: ILogService;
  private startPromise?: Promise<number>;
  private child?: ChildProcess;
  private socketDirectory?: string;
  private token?: string;
  private control?: AgentControlClient;
  private watcher?: WorkspaceWatcherClient;
  private searchClient?: WorkspaceSearchClient;
  private fileSearchClient?: WorkspaceFileSearchClient;
  private capabilities?: WorkspaceAgentCapabilities;
  private readonly streams = new Set<ClientReadableStream<unknown>>();
  private readonly sharedWatches = new Map<string, SharedWorkspaceAgentWatch>();
  private sharedWatchSubscriberSequence = 1;
  private disposed = false;
  private permanentlyUnavailable = false;
  private launchSequence = 0;
  private currentLaunchAttempt?: number;
  private restartNotBefore = 0;
  private failureTimestamps: number[] = [];
  private lastHandledFailureAttempt = 0;
  private readonly cleanupTasks = new Set<Promise<void>>();
  constructor() {
    this.logger = this.loggerManager.getLogger(SupportLogNamespace.Node);
  }

  getStatus(now = Date.now()): WorkspaceAgentRuntimeStatus {
    const failuresInWindow = this.failureTimestamps.filter(
      (timestamp) => now - timestamp < RESTART_FAILURE_WINDOW_MS,
    ).length;
    const running =
      this.child && this.child.exitCode === null && this.child.signalCode === null && this.capabilities !== undefined;
    const capabilities = running ? this.capabilities! : undefined;
    let state: WorkspaceAgentRuntimeStatus['state'];
    if (this.disposed) {
      state = 'disposed';
    } else if (this.permanentlyUnavailable) {
      state = 'exhausted';
    } else if (running) {
      state = 'running';
    } else if (this.startPromise) {
      state = 'starting';
    } else if (failuresInWindow > 0) {
      state = now < this.restartNotBefore ? 'restart-backoff' : 'restart-ready';
    } else {
      state = 'idle';
    }
    return {
      state,
      pid: running ? this.child!.pid : undefined,
      protocol: capabilities
        ? { major: Number(capabilities.protocolMajor), minor: Number(capabilities.protocolMinor) }
        : undefined,
      services: capabilities?.services.slice() || [],
      buildRevision: capabilities?.buildRevision || undefined,
      activeStreams: this.streams.size,
      sharedWatches: this.sharedWatches.size,
      restart: {
        failuresInWindow,
        maxFailuresPerWindow: MAX_FAILURES_PER_RESTART_WINDOW,
        windowMs: RESTART_FAILURE_WINDOW_MS,
        retryAfterMs: Math.max(0, this.restartNotBefore - now),
      },
    };
  }

  async ensureStarted(requiredService: string): Promise<number> {
    if (this.disposed) {
      throw new Error('Workspace Agent client is disposed');
    }
    if (this.child && this.child.exitCode === null && this.child.signalCode === null && this.capabilities) {
      validateWorkspaceAgentCapabilities(this.capabilities, requiredService);
      return this.child.pid!;
    }
    if (this.child && (this.child.exitCode !== null || this.child.signalCode !== null)) {
      const child = this.child;
      const message = `Workspace Agent exited before its exit callback was observed (code ${child.exitCode}, signal ${child.signalCode})`;
      const error = createWorkspaceAgentUnavailableError(message);
      if (this.currentLaunchAttempt !== undefined) {
        this.recordFailure(this.currentLaunchAttempt, error);
      }
      const runtime = this.detachRuntime(error, child);
      if (runtime) {
        await this.scheduleRuntimeCleanup(runtime, false);
      }
    }
    if (this.permanentlyUnavailable) {
      throw new Error('Workspace Agent exceeded its restart budget and is unavailable until the Server restarts');
    }

    this.startPromise ||= this.startAfterBackoff();
    const startPromise = this.startPromise;
    try {
      const pid = await startPromise;
      validateWorkspaceAgentCapabilities(this.capabilities!, requiredService);
      return pid;
    } finally {
      if (this.startPromise === startPromise) {
        this.startPromise = undefined;
      }
    }
  }

  private async getActiveRuntime(requiredService: string): Promise<ActiveWorkspaceAgentRuntime> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await this.ensureStarted(requiredService);
      const child = this.child;
      const token = this.token;
      const watcher = this.watcher;
      const searchClient = this.searchClient;
      const fileSearchClient = this.fileSearchClient;
      const capabilities = this.capabilities;
      if (
        child &&
        child.exitCode === null &&
        child.signalCode === null &&
        token &&
        watcher &&
        searchClient &&
        fileSearchClient &&
        capabilities
      ) {
        return { child, token, capabilities, watcher, searchClient, fileSearchClient };
      }
    }
    throw new Error('Workspace Agent exited while a request was being prepared');
  }

  private async startAfterBackoff(): Promise<number> {
    const delayMs = Math.max(0, this.restartNotBefore - Date.now());
    if (delayMs > 0) {
      this.logger.warn(`Workspace Agent restart delayed by ${delayMs}ms after a recent failure`);
      await waitForDelay(delayMs);
    }
    if (this.disposed) {
      throw new Error('Workspace Agent client is disposed');
    }
    if (this.permanentlyUnavailable) {
      throw new Error('Workspace Agent exceeded its restart budget and is unavailable until the Server restarts');
    }

    const attempt = ++this.launchSequence;
    try {
      return await this.start(attempt);
    } catch (error) {
      this.recordFailure(attempt, error);
      const runtime = this.detachRuntime(createWorkspaceAgentUnavailableError('Workspace Agent startup failed'));
      if (runtime) {
        await this.scheduleRuntimeCleanup(runtime, false);
      }
      throw error;
    }
  }

  private recordFailure(attempt: number, error: unknown): void {
    // Launch attempts are strictly sequential. A scalar rejects duplicate and
    // stale startup/exit callbacks without retaining every historical attempt.
    if (attempt <= this.lastHandledFailureAttempt || this.disposed) {
      return;
    }
    this.lastHandledFailureAttempt = attempt;
    const now = Date.now();
    this.failureTimestamps = this.failureTimestamps.filter((timestamp) => now - timestamp < RESTART_FAILURE_WINDOW_MS);
    this.failureTimestamps.push(now);
    const failures = this.failureTimestamps.length;
    if (failures >= MAX_FAILURES_PER_RESTART_WINDOW) {
      this.permanentlyUnavailable = true;
      this.logger.error(
        `Workspace Agent failed ${failures} times within ${RESTART_FAILURE_WINDOW_MS}ms; restart budget exhausted`,
        error,
      );
      return;
    }
    const backoffMs = RESTART_BACKOFF_MS[Math.min(failures - 1, RESTART_BACKOFF_MS.length - 1)];
    this.restartNotBefore = now + backoffMs;
    this.logger.warn(
      `Workspace Agent failure ${failures}/${MAX_FAILURES_PER_RESTART_WINDOW}; next on-demand start is allowed after ${backoffMs}ms`,
      error,
    );
  }

  private detachRuntime(
    streamError?: ServiceError,
    expectedChild?: ChildProcess,
  ): DetachedWorkspaceAgentRuntime | undefined {
    if (expectedChild && this.child !== expectedChild) {
      return undefined;
    }
    if (
      !this.child &&
      !this.socketDirectory &&
      !this.token &&
      !this.control &&
      !this.watcher &&
      !this.searchClient &&
      !this.fileSearchClient
    ) {
      return undefined;
    }
    const runtime: DetachedWorkspaceAgentRuntime = {
      child: this.child,
      socketDirectory: this.socketDirectory,
      token: this.token,
      control: this.control,
      watcher: this.watcher,
      searchClient: this.searchClient,
      fileSearchClient: this.fileSearchClient,
    };
    this.child = undefined;
    this.socketDirectory = undefined;
    this.token = undefined;
    this.control = undefined;
    this.watcher = undefined;
    this.searchClient = undefined;
    this.fileSearchClient = undefined;
    this.capabilities = undefined;
    this.currentLaunchAttempt = undefined;

    if (streamError) {
      Array.from(this.sharedWatches.values()).forEach((shared) => this.finishSharedWatch(shared, streamError));
    }
    return runtime;
  }

  private scheduleRuntimeCleanup(runtime: DetachedWorkspaceAgentRuntime, requestShutdown: boolean): Promise<void> {
    const cleanup = this.cleanupRuntime(runtime, requestShutdown).finally(() => this.cleanupTasks.delete(cleanup));
    this.cleanupTasks.add(cleanup);
    return cleanup;
  }

  private async cleanupRuntime(runtime: DetachedWorkspaceAgentRuntime, requestShutdown: boolean): Promise<void> {
    if (requestShutdown && runtime.control && runtime.token) {
      const metadata = this.createMetadata(runtime.token);
      await new Promise<void>((resolve) => {
        runtime.control!.shutdown({}, metadata, { deadline: new Date(Date.now() + 500) }, () => resolve());
      });
    }
    runtime.control?.close();
    runtime.watcher?.close();
    runtime.searchClient?.close();
    runtime.fileSearchClient?.close();

    if (runtime.child && !(await waitForExit(runtime.child, requestShutdown ? SHUTDOWN_TIMEOUT_MS : 0))) {
      runtime.child.kill('SIGTERM');
      if (!(await waitForExit(runtime.child, 1_000))) {
        runtime.child.kill('SIGKILL');
        await waitForExit(runtime.child, 1_000);
      }
    }
    if (runtime.socketDirectory) {
      await rm(runtime.socketDirectory, { force: true, recursive: true });
    }
  }

  async watch(
    request: WorkspaceAgentWatchRequest,
    handlers: WorkspaceAgentWatchHandlers,
  ): Promise<WorkspaceAgentStreamHandle> {
    const runtime = await this.getActiveRuntime('workspace.watch.v1');
    const key = this.watchKey(request);
    let shared = this.sharedWatches.get(key);
    if (!shared) {
      const stream = runtime.watcher.watch(request, this.createMetadata(runtime.token));
      const waitsForReady = Number(runtime.capabilities.protocolMinor) >= WATCH_READY_PROTOCOL_MINOR;
      let readySettled = !waitsForReady;
      let resolveReady: () => void;
      let rejectReady: (error: unknown) => void;
      const ready = waitsForReady
        ? new Promise<void>((resolve, reject) => {
            resolveReady = resolve;
            rejectReady = reject;
          })
        : Promise.resolve();
      const settleReady = (error?: unknown) => {
        if (readySettled) {
          return;
        }
        readySettled = true;
        if (error) {
          rejectReady!(error);
        } else {
          resolveReady!();
        }
      };
      shared = {
        key,
        stream,
        untrack: this.trackStream(stream),
        ready,
        settleReady,
        subscribers: new Map(),
        ended: false,
      };
      this.sharedWatches.set(key, shared);
      stream.on('data', (event) => {
        shared!.settleReady();
        shared!.subscribers.forEach((subscriber) => subscriber.onEvent(event));
      });
      stream.once('error', (error) => {
        shared!.settleReady(error);
        this.finishSharedWatch(shared!, error as ServiceError);
      });
      stream.once('end', () => {
        shared!.settleReady(new Error('Workspace Agent watcher ended before it was ready'));
        this.finishSharedWatch(shared!);
      });
      this.logger.debug(
        `Workspace Agent watcher created for ${request.rootPath} (${request.excludes.length} excludes)`,
      );
    } else if (shared.cleanupTimer) {
      clearTimeout(shared.cleanupTimer);
      shared.cleanupTimer = undefined;
      this.logger.debug(`Workspace Agent watcher reconnect reused for ${request.rootPath}`);
    } else {
      this.logger.debug(`Workspace Agent watcher subscription reused for ${request.rootPath}`);
    }

    const subscriberId = this.sharedWatchSubscriberSequence++;
    shared.subscribers.set(subscriberId, handlers);
    await shared.ready;
    return {
      dispose: (options) => this.releaseSharedWatch(shared!, subscriberId, options?.gracePeriodMs || 0),
    };
  }

  private watchKey(request: WorkspaceAgentWatchRequest): string {
    return JSON.stringify({
      rootPath: path.resolve(request.rootPath),
      recursive: request.recursive,
      excludes: Array.from(new Set(request.excludes)).sort(),
    });
  }

  private finishSharedWatch(shared: SharedWorkspaceAgentWatch, error?: ServiceError): void {
    if (shared.ended) {
      return;
    }
    shared.ended = true;
    if (shared.cleanupTimer) {
      clearTimeout(shared.cleanupTimer);
    }
    shared.untrack();
    if (this.sharedWatches.get(shared.key) === shared) {
      this.sharedWatches.delete(shared.key);
    }
    const subscribers = Array.from(shared.subscribers.values());
    shared.subscribers.clear();
    subscribers.forEach((subscriber) => (error ? subscriber.onError(error) : subscriber.onEnd()));
  }

  private releaseSharedWatch(shared: SharedWorkspaceAgentWatch, subscriberId: number, gracePeriodMs: number): void {
    shared.subscribers.delete(subscriberId);
    this.logger.debug(
      `Workspace Agent watcher subscription released (${shared.subscribers.size} remaining, ${gracePeriodMs}ms grace)`,
    );
    if (shared.ended || shared.subscribers.size > 0) {
      return;
    }
    const close = () => {
      shared.cleanupTimer = undefined;
      if (shared.ended || shared.subscribers.size > 0) {
        return;
      }
      shared.ended = true;
      if (this.sharedWatches.get(shared.key) === shared) {
        this.sharedWatches.delete(shared.key);
      }
      shared.untrack();
      shared.stream.cancel();
    };
    if (gracePeriodMs > 0) {
      shared.cleanupTimer = setTimeout(close, gracePeriodMs);
      shared.cleanupTimer.unref?.();
    } else {
      close();
    }
  }

  async search(
    request: WorkspaceAgentSearchRequest,
    handlers: {
      onEvent(event: WorkspaceAgentSearchEvent): void;
      onError(error: ServiceError): void;
      onEnd(): void;
    },
  ): Promise<WorkspaceAgentStreamHandle> {
    const runtime = await this.getActiveRuntime('workspace.search.v1');
    const stream = runtime.searchClient.search(request, this.createMetadata(runtime.token));
    const untrack = this.trackStream(stream);
    stream.on('data', handlers.onEvent);
    stream.once('error', handlers.onError);
    stream.once('end', handlers.onEnd);
    return {
      dispose: () => {
        untrack();
        stream.cancel();
      },
    };
  }

  async fileSearch(
    request: WorkspaceAgentFileSearchRequest,
    token: CancellationToken = CancellationToken.None,
  ): Promise<WorkspaceAgentFileSearchResult> {
    if (token.isCancellationRequested) {
      return { exactPaths: [], fuzzyPaths: [], limitHit: false };
    }
    const runtime = await this.getActiveRuntime('workspace.fileSearch.v1');
    return new Promise((resolve, reject) => {
      const exactPaths: string[] = [];
      const fuzzyPaths: string[] = [];
      let limitHit = false;
      let settled = false;
      const stream = runtime.fileSearchClient.find(request, this.createMetadata(runtime.token));
      const untrack = this.trackStream(stream);
      let cancellationDisposable: { dispose(): void } | undefined;

      const cleanup = () => {
        untrack();
        cancellationDisposable?.dispose();
        stream.off('data', onData);
        stream.off('error', onError);
        stream.off('end', onEnd);
      };
      const finish = (error?: ServiceError) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        if (error && !token.isCancellationRequested) {
          reject(error);
        } else {
          resolve({ exactPaths, fuzzyPaths, limitHit });
        }
      };
      const onData = (event: WorkspaceAgentFileSearchEvent) => {
        exactPaths.push(...(event.exactPaths || []));
        fuzzyPaths.push(...(event.fuzzyPaths || []));
        limitHit ||= Boolean(event.limitHit);
      };
      const onError = (error: ServiceError) => finish(error);
      const onEnd = () => finish();

      stream.on('data', onData);
      stream.once('error', onError);
      stream.once('end', onEnd);
      cancellationDisposable = token.onCancellationRequested(() => stream.cancel());
      if (token.isCancellationRequested) {
        stream.cancel();
      }
    });
  }

  private async start(attempt: number): Promise<number> {
    this.currentLaunchAttempt = attempt;
    const binaryPath = this.resolveBinaryPath();
    const ClientConstructors = loadConstructors();
    let socketPath: string | undefined;
    if (process.platform !== 'win32') {
      this.socketDirectory = await mkdtemp(path.join(tmpdir(), 'opensumi-workspace-agent-'));
      socketPath = path.join(this.socketDirectory, 'agent.sock');
    }
    if (this.disposed) {
      throw new Error('Workspace Agent client is disposed');
    }
    const launch = createWorkspaceAgentLaunchOptions(process.platform, socketPath);
    const token = randomBytes(32).toString('hex');
    this.token = token;
    this.child = spawn(binaryPath, launch.arguments, {
      env: {
        ...process.env,
        OPENSUMI_AGENT_PARENT_PID: String(process.pid),
        OPENSUMI_AGENT_TOKEN: token,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const child = this.child;
    const ready = waitForReadyAnnouncement(child);
    child.stdout?.on('data', (chunk) => this.logger.debug(`[workspace-agent] ${String(chunk).trim()}`));
    child.stderr?.on('data', (chunk) => this.logger.warn(`[workspace-agent] ${String(chunk).trim()}`));
    child.once('exit', (code, signal) => {
      if (!this.disposed && this.child === child) {
        const message = `Workspace Agent exited unexpectedly (code ${code}, signal ${signal})`;
        const error = createWorkspaceAgentUnavailableError(message);
        this.logger.error(message);
        this.recordFailure(attempt, error);
        const runtime = this.detachRuntime(error, child);
        if (runtime) {
          void this.scheduleRuntimeCleanup(runtime, false).catch((cleanupError) => {
            this.logger.warn('Failed to clean up an exited Workspace Agent', cleanupError);
          });
        }
      }
    });
    const spawned = new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    const [, announcement] = await Promise.all([spawned, ready]);
    const address = validateWorkspaceAgentReadyAddress(announcement, process.platform, launch.expectedAddress);
    const insecure = credentials.createInsecure();
    const control = new ClientConstructors.AgentControl(address, insecure);
    const watcher = new ClientConstructors.WorkspaceWatcher(address, insecure);
    const searchClient = new ClientConstructors.WorkspaceSearch(address, insecure);
    const fileSearchClient = new ClientConstructors.WorkspaceFileSearch(address, insecure);
    this.control = control;
    this.watcher = watcher;
    this.searchClient = searchClient;
    this.fileSearchClient = fileSearchClient;
    await new Promise<void>((resolve, reject) => {
      control.waitForReady(Date.now() + STARTUP_TIMEOUT_MS, (error) => (error ? reject(error) : resolve()));
    });
    const capabilities = await new Promise<WorkspaceAgentCapabilities>((resolve, reject) => {
      control.getCapabilities(
        {},
        this.createMetadata(token),
        { deadline: new Date(Date.now() + STARTUP_TIMEOUT_MS) },
        (error, response) => (error ? reject(error) : resolve(response)),
      );
    });
    if (this.disposed || this.child !== child) {
      throw new Error('Workspace Agent stopped during startup');
    }
    this.capabilities = capabilities;
    this.logger.log(
      `Workspace Agent ready (pid ${child.pid}, protocol ${capabilities.protocolMajor}.${capabilities.protocolMinor}, services ${capabilities.services.join(',')})`,
    );
    return child.pid!;
  }

  private resolveBinaryPath(): string {
    const configured = process.env.OPENSUMI_WORKSPACE_AGENT_PATH;
    const binaryName = process.platform === 'win32' ? 'workspace-agent.exe' : 'workspace-agent';
    const developmentBinary = path.resolve(__dirname, '../../../../go/workspace-agent/bin', binaryName);
    const packagedBinary = path.resolve(__dirname, '../../../../server/dist/workspace-agent', binaryName);
    const candidates = configured
      ? [path.resolve(configured)]
      : process.env.NODE_ENV === 'production'
        ? [packagedBinary]
        : [developmentBinary, packagedBinary];
    const binaryPath = candidates.find((candidate) => existsSync(candidate));
    if (!binaryPath) {
      throw new Error(
        `Workspace Agent binary not found at ${candidates.join(' or ')}; run pnpm build:workspace-agent or pnpm build:server:workspace-agent`,
      );
    }
    validateWorkspaceAgentPackage(binaryPath, { requireManifest: process.env.NODE_ENV === 'production' });
    return binaryPath;
  }

  private createMetadata(token = this.token): Metadata {
    if (!token) {
      throw new Error('Workspace Agent authorization token is unavailable');
    }
    const metadata = new Metadata();
    metadata.set('authorization', `Bearer ${token}`);
    return metadata;
  }

  private trackStream<T>(stream: ClientReadableStream<T>): () => void {
    this.streams.add(stream as ClientReadableStream<unknown>);
    let tracked = true;
    const remove = () => {
      if (!tracked) {
        return;
      }
      tracked = false;
      this.streams.delete(stream as ClientReadableStream<unknown>);
      stream.off('end', remove);
      stream.off('error', remove);
    };
    stream.once('end', remove);
    stream.once('error', remove);
    return remove;
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.sharedWatches.forEach((shared) => {
      if (shared.cleanupTimer) {
        clearTimeout(shared.cleanupTimer);
      }
      shared.ended = true;
      shared.untrack();
      shared.stream.cancel();
      shared.subscribers.clear();
    });
    this.sharedWatches.clear();
    this.streams.forEach((stream) => stream.cancel());
    this.streams.clear();

    const startPromise = this.startPromise;
    const runtime = this.detachRuntime();
    if (runtime) {
      await this.scheduleRuntimeCleanup(runtime, true);
    }
    await startPromise?.catch(() => undefined);
    const lateRuntime = this.detachRuntime();
    if (lateRuntime) {
      await this.scheduleRuntimeCleanup(lateRuntime, true);
    }
    await Promise.all(Array.from(this.cleanupTasks));
  }
}

@Domain(ServerAppContribution)
export class WorkspaceAgentLifecycleContribution implements ServerAppContribution {
  @Autowired(WorkspaceAgentClientToken)
  private readonly workspaceAgent: WorkspaceAgentClient;

  async onStop(): Promise<void> {
    await this.workspaceAgent.dispose();
  }
}

export function isCancelledServiceError(error: ServiceError): boolean {
  return error.code === status.CANCELLED;
}
