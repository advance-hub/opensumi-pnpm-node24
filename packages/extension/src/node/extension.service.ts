import net from 'net';
import path from 'path';
import util from 'util';

import { Autowired, Injectable } from '@opensumi/di';
import { WSServerChannel } from '@opensumi/ide-connection';
import { NetSocketConnection } from '@opensumi/ide-connection/lib/common/connection';
import { CommonChannelPathHandler } from '@opensumi/ide-connection/lib/common/server-handler';
import {
  Emitter,
  Event,
  ExtensionConnectModeOption,
  ExtensionConnectOption,
  IReporterTimer,
  SupportLogNamespace,
  getDebugLogger,
  isUndefined,
  timeout,
} from '@opensumi/ide-core-common';
import { findFreePort } from '@opensumi/ide-core-common/lib/node/port';
import { normalizedIpcHandlerPathAsync } from '@opensumi/ide-core-common/lib/utils/ipc';
import {
  AppConfig,
  Deferred,
  ExtensionHostRuntimeStatus,
  INodeLogger,
  IReporter,
  IReporterService,
  PerformanceData,
  REPORT_NAME,
  REPORT_TYPE,
  ReporterProcessMessage,
  getShellPath,
  isDevelopment,
  isElectronNode,
  isWindows,
} from '@opensumi/ide-core-node';
import { process as processUtil } from '@opensumi/ide-utils';

import {
  CONNECTION_HANDLE_BETWEEN_EXTENSION_AND_MAIN_THREAD,
  ExtensionActivationDiagnosticMessage,
  ICreateProcessOptions,
  IExtensionHostManager,
  IExtensionMetaData,
  IExtensionNodeClientService,
  IExtensionNodeService,
  IExtraMetaData,
  KT_APP_CONFIG_KEY,
  KT_PROCESS_SOCK_OPTION_KEY,
  OutputType,
  ProcessMessageType,
} from '../common';

import { ExtensionScanner } from './extension.scanner';

import type cp from 'child_process';

interface RecordedExtensionActivationDiagnostic {
  extensionId: string;
  activationCount: number;
  failureCount: number;
  maxActivationDurationMs: number;
  maxModuleCount: number;
  maxSubscriptionCount: number;
  maxObservedHeapUsedBytes: number;
  maxObservedRssBytes: number;
  maxPositiveHeapUsedDeltaBytes: number;
  maxPositiveRssDeltaBytes: number;
}

@Injectable()
export class ExtensionNodeServiceImpl implements IExtensionNodeService {
  private LOG_TAG = 'ExtensionNodeServiceImpl:' + Date.now();
  static MaxExtProcessCount = 3;
  static MaxActivationDiagnosticsPerHost = 64;
  static MaxReportedActivationDiagnostics = 10;
  static ExtensionHostStartupTimeout = 15_000;
  // ws 断开 5 分钟后杀掉插件进程
  static ProcessCloseExitThreshold: number = 5 * 60 * 1000;

  @Autowired(INodeLogger)
  private readonly logger: INodeLogger;

  private readonly extHostLogger = getDebugLogger(SupportLogNamespace.ExtensionHost);

  @Autowired(AppConfig)
  private appConfig: AppConfig;

  @Autowired(IReporterService)
  reporterService: IReporterService;

  @Autowired(IReporter)
  reporter: IReporter;

  @Autowired(IExtensionHostManager)
  private extensionHostManager: IExtensionHostManager;

  @Autowired(CommonChannelPathHandler)
  private commonChannelPathHandler: CommonChannelPathHandler;

  private clientExtProcessMap: Map<string, number> = new Map();
  // Clients whose extension host fork is still in flight. The process maps
  // only fill in once the fork resolves, so a browser that disconnects during
  // that window would otherwise bypass the disconnect disposal.
  private pendingExtHostClients: Set<string> = new Set();
  private clientExtProcessInspectPortMap: Map<string, number> = new Map();
  private clientExtProcessInitDeferredMap: Map<string, Deferred<void>> = new Map();
  private clientExtProcessExtConnection: Map<string, NetSocketConnection> = new Map();
  private clientExtProcessExtConnectionDeferredMap: Map<string, Deferred<void>> = new Map();
  private clientExtProcessExtConnectionServer: Map<string, net.Server> = new Map();
  private clientExtProcessFinishDeferredMap: Map<string, Deferred<void>> = new Map();
  private clientExtProcessThresholdExitTimerMap: Map<string, NodeJS.Timeout> = new Map();
  private clientServiceMap: Map<string, IExtensionNodeClientService> = new Map();
  private clientMainThreadChannelMap: Map<string, WSServerChannel> = new Map();
  private maybeZombieClients: Set<string> = new Set();
  private intentionallyStoppedExtProcesses: Set<number> = new Set();
  private createProcessPromises: Map<string, Promise<void>> = new Map();
  private extensionHostCreationQueue: Promise<void> = Promise.resolve();
  private clientExtensionActivationDiagnostics: Map<string, Map<string, RecordedExtensionActivationDiagnostic>> =
    new Map();
  private extensionHostCounters: ExtensionHostRuntimeStatus['counters'] = {
    created: 0,
    crashed: 0,
    disposed: 0,
    reclaimed: 0,
    rejected: 0,
    startupTimeouts: 0,
  };

  private inspectPort = 9889;

  private extensionScanner: ExtensionScanner;

  private readonly onDidSetInspectPort = new Emitter<void>();

  public setConnectionServiceClient(clientId: string, serviceClient: IExtensionNodeClientService) {
    this.clientServiceMap.set(clientId, serviceClient);
  }

  private extServerListenOptions: Map<string, net.ListenOptions> = new Map();

  private electronMainThreadListenPaths: Map<string, string> = new Map();

  public async initialize() {
    await this.extensionHostManager.init();
    this.setExtProcessConnectionForward();
    this.reportExtensionHostStatus();
  }

  private isExtensionActivationDiagnosticsEnabled(): boolean {
    return (
      Boolean(this.appConfig.extensionHostActivationDiagnostics) ||
      ['1', 'enabled'].includes(process.env.EXTENSION_HOST_ACTIVATION_DIAGNOSTICS || '')
    );
  }

  private reportExtensionHostStatus() {
    const listener = this.appConfig.onDidChangeExtensionHostStatus;
    if (!listener) {
      return;
    }
    const limit = this.appConfig.maxExtProcessCount || ExtensionNodeServiceImpl.MaxExtProcessCount;
    const disconnected = Array.from(this.clientExtProcessMap.keys()).filter(
      (clientId) => this.maybeZombieClients.has(clientId) || this.clientExtProcessThresholdExitTimerMap.has(clientId),
    ).length;
    try {
      const activationDiagnostics = this.summarizeExtensionActivationDiagnostics();
      listener({
        active: this.clientExtProcessMap.size,
        disconnected,
        clientServiceProxies: this.clientServiceMap.size,
        mainThreadConnections: this.clientMainThreadChannelMap.size,
        limit,
        saturated: this.clientExtProcessMap.size >= limit,
        counters: { ...this.extensionHostCounters },
        ...(activationDiagnostics ? { activationDiagnostics } : {}),
      });
    } catch (error) {
      this.logger.warn('Report extension host status failed', error);
    }
  }

  private summarizeExtensionActivationDiagnostics():
    NonNullable<ExtensionHostRuntimeStatus['activationDiagnostics']> | undefined {
    if (!this.isExtensionActivationDiagnosticsEnabled() || this.clientExtensionActivationDiagnostics.size === 0) {
      return undefined;
    }

    const summaries = new Map<
      string,
      NonNullable<ExtensionHostRuntimeStatus['activationDiagnostics']>['topExtensions'][number]
    >();
    for (const hostDiagnostics of this.clientExtensionActivationDiagnostics.values()) {
      for (const diagnostic of hostDiagnostics.values()) {
        const summary = summaries.get(diagnostic.extensionId) || {
          extensionId: diagnostic.extensionId,
          reportingHosts: 0,
          activationCount: 0,
          failureCount: 0,
          maxActivationDurationMs: 0,
          maxModuleCount: 0,
          maxSubscriptionCount: 0,
          maxObservedHeapUsedBytes: 0,
          maxObservedRssBytes: 0,
          maxPositiveHeapUsedDeltaBytes: 0,
          maxPositiveRssDeltaBytes: 0,
        };
        summary.reportingHosts += 1;
        summary.activationCount += diagnostic.activationCount;
        summary.failureCount += diagnostic.failureCount;
        summary.maxActivationDurationMs = Math.max(summary.maxActivationDurationMs, diagnostic.maxActivationDurationMs);
        summary.maxModuleCount = Math.max(summary.maxModuleCount, diagnostic.maxModuleCount);
        summary.maxSubscriptionCount = Math.max(summary.maxSubscriptionCount, diagnostic.maxSubscriptionCount);
        summary.maxObservedHeapUsedBytes = Math.max(
          summary.maxObservedHeapUsedBytes,
          diagnostic.maxObservedHeapUsedBytes,
        );
        summary.maxObservedRssBytes = Math.max(summary.maxObservedRssBytes, diagnostic.maxObservedRssBytes);
        summary.maxPositiveHeapUsedDeltaBytes = Math.max(
          summary.maxPositiveHeapUsedDeltaBytes,
          diagnostic.maxPositiveHeapUsedDeltaBytes,
        );
        summary.maxPositiveRssDeltaBytes = Math.max(
          summary.maxPositiveRssDeltaBytes,
          diagnostic.maxPositiveRssDeltaBytes,
        );
        summaries.set(diagnostic.extensionId, summary);
      }
    }

    return {
      reportedHosts: this.clientExtensionActivationDiagnostics.size,
      topExtensions: Array.from(summaries.values())
        .sort(
          (left, right) =>
            right.maxPositiveHeapUsedDeltaBytes - left.maxPositiveHeapUsedDeltaBytes ||
            right.maxModuleCount - left.maxModuleCount ||
            left.extensionId.localeCompare(right.extensionId),
        )
        .slice(0, ExtensionNodeServiceImpl.MaxReportedActivationDiagnostics),
    };
  }

  private recordExtensionActivationDiagnostic(clientId: string, value: unknown): void {
    if (!this.isExtensionActivationDiagnosticsEnabled()) {
      return;
    }
    const diagnostic = this.normalizeExtensionActivationDiagnostic(value);
    if (!diagnostic) {
      return;
    }

    let hostDiagnostics = this.clientExtensionActivationDiagnostics.get(clientId);
    if (!hostDiagnostics) {
      hostDiagnostics = new Map();
      this.clientExtensionActivationDiagnostics.set(clientId, hostDiagnostics);
    }
    const existing = hostDiagnostics.get(diagnostic.extensionId);
    if (existing) {
      existing.activationCount += 1;
      existing.failureCount += diagnostic.failed ? 1 : 0;
      existing.maxActivationDurationMs = Math.max(existing.maxActivationDurationMs, diagnostic.durationMs);
      existing.maxModuleCount = Math.max(existing.maxModuleCount, diagnostic.moduleCount);
      existing.maxSubscriptionCount = Math.max(existing.maxSubscriptionCount, diagnostic.subscriptionCount);
      existing.maxObservedHeapUsedBytes = Math.max(existing.maxObservedHeapUsedBytes, diagnostic.heapUsedBytes);
      existing.maxObservedRssBytes = Math.max(existing.maxObservedRssBytes, diagnostic.rssBytes);
      existing.maxPositiveHeapUsedDeltaBytes = Math.max(
        existing.maxPositiveHeapUsedDeltaBytes,
        diagnostic.heapUsedDeltaBytes,
      );
      existing.maxPositiveRssDeltaBytes = Math.max(existing.maxPositiveRssDeltaBytes, diagnostic.rssDeltaBytes);
    } else {
      if (hostDiagnostics.size >= ExtensionNodeServiceImpl.MaxActivationDiagnosticsPerHost) {
        const oldestExtensionId = hostDiagnostics.keys().next().value;
        if (oldestExtensionId) {
          hostDiagnostics.delete(oldestExtensionId);
        }
      }
      hostDiagnostics.set(diagnostic.extensionId, {
        extensionId: diagnostic.extensionId,
        activationCount: 1,
        failureCount: diagnostic.failed ? 1 : 0,
        maxActivationDurationMs: diagnostic.durationMs,
        maxModuleCount: diagnostic.moduleCount,
        maxSubscriptionCount: diagnostic.subscriptionCount,
        maxObservedHeapUsedBytes: diagnostic.heapUsedBytes,
        maxObservedRssBytes: diagnostic.rssBytes,
        maxPositiveHeapUsedDeltaBytes: Math.max(0, diagnostic.heapUsedDeltaBytes),
        maxPositiveRssDeltaBytes: Math.max(0, diagnostic.rssDeltaBytes),
      });
    }
    this.reportExtensionHostStatus();
  }

  private normalizeExtensionActivationDiagnostic(value: unknown): ExtensionActivationDiagnosticMessage | undefined {
    if (!value || typeof value !== 'object') {
      return undefined;
    }
    const candidate = value as Partial<ExtensionActivationDiagnosticMessage>;
    const extensionId = typeof candidate.extensionId === 'string' ? candidate.extensionId.trim() : '';
    if (!/^[a-z0-9][a-z0-9._-]{0,255}$/i.test(extensionId) || typeof candidate.failed !== 'boolean') {
      return undefined;
    }

    const nonNegativeFields = ['durationMs', 'moduleCount', 'subscriptionCount', 'heapUsedBytes', 'rssBytes'] as const;
    const deltaFields = ['heapUsedDeltaBytes', 'rssDeltaBytes'] as const;
    if (
      nonNegativeFields.some((field) => !Number.isSafeInteger(candidate[field]) || (candidate[field] as number) < 0) ||
      deltaFields.some((field) => !Number.isSafeInteger(candidate[field]))
    ) {
      return undefined;
    }
    return candidate as ExtensionActivationDiagnosticMessage;
  }

  public async getAllExtensions(
    scan: string[],
    extensionCandidate: string[],
    localization: string,
    extraMetaData: IExtraMetaData = {},
  ): Promise<IExtensionMetaData[]> {
    // 扫描内置插件和插件市场的插件目录
    this.extensionScanner = new ExtensionScanner(
      [...scan, this.appConfig.marketplace.extensionDir],
      localization,
      extensionCandidate,
      extraMetaData,
    );
    return this.extensionScanner.run();
  }

  async getExtension(
    extensionPath: string,
    localization: string,
    extraMetaData?: IExtraMetaData,
  ): Promise<IExtensionMetaData | undefined> {
    return await ExtensionScanner.getExtension(extensionPath, localization, extraMetaData);
  }

  private async getIPCHandlerPath(name: string) {
    return await normalizedIpcHandlerPathAsync(name, true, this.appConfig.extHostIPCSockPath);
  }

  public async getExtServerListenOption(
    clientId: string,
    extensionConnectOption?: ExtensionConnectOption,
  ): Promise<net.ListenOptions> {
    if (!this.extServerListenOptions.has(clientId)) {
      const { mode = ExtensionConnectModeOption.IPC, host } = extensionConnectOption || {};
      const options: net.ListenOptions = {};

      if (mode === ExtensionConnectModeOption.IPC) {
        options.path = await this.getIPCHandlerPath('ext_process');
      } else {
        options.port = await findFreePort(this.inspectPort, 10, 5000);
        options.host = host;
      }

      this.extServerListenOptions.set(clientId, options);
    }

    return this.extServerListenOptions.get(clientId)!;
  }

  public async getElectronMainThreadListenPath(clientId: string): Promise<string> {
    if (!this.electronMainThreadListenPaths.has(clientId)) {
      this.electronMainThreadListenPaths.set(clientId, await this.getIPCHandlerPath('main_thread'));
    }
    return this.electronMainThreadListenPaths.get(clientId)!;
  }

  private setExtProcessConnectionForward() {
    this.logger.log('setExtProcessConnectionForward', this.LOG_TAG);
    this._setMainThreadConnection(async ({ channel, clientId }) => {
      this.clientMainThreadChannelMap.set(clientId, channel);
      this.maybeZombieClients.delete(clientId);
      this.reportExtensionHostStatus();

      if (this.clientExtProcessExtConnectionDeferredMap.get(clientId)) {
        // means that we are creating the ext process or the ext process is created.
        await this.clientExtProcessExtConnectionDeferredMap.get(clientId)?.promise;
      }

      const extProcessId = this.clientExtProcessMap.get(clientId);
      const extProcessNotExist =
        isUndefined(extProcessId) ||
        !(
          (await this.extensionHostManager.isRunning(extProcessId)) && this.clientExtProcessExtConnection.has(clientId)
        );

      if (extProcessNotExist) {
        this.logger.error(`${clientId} clientId process connection not exists, try to notify client to restart`);
        /**
         * 如果前端与后端连接后发现没有对应的插件进程实例，那么通知前端重启插件进程
         * 已知如下场景会出现这种情况：
         * 1. 用户关闭电脑超过 ProcessCloseExitThreshold 设定的最大时间，插件进程被杀死后，前端再次建立连接时
         * 2. Node 进程被杀死，插件进程也会被杀死
         */
        await this.restartExtProcessByClient(clientId);
        this.reporterService.point(REPORT_NAME.EXTENSION_NOT_EXIST, clientId);
        return;
      }

      const extConnection = this.clientExtProcessExtConnection.get(clientId)!;

      const disposable1 = extConnection.onMessage((data) => {
        channel.sendBinary(data);
      });

      const disposable2 = channel.onBinary((data) => {
        extConnection.send(data);
      });

      extConnection.onceClose(() => {
        disposable1.dispose();
        disposable2.dispose();
      });

      // 连接恢复后清除销毁的定时器
      if (this.clientExtProcessThresholdExitTimerMap.has(clientId)) {
        this.cancelExtProcessDisposal(clientId);
      }

      this.logger.log(`setExtProcessConnectionForward clientId ${clientId}`);
    });
  }

  public createProcess(clientId: string, options?: ICreateProcessOptions): Promise<void> {
    const pending = this.createProcessPromises.get(clientId);
    if (pending) {
      return pending;
    }

    const creation = this.runWithExtensionHostCreationLock(async () => {
      await this.createProcessWithCapacity(clientId, options);
    });
    this.createProcessPromises.set(clientId, creation);
    void creation.then(
      () => this.createProcessPromises.delete(clientId),
      () => this.createProcessPromises.delete(clientId),
    );
    return creation;
  }

  private async runWithExtensionHostCreationLock<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.extensionHostCreationQueue;
    let release: () => void = () => undefined;
    this.extensionHostCreationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  }

  private async createProcessWithCapacity(clientId: string, options?: ICreateProcessOptions): Promise<void> {
    this.logger.log(this.LOG_TAG, 'create extension process for client:', clientId);
    this.logger.log('appconfig exthost', this.appConfig.extHost);

    const existingProcessId = this.clientExtProcessMap.get(clientId);
    if (!isUndefined(existingProcessId)) {
      if (await this.extensionHostManager.isRunning(existingProcessId)) {
        this.logger.log(`Reuse existing extension host ${existingProcessId} for client ${clientId}`);
        return;
      }
      await this.disposeClientExtProcess(clientId, false, false);
    }

    await this.ensureExtensionHostCapacity(clientId);
    try {
      await this._createExtServer(clientId, options);
      await this._createExtHostProcess(clientId, options);
    } catch (error) {
      await this.disposeClientExtProcess(clientId, false);
      throw error;
    }
  }

  private async ensureExtensionHostCapacity(clientId: string): Promise<void> {
    const maxExtProcessCount = this.appConfig.maxExtProcessCount || ExtensionNodeServiceImpl.MaxExtProcessCount;
    if (this.clientExtProcessMap.size < maxExtProcessCount) {
      return;
    }

    // Only reclaim disconnected or already-dead hosts. An active session must
    // never be evicted just because a new browser reached the server later.
    for (const [trackedClientId, processId] of this.clientExtProcessMap) {
      const disconnected =
        this.maybeZombieClients.has(trackedClientId) || this.clientExtProcessThresholdExitTimerMap.has(trackedClientId);
      const running = disconnected ? true : await this.extensionHostManager.isRunning(processId);
      if (disconnected || !running) {
        this.logger.warn(`Reclaim extension host ${processId} for ${trackedClientId} before admitting ${clientId}`);
        this.extensionHostCounters.reclaimed += 1;
        await this.disposeClientExtProcess(trackedClientId, false, running);
        if (this.clientExtProcessMap.size < maxExtProcessCount) {
          return;
        }
      }
    }

    const error = new Error(
      `Extension host capacity reached (${this.clientExtProcessMap.size}/${maxExtProcessCount}); ` +
        `client ${clientId} was not admitted`,
    );
    error.name = 'ExtensionHostCapacityError';
    this.extensionHostCounters.rejected += 1;
    this.reportExtensionHostStatus();
    this.logger.error(error.message);
    throw error;
  }

  private async _createExtServer(clientId: string, options?: ICreateProcessOptions) {
    // 创建插件进程监听的 socket
    const extServerListenOptions = await this.getExtServerListenOption(clientId, options?.extensionConnectOption);
    // 先使用单个 server，再尝试单个 server 与多个进程进行连接
    const extServer = net.createServer();
    this.clientExtProcessExtConnectionServer.set(clientId, extServer);

    extServer.on('connection', (socket) => {
      this.logger.log('_setupExtHostConnection ext host connected');

      this.clientExtProcessExtConnection.set(clientId, new NetSocketConnection(socket));
      this.clientExtProcessExtConnectionDeferredMap.get(clientId)?.resolve();
    });

    this.clientExtProcessExtConnectionDeferredMap.set(clientId, new Deferred<void>());

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        reject(error);
      };
      extServer.once('error', onError);
      extServer.listen(extServerListenOptions, () => {
        extServer.off('error', onError);
        extServer.on('error', (error) => {
          this.logger.error(`Extension host IPC server failed for ${clientId}`, error);
        });
        this.logger.log(`${clientId} ext server listen on ${JSON.stringify(extServerListenOptions)}`);
        resolve();
      });
    });

    // 重启时，旧的 path 已经不再使用，但是系统未清理，导致 listen 会失败，所以在连接关闭时，主动清理
    extServer.once('close', () => {
      this.extServerListenOptions.delete(clientId);
    });
  }

  private async _createExtHostProcess(clientId: string, options?: ICreateProcessOptions) {
    this.pendingExtHostClients.add(clientId);
    let preloadPath: string;
    let forkOptions: cp.ForkOptions = {
      // 防止 childProcess.stdout 为 null
      silent: true,
      env: {
        // 显式设置 env，因为需要和插件运行环境的 env merge
        ...process.env,
        ...options?.extHostSpawnOptions?.env,
      },
    };
    // 软链模式下的路径兼容性存在问题
    if (isElectronNode()) {
      this.logger.verbose('try get shell path for extension process');
      let shellPath: string | undefined;
      try {
        shellPath = (await getShellPath()) || '';
        // 在某些机型上，可能存在由于权限问题导致的获取的 shell path 比当前给的 path 还少的情况，这种情况下对 PATH 做一下 merge
        if (shellPath && process.env.PATH) {
          const paths = shellPath.split(':');
          process.env.PATH.split(':').forEach((path) => {
            if (paths.indexOf(path) === -1) {
              paths.push(path);
            }
          });
          shellPath = paths.join(':');
        }
        this.logger.verbose('shell path result: ' + shellPath);
      } catch (e) {
        this.logger.error('shell path error: ', e);
      }
      forkOptions = {
        ...forkOptions,
        env: {
          ...forkOptions.env,
          // 可能会有获取失败的情况
          PATH: shellPath ? shellPath : process.env.PATH,
        },
      };
    }
    const forkArgs: string[] = [];
    const extServerListenOption = await this.getExtServerListenOption(clientId, options?.extensionConnectOption);

    let extProcessPath: string;
    forkOptions.execArgv = [];

    forkArgs.push(`--${KT_PROCESS_SOCK_OPTION_KEY}=${JSON.stringify(extServerListenOption)}`);

    if (isElectronNode()) {
      extProcessPath = this.appConfig.extHost || (process.env.EXTENSION_HOST_ENTRY as string);
    } else {
      preloadPath =
        process.env.EXT_MODE === 'js'
          ? path.join(__dirname, '../../lib/hosted/ext.host.js')
          : path.join(__dirname, '../hosted/ext.host.' + processUtil.extFileType);
      if (process.env.EXT_MODE !== 'js' && processUtil.extFileType === 'ts') {
        forkOptions.execArgv = forkOptions.execArgv.concat(['-r', 'ts-node/register', '-r', 'tsconfig-paths/register']);
      }

      forkArgs.push(`--kt-process-preload=${preloadPath}`);
      if (this.appConfig.extHost) {
        extProcessPath = this.appConfig.extHost;
      } else {
        extProcessPath =
          process.env.EXT_MODE === 'js'
            ? path.join(__dirname, '../../hosted/ext.process.js')
            : path.join(__dirname, '../hosted/ext.process.' + processUtil.extFileType);
      }
    }
    this.logger.log(`Extension host process path ${extProcessPath}`);

    // 注意只能传递可以序列化的数据
    forkArgs.push(
      `--${KT_APP_CONFIG_KEY}=${JSON.stringify({
        logDir: this.appConfig.logDir,
        logLevel: this.appConfig.logLevel,
        extLogServiceClassPath: this.appConfig.extLogServiceClassPath,
        extensionHostActivationDiagnostics: this.isExtensionActivationDiagnosticsEnabled(),
      })}`,
    );

    if (options?.enableDebugExtensionHost || isDevelopment()) {
      // 开发模式下指定调试端口时，尝试从指定的端口开始寻找可用的空闲端口
      // 避免打开多个窗口(多个插件进程)时端口被占用

      const port = await this.extensionHostManager.findDebugPort(this.inspectPort, 10, 5000);
      forkOptions.execArgv.push('--nolazy');
      if (options?.inspectExtensionHost) {
        forkOptions.execArgv.push(`--inspect=${options.inspectExtensionHost}:${port}`);
      } else {
        forkOptions.execArgv.push(`--inspect=${port}`);
      }
      this.clientExtProcessInspectPortMap.set(clientId, port);
    }

    if (options?.extHostSpawnOptions?.execArgv) {
      forkOptions.execArgv = forkOptions.execArgv.concat(options.extHostSpawnOptions.execArgv);
    }

    const forkTimer = this.reporterService.time(`${clientId} fork ext process`);
    const configuredForkOptions = this.appConfig.extHostForkOptions;
    let extProcessId: number;
    try {
      extProcessId = await this.extensionHostManager.fork(extProcessPath, forkArgs, {
        ...forkOptions,
        ...configuredForkOptions,
        execArgv: [...forkOptions.execArgv, ...(configuredForkOptions?.execArgv || [])],
      });
    } finally {
      // From here the process maps own the lifecycle; a failed fork must not
      // leave the client marked as pending.
      this.pendingExtHostClients.delete(clientId);
    }
    this.clientExtProcessMap.set(clientId, extProcessId);
    this.extensionHostCounters.created += 1;
    const extProcessInitDeferred = new Deferred<void>();
    this.clientExtProcessInitDeferredMap.set(clientId, extProcessInitDeferred);
    this.processHandshake(extProcessId, forkTimer, clientId);
    this.logger.log(
      `Fork extension host process with id ${extProcessId} ` +
        `(${this.clientExtProcessMap.size}/${this.appConfig.maxExtProcessCount || ExtensionNodeServiceImpl.MaxExtProcessCount})`,
    );
    this.reportExtensionHostStatus();
    // 监听进程输出，用于获取调试端口
    this.extensionHostManager.onOutput(extProcessId, (output) => {
      const inspectorUrlMatch = output.data && output.data.match(/ws:\/\/([^\s]+:(\d+)\/[^\s]+)/);
      if (inspectorUrlMatch) {
        const port = Number(inspectorUrlMatch[2]);
        this.clientExtProcessInspectPortMap.set(clientId, port);
        this.onDidSetInspectPort.fire();
      } else {
        // 输出插件进程日志
        if (output.type === OutputType.STDERR) {
          this.extHostLogger.error(util.format(output.data, ...output.format));
        } else {
          this.extHostLogger.log(util.format(output.data, ...output.format));
        }
      }
    });

    this.extensionHostManager.onExit(extProcessId, async (code: number, signal: string) => {
      this.logger.log(`Extension host process ${extProcessId} exit by code ${code} signal ${signal}`);
      const intentionallyStopped = this.intentionallyStoppedExtProcesses.delete(extProcessId);
      if (!intentionallyStopped && this.clientExtProcessMap.get(clientId) === extProcessId) {
        this.extensionHostCounters.crashed += 1;
        await this.disposeClientExtProcess(clientId, false, false);
        await this.infoProcessCrash(clientId);
        this.reporterService.point(REPORT_NAME.EXTENSION_CRASH, clientId, {
          code,
          signal,
        });
      } else {
        this.logger.log(`Extension host process ${extProcessId} exit by dispose`);
      }
    });

    if (!(await this.extensionHostManager.isRunning(extProcessId))) {
      throw new Error(`Extension host process ${extProcessId} exited before completing startup`);
    }
  }

  public async ensureProcessReady(clientId: string): Promise<boolean> {
    const initDeferred = this.clientExtProcessInitDeferredMap.get(clientId);
    if (!initDeferred) {
      return false;
    }

    const startupTimeout =
      this.appConfig.extensionHostStartupTimeout ?? ExtensionNodeServiceImpl.ExtensionHostStartupTimeout;
    let startupTimer: NodeJS.Timeout | undefined;
    try {
      const ready = await Promise.race([
        initDeferred.promise.then(() => true),
        new Promise<boolean>((resolve) => {
          startupTimer = setTimeout(() => resolve(false), startupTimeout);
          startupTimer.unref?.();
        }),
      ]);
      if (ready) {
        return true;
      }

      this.logger.error(`Extension host startup timed out for ${clientId} after ${startupTimeout} ms`);
      this.extensionHostCounters.startupTimeouts += 1;
      this.reportExtensionHostStatus();
      await this.disposeClientExtProcess(clientId, false);
      throw new Error(`Extension host startup timed out after ${startupTimeout} ms`);
    } finally {
      if (startupTimer) {
        clearTimeout(startupTimer);
      }
    }
  }

  private processHandshake(extProcessId: number, forkTimer: IReporterTimer, clientId: string): void {
    const initHandler = (msg) => {
      if (msg === 'ready') {
        const duration = forkTimer.timeEnd();
        this.logger.log(`Starting extension host with pid ${extProcessId} (fork() took ${duration} ms).`);
        this.clientExtProcessInitDeferredMap.get(clientId)?.resolve();
        this.clientExtProcessFinishDeferredMap.set(clientId, new Deferred<void>());
      } else if (msg === 'finish') {
        const finishDeferred = this.clientExtProcessFinishDeferredMap.get(clientId);
        if (finishDeferred) {
          finishDeferred.resolve();
        }
      } else if (typeof msg === 'object' && msg.type === ProcessMessageType.EXTENSION_ACTIVATION_DIAGNOSTIC) {
        this.recordExtensionActivationDiagnostic(clientId, msg.data);
      } else if (typeof msg === 'object' && msg.type === ProcessMessageType.REPORTER) {
        const reporterMessage: ReporterProcessMessage = msg.data;
        if (reporterMessage.reportType === REPORT_TYPE.PERFORMANCE) {
          this.reporter.performance(reporterMessage.name, reporterMessage.data as PerformanceData);
        } else if (reporterMessage.reportType === REPORT_TYPE.POINT) {
          this.reporter.point(reporterMessage.name, reporterMessage.data);
        }
      }
    };
    this.extensionHostManager.onMessage(extProcessId, initHandler);
  }

  async tryEnableInspectPort(clientId: string, delay?: number): Promise<boolean> {
    if (this.clientExtProcessInspectPortMap.has(clientId)) {
      return true;
    }
    const extHostProcessId = this.clientExtProcessMap.get(clientId);
    if (isUndefined(extHostProcessId)) {
      return false;
    }

    interface ProcessExt {
      _debugProcess?(n: number): any;
    }

    if (typeof (process as ProcessExt)._debugProcess === 'function') {
      // use (undocumented) _debugProcess feature of node
      try {
        (process as ProcessExt)._debugProcess!(extHostProcessId);
      } catch (err) {
        this.logger.error(`Enable inspect port error \n ${err.message}`);
        return false;
      }

      await Promise.race([Event.toPromise(this.onDidSetInspectPort.event), timeout(delay || 1000)]);
      return typeof this.clientExtProcessInspectPortMap.get(clientId) === 'number';
    } else if (!isWindows) {
      // use KILL USR1 on non-windows platforms (fallback)
      await this.extensionHostManager.kill(extHostProcessId, 'SIGUSR1');
      await Promise.race([Event.toPromise(this.onDidSetInspectPort.event), timeout(delay || 1000)]);
      return typeof this.clientExtProcessInspectPortMap.get(clientId) === 'number';
    }

    return false;
  }

  async getProcessInspectPort(clientId: string) {
    const extHostProcessId = this.clientExtProcessMap.get(clientId);
    if (!extHostProcessId || !(await this.extensionHostManager.isRunning(extHostProcessId))) {
      return;
    }
    return this.clientExtProcessInspectPortMap.get(clientId);
  }

  private async _setMainThreadConnection(
    handler: (connectionResult: { channel: WSServerChannel; clientId: string }) => void,
  ) {
    this.commonChannelPathHandler.register(CONNECTION_HANDLE_BETWEEN_EXTENSION_AND_MAIN_THREAD, {
      handler: (channel: WSServerChannel, clientId: string) => {
        handler({
          channel,
          clientId,
        });

        channel.onceClose(() => {
          channel.dispose();
          if (this.clientMainThreadChannelMap.get(clientId) !== channel) {
            this.logger.log(`Ignore stale extension main-thread connection close for ${clientId}`);
            return;
          }
          this.clientMainThreadChannelMap.delete(clientId);
          this.logger.log(`The connection client ${clientId} closed`);

          this.maybeZombieClients.add(clientId);
          this.reportExtensionHostStatus();
          this.closeExtProcessWhenConnectionClose(clientId);
        });
      },
      dispose: (channel: unknown, clientId: string) => {
        // The physical browser connection went away. The main-thread channel
        // may never have opened for this client (fast open/close before any
        // extension activation), in which case the channel.onceClose path
        // above never ran even though the forked extension host process is
        // still alive and would leak until the process count saturates. The
        // timer in closeExtProcessWhenConnectionClose is cancel-and-rearm, so
        // running after the channel path stays a single disposal.
        if (
          !this.clientExtProcessMap.has(clientId) &&
          !this.pendingExtHostClients.has(clientId) &&
          !this.maybeZombieClients.has(clientId)
        ) {
          return;
        }
        this.logger.log(`The connection client ${clientId} disposed without an open main-thread channel`);
        this.clientMainThreadChannelMap.delete(clientId);
        this.maybeZombieClients.add(clientId);
        this.reportExtensionHostStatus();
        this.closeExtProcessWhenConnectionClose(clientId);
      },
    });
  }

  private closeExtProcessWhenConnectionClose(connectionClientId: string) {
    if (isElectronNode()) {
      // Release all client-scoped references immediately even when the
      // extension host already exited before the browser connection closed.
      void this.disposeClientExtProcess(connectionClientId, false);
      return;
    }

    this.cancelExtProcessDisposal(connectionClientId);
    const timer = setTimeout(() => {
      this.clientExtProcessThresholdExitTimerMap.delete(connectionClientId);
      this.logger.log(`Dispose client by connectionClientId ${connectionClientId}`);
      void this.disposeClientExtProcess(connectionClientId, false);
    }, this.appConfig.processCloseExitThreshold ?? ExtensionNodeServiceImpl.ProcessCloseExitThreshold);
    timer.unref?.();
    this.clientExtProcessThresholdExitTimerMap.set(connectionClientId, timer);
  }

  private cancelExtProcessDisposal(clientId: string) {
    const timer = this.clientExtProcessThresholdExitTimerMap.get(clientId);
    if (timer) {
      clearTimeout(timer);
      this.clientExtProcessThresholdExitTimerMap.delete(clientId);
    }
  }

  private async requestExtProcessShutdown(clientId: string, extProcessId: number) {
    try {
      if (!(await this.extensionHostManager.isRunning(extProcessId))) {
        return;
      }
      await this.extensionHostManager.send(extProcessId, 'close');
      const finishDeferred = this.clientExtProcessFinishDeferredMap.get(clientId);
      if (finishDeferred) {
        await Promise.race([finishDeferred.promise, timeout(this.appConfig.extensionHostShutdownTimeout ?? 5_000)]);
      }
    } catch (error) {
      this.logger.warn(`Graceful extension host shutdown failed for ${clientId}`, error);
    }
  }

  private async infoProcessNotExist(clientId: string): Promise<void> {
    const clientService = this.clientServiceMap.get(clientId) as IExtensionNodeClientService | undefined;
    if (!clientService) {
      return;
    }
    try {
      await Promise.resolve(clientService.infoProcessNotExist());
    } catch (error) {
      // The browser can disconnect between selecting the client service and
      // sending the restart notification. Cleanup must not turn that expected
      // race into an unhandled rejection in the server process.
      this.logger.warn(`Notify missing extension host failed for ${clientId}`, error);
    }
  }

  /**
   * 如果插件进程已被销毁，如 websocket 连接断开超过 `ExtensionNodeServiceImpl.ProcessCloseExitThreshold` 时
   * 那么当用户重新连接至服务时，需要通知重启整个插件进程
   */
  private async restartExtProcessByClient(clientId: string): Promise<void> {
    const clientService = this.clientServiceMap.get(clientId) as IExtensionNodeClientService | undefined;
    if (!clientService) {
      return;
    }
    try {
      await Promise.resolve(clientService.restartExtProcessByClient());
    } catch (error) {
      this.logger.warn(`Restart missing extension host notification failed for ${clientId}`, error);
    }
  }

  private async infoProcessCrash(clientId: string): Promise<void> {
    const clientService = this.clientServiceMap.get(clientId) as IExtensionNodeClientService | undefined;
    if (!clientService) {
      return;
    }
    try {
      await Promise.resolve(clientService.infoProcessCrash());
    } catch (error) {
      this.logger.warn(`Extension host crash notification failed for ${clientId}`, error);
    }
  }

  public async disposeClientExtProcess(clientId: string, info = true, killProcess = true) {
    this.cancelExtProcessDisposal(clientId);
    const extProcessId = this.clientExtProcessMap.get(clientId);
    if (!isUndefined(extProcessId) && killProcess) {
      this.intentionallyStoppedExtProcesses.add(extProcessId);
    }

    if (!isUndefined(extProcessId)) {
      await this.requestExtProcessShutdown(clientId, extProcessId);
    }

    const extServer = this.clientExtProcessExtConnectionServer.get(clientId);
    if (extServer) {
      try {
        extServer.close();
      } catch (error) {
        this.logger.warn(`Close extension host IPC server failed for ${clientId}`, error);
      }
    }

    const extConnection = this.clientExtProcessExtConnection.get(clientId);
    if (extConnection) {
      try {
        extConnection.dispose();
        extConnection.destroy();
      } catch (error) {
        this.logger.warn(`Close extension host connection failed for ${clientId}`, error);
      }
    }

    this.clientExtProcessExtConnectionServer.delete(clientId);
    this.clientExtProcessExtConnection.delete(clientId);
    this.clientExtProcessExtConnectionDeferredMap.delete(clientId);
    this.clientExtProcessFinishDeferredMap.delete(clientId);
    this.clientExtProcessInitDeferredMap.delete(clientId);
    this.clientExtProcessMap.delete(clientId);
    this.clientExtProcessInspectPortMap.delete(clientId);
    this.extServerListenOptions.delete(clientId);
    this.electronMainThreadListenPaths.delete(clientId);
    this.clientExtensionActivationDiagnostics.delete(clientId);
    if (!isUndefined(extProcessId)) {
      this.extensionHostCounters.disposed += 1;
    }
    this.reportExtensionHostStatus();

    if (!isUndefined(extProcessId) && killProcess) {
      try {
        await this.extensionHostManager.treeKill(extProcessId);
      } catch (error) {
        this.logger.warn(`Force-stop extension host failed for ${clientId}`, error);
      } finally {
        await this.extensionHostManager.disposeProcess(extProcessId);
      }
    }
    // Read the connection state after the asynchronous host shutdown. The
    // browser can disconnect or reconnect while that shutdown is in flight.
    const clientDisconnected = this.maybeZombieClients.has(clientId);
    if (info && !clientDisconnected && !isUndefined(extProcessId)) {
      await this.infoProcessNotExist(clientId);
    } else if (clientDisconnected) {
      // Host restarts and browser disconnects are separate lifecycles. Keep
      // the proxy across a host-only restart, but release it once the browser
      // connection itself has gone away.
      this.clientServiceMap.delete(clientId);
      this.maybeZombieClients.delete(clientId);
      this.reportExtensionHostStatus();
    }
    if (!isUndefined(extProcessId)) {
      this.logger.log(`Extension host process disposed by clientId ${clientId}`);
    }
  }

  public async getExtProcessId(clientId: string): Promise<number | null> {
    if (this.clientExtProcessMap.has(clientId)) {
      return this.clientExtProcessMap.get(clientId)!;
    }

    return null;
  }

  public async disposeAllClientExtProcess(): Promise<void> {
    await Promise.all(
      Array.from(this.clientExtProcessMap.keys(), (clientId) => this.disposeClientExtProcess(clientId, false)),
    );
    this.clientServiceMap.clear();
    this.clientMainThreadChannelMap.clear();
    this.maybeZombieClients.clear();
    await this.extensionHostManager.dispose();
  }
}
