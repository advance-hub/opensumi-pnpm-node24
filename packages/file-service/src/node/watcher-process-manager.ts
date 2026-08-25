import { ChildProcess, fork } from 'child_process';
import { existsSync } from 'fs';
import { Server, Socket, createServer } from 'net';
import path from 'path';

import { Autowired, Injectable } from '@opensumi/di';
import { NetSocketConnection } from '@opensumi/ide-connection/lib/common/connection/drivers/socket';
import { SumiConnectionMultiplexer } from '@opensumi/ide-connection/lib/common/rpc/multiplexer';
import { ILogServiceManager, SupportLogNamespace } from '@opensumi/ide-core-common/lib/log';
import {
  DidFilesChangedParams,
  FileSystemWatcherClient,
  FileWatcherFailureParams,
  FileWatcherOverflowParams,
  RecursiveWatcherBackend,
} from '@opensumi/ide-core-common/lib/types/file-watch';
import { normalizedIpcHandlerPathAsync } from '@opensumi/ide-core-common/lib/utils/ipc';
import { AppConfig, Deferred, ILogService, UriComponents } from '@opensumi/ide-core-node';
import { process as processUtil } from '@opensumi/ide-utils';

import {
  IWatcherHostService,
  IWatcherProcessManager,
  SUMI_WATCHER_PROCESS_SOCK_KEY,
  WATCHER_INIT_DATA_KEY,
  WatcherProcessManagerProxy,
  WatcherServiceProxy,
} from '../common/watcher';

import type { ForkOptions } from 'child_process';

export const WatcherProcessManagerToken = Symbol('WatcherProcessManager');

@Injectable({ multiple: true })
export class WatcherProcessManagerImpl implements IWatcherProcessManager {
  private protocol?: SumiConnectionMultiplexer;

  private watcherSocket?: Socket;

  private watcherProcess?: ChildProcess;

  private logger: ILogService;

  private _whenReadyDeferred: Deferred<void> = new Deferred();

  @Autowired(ILogServiceManager)
  private readonly loggerManager: ILogServiceManager;

  @Autowired(AppConfig)
  private readonly appConfig: AppConfig;

  private watcherClient: FileSystemWatcherClient;

  constructor() {
    this.logger = this.loggerManager.getLogger(SupportLogNamespace.Node);
  }

  setClient(client: FileSystemWatcherClient) {
    if (!this.watcherClient) {
      this.watcherClient = client;
    }
  }

  $onDidFilesChanged(changes: DidFilesChangedParams) {
    this.watcherClient.onDidFilesChanged(changes);
  }

  $onWatcherOverflow(event: FileWatcherOverflowParams) {
    this.watcherClient.onWatcherOverflow?.(event);
  }

  $onWatcherFailed(event: FileWatcherFailureParams) {
    this.watcherClient.onWatcherFailed?.(event);
  }

  get whenReady() {
    return this._whenReadyDeferred.promise;
  }

  private clientWatcherConnectionServer: Map<string, Server> = new Map();

  private setProxyConnection(socket: Socket) {
    this.watcherSocket?.destroy();
    this.protocol?.dispose();
    const protocol = new SumiConnectionMultiplexer(new NetSocketConnection(socket), {
      timeout: -1,
    });
    protocol.set(WatcherProcessManagerProxy, this);

    this.protocol = protocol;
    this.watcherSocket = socket;
    socket.on('close', () => {
      protocol.dispose();
      if (this.protocol === protocol) {
        this.protocol = undefined;
      }
      if (this.watcherSocket === socket) {
        this.watcherSocket = undefined;
      }
    });

    this._whenReadyDeferred.resolve();
  }

  private getProxy() {
    if (!this.protocol) {
      throw new Error('Watcher process is not connected');
    }
    return this.protocol.getProxy<IWatcherHostService>(WatcherServiceProxy);
  }

  private async getIPCHandlerPath(name: string) {
    return await normalizedIpcHandlerPathAsync(name, true, this.appConfig.extHostIPCSockPath);
  }

  private async createWatcherServer(clientId: string, ipcHandlerPath: string) {
    const listenOptions = {
      path: ipcHandlerPath,
    };

    const server = createServer();
    this.clientWatcherConnectionServer.set(clientId, server);

    server.on('connection', (socket) => {
      this.logger.log('watcher process connected');
      this.setProxyConnection(socket);
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.clientWatcherConnectionServer.delete(clientId);
        reject(error);
      };
      server.once('error', onError);
      server.listen(listenOptions, () => {
        server.off('error', onError);
        this.logger.log(`watcher process listen on ${JSON.stringify(listenOptions)}`);
        resolve();
      });
    });
  }

  private async closeWatcherServers() {
    this.watcherSocket?.destroy();
    this.watcherSocket = undefined;
    this.protocol?.dispose();
    this.protocol = undefined;

    const servers = Array.from(this.clientWatcherConnectionServer.values());
    this.clientWatcherConnectionServer.clear();
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            if (!server.listening) {
              resolve();
              return;
            }
            server.close(() => resolve());
          }),
      ),
    );
  }

  private async stopWatcherProcess() {
    const watcherProcess = this.watcherProcess;
    this.watcherProcess = undefined;
    if (!watcherProcess || watcherProcess.exitCode !== null || watcherProcess.signalCode !== null) {
      return;
    }

    await new Promise<void>((resolve) => {
      let forceKillTimer: NodeJS.Timeout | undefined;
      let stopTimeout: NodeJS.Timeout | undefined;
      const finish = () => {
        if (forceKillTimer) {
          clearTimeout(forceKillTimer);
        }
        if (stopTimeout) {
          clearTimeout(stopTimeout);
        }
        watcherProcess.off('exit', finish);
        resolve();
      };
      watcherProcess.once('exit', finish);
      watcherProcess.kill('SIGTERM');
      forceKillTimer = setTimeout(() => {
        watcherProcess.kill('SIGKILL');
      }, 2_000);
      forceKillTimer.unref?.();
      stopTimeout = setTimeout(finish, 3_000);
      stopTimeout.unref?.();
    });
  }

  get watcherHost() {
    if (process.env.EXT_MODE === 'js') {
      if (!this.appConfig.watcherHost || this.isDefaultBuiltWatcherHost(this.appConfig.watcherHost)) {
        return this.getSourceWatcherHost();
      }
    }

    return this.appConfig.watcherHost || this.getBuiltWatcherHost();
  }

  private getBuiltWatcherHost() {
    return path.join(__dirname, 'hosted', 'watcher.process.' + processUtil.extFileType);
  }

  private getSourceWatcherHost() {
    const sourceWatcherHost = path.join(__dirname, 'hosted', 'watcher.process.ts');
    if (existsSync(sourceWatcherHost)) {
      return sourceWatcherHost;
    }
    return path.join(__dirname, '../../src/node/hosted/watcher.process.ts');
  }

  private isDefaultBuiltWatcherHost(watcherHost: string) {
    const resolvedWatcherHost = path.resolve(watcherHost);
    const hostNames = Array.from(new Set(['watcher.process.js', 'watcher.process.' + processUtil.extFileType]));

    return hostNames
      .flatMap((hostName) => [
        path.join(__dirname, 'hosted', hostName),
        path.join(__dirname, '../../lib/node/hosted', hostName),
      ])
      .map((candidate) => path.resolve(candidate))
      .includes(resolvedWatcherHost);
  }

  private getWatcherProcessExecArgv() {
    if (process.env.EXT_MODE !== 'js') {
      return process.execArgv;
    }

    const execArgv: string[] = [];
    for (let index = 0; index < process.execArgv.length; index++) {
      const arg = process.execArgv[index];
      if (arg.startsWith('--inspect')) {
        continue;
      }
      if (arg === '--require' || arg === '-r') {
        const moduleName = process.execArgv[index + 1];
        if (moduleName?.startsWith('ts-node/register') || moduleName === 'tsconfig-paths/register') {
          index++;
          continue;
        }
        if (moduleName) {
          execArgv.push(arg, moduleName);
        } else {
          execArgv.push(arg);
        }
        index++;
        continue;
      }
      if (arg.startsWith('--require=')) {
        const moduleName = arg.slice('--require='.length);
        if (moduleName.startsWith('ts-node/register') || moduleName === 'tsconfig-paths/register') {
          continue;
        }
      }
      execArgv.push(arg);
    }
    const ensureRequire = (moduleName: string) => {
      if (
        execArgv.includes(moduleName) ||
        execArgv.includes(`--require=${moduleName}`) ||
        execArgv.some((arg, index) => arg === '--require' && execArgv[index + 1] === moduleName) ||
        execArgv.some((arg, index) => arg === '-r' && execArgv[index + 1] === moduleName)
      ) {
        return;
      }
      execArgv.unshift(moduleName);
      execArgv.unshift('--require');
    };

    ensureRequire('tsconfig-paths/register');
    ensureRequire('ts-node/register/transpile-only');

    return execArgv;
  }

  private getWatcherProcessCwd() {
    if (process.env.EXT_MODE !== 'js') {
      return process.cwd();
    }

    return path.join(__dirname, '../../../..');
  }

  private getWatcherProcessForkOptions(): ForkOptions {
    const configuredOptions = this.appConfig.watcherHostForkOptions;
    const configuredExecArgv = configuredOptions?.execArgv || [];
    const overridesHeapLimit = configuredExecArgv.some(
      (argument) => argument.startsWith('--max-old-space-size=') || argument.startsWith('--max_old_space_size='),
    );
    const inheritedExecArgv = this.getWatcherProcessExecArgv().filter(
      (argument) =>
        !overridesHeapLimit ||
        (!argument.startsWith('--max-old-space-size=') && !argument.startsWith('--max_old_space_size=')),
    );

    return {
      ...configuredOptions,
      silent: true,
      execArgv: [...inheritedExecArgv, ...configuredExecArgv],
      cwd: configuredOptions?.cwd || this.getWatcherProcessCwd(),
    };
  }

  private async createWatcherProcess(clientId: string, ipcHandlerPath: string, backend?: RecursiveWatcherBackend) {
    const forkArgs = [
      `--${SUMI_WATCHER_PROCESS_SOCK_KEY}=${JSON.stringify({
        path: ipcHandlerPath,
      })}`,
      `--${WATCHER_INIT_DATA_KEY}=${JSON.stringify({
        logDir: this.appConfig.logDir,
        logLevel: this.appConfig.logLevel,
        backend,
        clientId,
      })}`,
    ];

    this.logger.log('Watcher process path: ', this.watcherHost);
    this.watcherProcess = fork(this.watcherHost, forkArgs, this.getWatcherProcessForkOptions());

    this.logger.log('Watcher process fork success, pid: ', this.watcherProcess.pid);

    const watcherProcess = this.watcherProcess;
    watcherProcess.on('exit', async (code, signal) => {
      this.logger.warn('watcher process exit: ', code, signal);
      if (this.watcherProcess === watcherProcess) {
        this.watcherProcess = undefined;
      }
    });

    return watcherProcess.pid;
  }

  async createProcess(clientId: string, backend?: RecursiveWatcherBackend) {
    await this.closeWatcherServers();
    await this.stopWatcherProcess();
    this._whenReadyDeferred = new Deferred();
    this.logger.log('create watcher process for client: ', clientId);
    this.logger.log('appconfig watcherHost: ', this.watcherHost);

    const ipcHandlerPath = await this.getIPCHandlerPath('watcher_process');
    await this.createWatcherServer(clientId, ipcHandlerPath);

    const pid = await this.createWatcherProcess(clientId, ipcHandlerPath, backend);

    return pid;
  }

  async dispose() {
    try {
      if (this.protocol) {
        let timeout: NodeJS.Timeout | undefined;
        await Promise.race([
          this.getProxy().$dispose(),
          new Promise<void>((resolve) => {
            timeout = setTimeout(resolve, 1_000);
            timeout.unref?.();
          }),
        ]);
        if (timeout) {
          clearTimeout(timeout);
        }
      }
    } catch {
    } finally {
      await this.closeWatcherServers();
      await this.stopWatcherProcess();
    }
  }

  async watch(
    uri: UriComponents,
    options?: { excludes?: string[]; recursive?: boolean; pollingWatch?: boolean },
  ): Promise<number> {
    this.logger.log('Wait for watcher process ready...');
    await this._whenReadyDeferred.promise;
    this.logger.log('start watch: ', uri);
    return this.getProxy().$watch(uri, options);
  }

  async unWatch(watcheId) {
    await this._whenReadyDeferred.promise;
    return this.getProxy().$unwatch(watcheId);
  }

  async setWatcherFileExcludes(excludes: string[]) {
    await this._whenReadyDeferred.promise;
    return this.getProxy().$setWatcherFileExcludes(excludes);
  }
}
