import { NodeModule } from './node-module';

import type { Injector } from '@opensumi/di';
import type { WebSocketHandler } from '@opensumi/ide-connection/lib/node';
import type { ConstructorOf, ILogService, LogLevel, MaybePromise } from '@opensumi/ide-core-common';
import type cp from 'child_process';
import type http from 'http';
import type https from 'https';
import type Koa from 'koa';
import type ws from 'ws';

export { NodeModule };

export interface ExtensionHostRuntimeStatus {
  active: number;
  disconnected: number;
  clientServiceProxies: number;
  mainThreadConnections: number;
  limit: number;
  saturated: boolean;
  counters: {
    created: number;
    crashed: number;
    disposed: number;
    reclaimed: number;
    rejected: number;
    startupTimeouts: number;
  };
  activationDiagnostics?: {
    reportedHosts: number;
    topExtensions: Array<{
      extensionId: string;
      reportingHosts: number;
      activationCount: number;
      failureCount: number;
      maxActivationDurationMs: number;
      maxModuleCount: number;
      maxSubscriptionCount: number;
      maxObservedHeapUsedBytes: number;
      maxObservedRssBytes: number;
      maxPositiveHeapUsedDeltaBytes: number;
      maxPositiveRssDeltaBytes: number;
    }>;
  };
}

export type ModuleConstructor = ConstructorOf<NodeModule>;
export type ContributionConstructor = ConstructorOf<ServerAppContribution>;

export const AppConfig = Symbol('AppConfig');

export interface MarketplaceRequest {
  path?: string;
  headers?: {
    [header: string]: string | string[] | undefined;
  };
}

export interface MarketplaceConfig {
  endpoint: string;
  // 插件市场下载到本地的位置，默认 ~/.sumi/extensions
  extensionDir: string;
  // 是否显示内置插件，默认隐藏
  showBuiltinExtensions: boolean;
  // 插件市场中申请到的客户端的 accountId
  accountId: string;
  // 插件市场中申请到的客户端的 masterKey
  masterKey: string;
  // 插件市场参数转换函数
  transformRequest?: (request: MarketplaceRequest) => MarketplaceRequest;
  // 在热门插件、搜索插件时忽略的插件 id
  ignoreId: string[];
}

interface Config {
  /**
   * 初始化的 DI 实例，一般可在外部进行 DI 初始化之后传入，便于提前进行一些依赖的初始化
   */
  injector: Injector;
  /**
   * 设置落盘日志级别，默认为 Info 级别的log落盘
   */
  logLevel?: LogLevel;
  /**
   * 设置日志的目录，默认：~/.sumi/logs
   */
  logDir?: string;
  /**
   * @deprecated 可通过在传入的 `injector` 初始化 `ILogService` 进行实现替换
   * 外部设置的 ILogService，替换默认的 logService
   */
  LogServiceClass?: ConstructorOf<ILogService>;
  /**
   * 启用插件进程的最大个数
   */
  maxExtProcessCount?: number;
  /**
   * 插件日志自定义实现路径
   */
  extLogServiceClassPath?: string;
  /**
   * 插件进程关闭时间
   */
  processCloseExitThreshold?: number;
  /**
   * 插件进程优雅关闭的最长等待时间，超时后强制结束
   */
  extensionHostShutdownTimeout?: number;
  /**
   * 插件进程完成启动握手的最长等待时间，超时后强制结束并释放名额
   */
  extensionHostStartupTimeout?: number;
  /**
   * 收集插件激活阶段的有界内存、模块与订阅诊断。
   * 该诊断会暴露插件标识并增加少量采样开销，生产环境默认关闭。
   */
  extensionHostActivationDiagnostics?: boolean;
  /**
   * 终端 pty 进程退出时间
   */
  terminalPtyCloseThreshold?: number;
  /**
   * 最后一个客户端断开后，持久化终端允许被恢复的最长时间。
   * 超时后必须结束 pty，避免永久遗留无人持有的 shell。
   */
  terminalPersistentSessionTimeout?: number;
  /**
   * 访问静态资源允许的 origin
   */
  staticAllowOrigin?: string;
  /**
   * 访问静态资源允许的路径，用于配置静态资源的白名单规则
   */
  staticAllowPath?: string[];
  /**
   * 文件服务禁止访问的路径，使用 glob 匹配
   */
  blockPatterns?: string[];
  /**
   * 获取插件进程句柄方法
   * @deprecated 自测 1.30.0 后，不在提供给 IDE 后端发送插件进程的方法
   */
  onDidCreateExtensionHostProcess?: (cp: cp.ChildProcess) => void;
  /**
   * 扩展宿主数量与生命周期状态变化回调，用于服务健康检查和容量观测
   */
  onDidChangeExtensionHostStatus?: (status: ExtensionHostRuntimeStatus) => void;
  /**
   * Watcher Node 进程入口文件
   */
  watcherHost?: string;
  /**
   * 文件监听子进程 fork 配置
   */
  watcherHostForkOptions?: Partial<cp.ForkOptions>;
  /**
   * 插件 Node 进程入口文件
   */
  extHost?: string;
  /**
   * 插件进程存放用于通信的 sock 地址
   * 默认为 /tmp
   */
  extHostIPCSockPath?: string;
  /**
   * 插件进程 fork 配置
   */
  extHostForkOptions?: Partial<cp.ForkOptions>;
  /**
   * 配置关闭 keytar 校验能力，默认开启
   */
  disableKeytar?: boolean;
  /**
   * control rpcProtocol message timeout
   * default -1，it means disable
   */
  rpcMessageTimeout?: number;
  collaborationOptions?: ICollaborationServerOpts;
}

export interface AppConfig extends Partial<Config> {
  marketplace: MarketplaceConfig;
}

export interface ICollaborationServerOpts {
  port?: number;
  maxPayload?: number;
  maxConnections?: number;
  maxBufferedAmount?: number;
  maxDocuments?: number;
  maxDocumentBytes?: number;
  maxStateBytes?: number;
  maxPendingDocuments?: number;
  idleTimeout?: number;
  shouldAcceptConnection?: () => boolean;
}

export interface IServerAppOpts extends Partial<Config> {
  modules?: ModuleConstructor[];
  contributions?: ContributionConstructor[];
  modulesInstances?: NodeModule[];
  webSocketHandler?: WebSocketHandler[];
  wsServerOptions?: ws.ServerOptions;
  wsHeartbeatInterval?: number;
  wsMaxConnections?: number;
  wsMaxBufferedAmount?: number;
  wsShouldAcceptConnection?: () => boolean;
  netChannelMode?: 'direct' | 'multiplex-v1';
  pathMatchOptions?: {
    // When true the regexp will match to the end of the string.
    end?: boolean;
  };
  marketplace?: Partial<MarketplaceConfig>;
  use?(middleware: Koa.Middleware<Koa.ParameterizedContext<any, any>>): void;
}

export const ServerAppContribution = Symbol('ServerAppContribution');

export interface ServerAppContribution {
  initialize?(app: IServerApp): MaybePromise<void>;
  onStart?(app: IServerApp): MaybePromise<void>;
  onStop?(app: IServerApp): MaybePromise<void>;
  onWillUseElectronMain?(): void;
}

export interface IServerApp {
  use(middleware: Koa.Middleware<Koa.ParameterizedContext<any, any>>): void;
  start(server: http.Server | https.Server): Promise<void>;
}
