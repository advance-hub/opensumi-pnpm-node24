import { ExtensionNodeServiceImpl } from '../../src/node/extension.service';

function createService() {
  const service = Object.create(ExtensionNodeServiceImpl.prototype) as any;
  Object.defineProperties(service, {
    appConfig: {
      value: {
        extensionHostShutdownTimeout: 1_000,
        extensionHostStartupTimeout: 1_000,
        maxExtProcessCount: 3,
        processCloseExitThreshold: 1_000,
      },
    },
    logger: { value: { error: jest.fn(), log: jest.fn(), warn: jest.fn() } },
  });
  service.clientExtProcessMap = new Map([['client', 123]]);
  service.clientExtProcessThresholdExitTimerMap = new Map();
  service.clientServiceMap = new Map();
  service.clientMainThreadChannelMap = new Map();
  service.maybeZombieClients = new Set();
  service.createProcessPromises = new Map();
  service.extensionHostCreationQueue = Promise.resolve();
  service.clientExtensionActivationDiagnostics = new Map();
  service.extensionHostCounters = {
    created: 0,
    crashed: 0,
    disposed: 0,
    reclaimed: 0,
    rejected: 0,
    startupTimeouts: 0,
  };
  service.disposeClientExtProcess = jest.fn().mockResolvedValue(undefined);
  return service;
}

describe('ExtensionNodeServiceImpl memory lifecycle', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('reclaims the latest extension host after its client stays disconnected', async () => {
    expect.hasAssertions();
    const service = createService();

    service.closeExtProcessWhenConnectionClose('client');
    jest.advanceTimersByTime(1_000);
    await Promise.resolve();

    expect(service.disposeClientExtProcess).toHaveBeenCalledWith('client', false);
    expect(service.clientExtProcessThresholdExitTimerMap.size).toBe(0);
  });

  it('cancels a pending extension host disposal when the client reconnects', () => {
    expect.hasAssertions();
    const service = createService();

    service.closeExtProcessWhenConnectionClose('client');
    service.cancelExtProcessDisposal('client');
    jest.advanceTimersByTime(1_000);

    expect(service.disposeClientExtProcess).not.toHaveBeenCalled();
    expect(service.clientExtProcessThresholdExitTimerMap.size).toBe(0);
  });

  it('releases client-scoped state after disconnect even when the extension host already exited', async () => {
    expect.hasAssertions();
    const service = createService();
    service.clientExtProcessMap.clear();

    service.closeExtProcessWhenConnectionClose('client');
    jest.advanceTimersByTime(1_000);
    await Promise.resolve();

    expect(service.disposeClientExtProcess).toHaveBeenCalledWith('client', false);
    expect(service.clientExtProcessThresholdExitTimerMap.size).toBe(0);
  });

  it('bounds the wait for an unresponsive extension host to finish', async () => {
    expect.hasAssertions();
    const service = createService();
    const extensionHostManager = {
      isRunning: jest.fn().mockResolvedValue(true),
      send: jest.fn().mockResolvedValue(undefined),
    };
    Object.defineProperty(service, 'extensionHostManager', { value: extensionHostManager });
    service.clientExtProcessFinishDeferredMap = new Map([['client', { promise: new Promise<void>(() => undefined) }]]);

    const shutdown = service.requestExtProcessShutdown('client', 123);
    await jest.advanceTimersByTimeAsync(1_000);
    await shutdown;

    expect(extensionHostManager.send).toHaveBeenCalledWith(123, 'close');
  });

  it('times out a host that never completes its startup handshake and releases its slot', async () => {
    expect.hasAssertions();
    const service = createService();
    service.clientExtProcessInitDeferredMap = new Map([['client', { promise: new Promise<void>(() => undefined) }]]);

    const readiness = service.ensureProcessReady('client').catch((error: Error) => error);
    await jest.advanceTimersByTimeAsync(1_000);
    await expect(readiness).resolves.toMatchObject({
      message: 'Extension host startup timed out after 1000 ms',
    });

    expect(service.disposeClientExtProcess).toHaveBeenCalledWith('client', false);
  });

  it('rejects a new client at capacity without evicting an active extension host', async () => {
    expect.hasAssertions();
    const service = createService();
    service.clientExtProcessMap = new Map([
      ['first', 123],
      ['second', 456],
      ['third', 789],
    ]);
    const extensionHostManager = { isRunning: jest.fn().mockResolvedValue(true) };
    Object.defineProperty(service, 'extensionHostManager', { value: extensionHostManager });

    await expect(service.ensureExtensionHostCapacity('fourth')).rejects.toMatchObject({
      name: 'ExtensionHostCapacityError',
    });

    expect(service.disposeClientExtProcess).not.toHaveBeenCalled();
    expect(extensionHostManager.isRunning).toHaveBeenCalledTimes(3);
  });

  it('reclaims a disconnected extension host before admitting a new client', async () => {
    expect.hasAssertions();
    const service = createService();
    service.clientExtProcessMap = new Map([
      ['first', 123],
      ['second', 456],
      ['third', 789],
    ]);
    service.maybeZombieClients.add('first');
    service.disposeClientExtProcess.mockImplementation(async (clientId: string) => {
      service.clientExtProcessMap.delete(clientId);
    });
    const extensionHostManager = { isRunning: jest.fn().mockResolvedValue(true) };
    Object.defineProperty(service, 'extensionHostManager', { value: extensionHostManager });

    await service.ensureExtensionHostCapacity('fourth');

    expect(service.disposeClientExtProcess).toHaveBeenCalledWith('first', false, true);
    expect(extensionHostManager.isRunning).not.toHaveBeenCalled();
  });

  it('coalesces concurrent creation requests for the same client', async () => {
    expect.hasAssertions();
    const service = createService();
    let finishCreation: () => void = () => undefined;
    service.createProcessWithCapacity = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          finishCreation = resolve;
        }),
    );

    const first = service.createProcess('same-client');
    const second = service.createProcess('same-client');

    expect(first).toBe(second);
    await Promise.resolve();
    expect(service.createProcessWithCapacity).toHaveBeenCalledTimes(1);
    finishCreation();
    await first;
    expect(service.createProcessPromises.size).toBe(0);
  });

  it('reports bounded extension host capacity without exposing client identifiers', () => {
    expect.hasAssertions();
    const service = createService();
    const onDidChangeExtensionHostStatus = jest.fn();
    service.appConfig.onDidChangeExtensionHostStatus = onDidChangeExtensionHostStatus;
    service.clientExtProcessMap = new Map([
      ['first', 123],
      ['second', 456],
      ['third', 789],
    ]);
    service.maybeZombieClients.add('second');
    service.extensionHostCounters.created = 3;

    service.reportExtensionHostStatus();

    expect(onDidChangeExtensionHostStatus).toHaveBeenCalledWith({
      active: 3,
      disconnected: 1,
      clientServiceProxies: 0,
      mainThreadConnections: 0,
      limit: 3,
      saturated: true,
      counters: {
        created: 3,
        crashed: 0,
        disposed: 0,
        reclaimed: 0,
        rejected: 0,
        startupTimeouts: 0,
      },
    });
    expect(JSON.stringify(onDidChangeExtensionHostStatus.mock.calls[0][0])).not.toContain('second');
  });

  it('aggregates bounded extension activation diagnostics without exposing client identifiers', () => {
    expect.hasAssertions();
    const service = createService();
    service.appConfig.extensionHostActivationDiagnostics = true;
    const onDidChangeExtensionHostStatus = jest.fn();
    service.appConfig.onDidChangeExtensionHostStatus = onDidChangeExtensionHostStatus;
    service.clientExtProcessMap.set('second-client', 456);
    const firstSample = {
      extensionId: 'publisher.heavy-extension',
      failed: false,
      durationMs: 25,
      moduleCount: 18,
      subscriptionCount: 7,
      heapUsedBytes: 40_000_000,
      heapUsedDeltaBytes: 5_000_000,
      rssBytes: 70_000_000,
      rssDeltaBytes: 8_000_000,
    };

    service.recordExtensionActivationDiagnostic('client', firstSample);
    service.recordExtensionActivationDiagnostic('client', {
      ...firstSample,
      failed: true,
      durationMs: 30,
      heapUsedDeltaBytes: -1_000_000,
    });
    service.recordExtensionActivationDiagnostic('second-client', {
      ...firstSample,
      durationMs: 20,
      moduleCount: 20,
    });

    const status = onDidChangeExtensionHostStatus.mock.calls.at(-1)[0];
    expect(status.activationDiagnostics).toEqual({
      reportedHosts: 2,
      topExtensions: [
        {
          extensionId: 'publisher.heavy-extension',
          reportingHosts: 2,
          activationCount: 3,
          failureCount: 1,
          maxActivationDurationMs: 30,
          maxModuleCount: 20,
          maxSubscriptionCount: 7,
          maxObservedHeapUsedBytes: 40_000_000,
          maxObservedRssBytes: 70_000_000,
          maxPositiveHeapUsedDeltaBytes: 5_000_000,
          maxPositiveRssDeltaBytes: 8_000_000,
        },
      ],
    });
    expect(JSON.stringify(status)).not.toContain('second-client');

    const reportsBeforeInvalidSample = onDidChangeExtensionHostStatus.mock.calls.length;
    service.recordExtensionActivationDiagnostic('client', { ...firstSample, extensionId: '../../invalid' });
    expect(onDidChangeExtensionHostStatus).toHaveBeenCalledTimes(reportsBeforeInvalidSample);
  });

  it('does not retain extension activation diagnostics when diagnostics are disabled', () => {
    expect.hasAssertions();
    const service = createService();
    const onDidChangeExtensionHostStatus = jest.fn();
    service.appConfig.onDidChangeExtensionHostStatus = onDidChangeExtensionHostStatus;

    service.recordExtensionActivationDiagnostic('client', {
      extensionId: 'publisher.extension',
      failed: false,
      durationMs: 25,
      moduleCount: 18,
      subscriptionCount: 7,
      heapUsedBytes: 40_000_000,
      heapUsedDeltaBytes: 5_000_000,
      rssBytes: 70_000_000,
      rssDeltaBytes: 8_000_000,
    });

    expect(service.clientExtensionActivationDiagnostics.size).toBe(0);
    expect(onDidChangeExtensionHostStatus).not.toHaveBeenCalled();
  });

  it('drops all client-scoped references when a disconnected host is disposed', async () => {
    expect.hasAssertions();
    const service = createService();
    service.disposeClientExtProcess = ExtensionNodeServiceImpl.prototype['disposeClientExtProcess'].bind(service);
    service.clientExtProcessInspectPortMap = new Map([['client', 9889]]);
    service.clientExtProcessExtConnectionServer = new Map([['client', { close: jest.fn() }]]);
    service.clientExtProcessExtConnection = new Map([['client', { destroy: jest.fn(), dispose: jest.fn() }]]);
    service.clientExtProcessExtConnectionDeferredMap = new Map([['client', {}]]);
    service.clientExtProcessFinishDeferredMap = new Map();
    service.clientExtProcessInitDeferredMap = new Map([['client', {}]]);
    service.extServerListenOptions = new Map([['client', { path: '/tmp/ext-host-test.sock' }]]);
    service.electronMainThreadListenPaths = new Map([['client', '/tmp/main-thread-test.sock']]);
    service.clientServiceMap = new Map([['client', { closed: true }]]);
    service.clientExtensionActivationDiagnostics = new Map([
      ['client', new Map([['publisher.extension', { extensionId: 'publisher.extension' }]])],
    ]);
    service.maybeZombieClients.add('client');
    service.intentionallyStoppedExtProcesses = new Set();
    const extensionHostManager = {
      disposeProcess: jest.fn().mockResolvedValue(undefined),
      isRunning: jest.fn().mockResolvedValue(false),
      treeKill: jest.fn().mockResolvedValue(undefined),
    };
    Object.defineProperty(service, 'extensionHostManager', { value: extensionHostManager });

    await service.disposeClientExtProcess('client', false);

    expect(service.clientExtProcessMap.size).toBe(0);
    expect(service.clientExtProcessInspectPortMap.size).toBe(0);
    expect(service.clientExtProcessExtConnectionServer.size).toBe(0);
    expect(service.clientExtProcessExtConnection.size).toBe(0);
    expect(service.clientExtProcessExtConnectionDeferredMap.size).toBe(0);
    expect(service.clientExtProcessInitDeferredMap.size).toBe(0);
    expect(service.extServerListenOptions.size).toBe(0);
    expect(service.electronMainThreadListenPaths.size).toBe(0);
    expect(service.clientServiceMap.size).toBe(0);
    expect(service.clientExtensionActivationDiagnostics.size).toBe(0);
    expect(extensionHostManager.disposeProcess).toHaveBeenCalledWith(123);
  });

  it('disposes tracked extension hosts before the host manager shuts down', async () => {
    expect.hasAssertions();
    const service = createService();
    service.clientExtProcessMap = new Map([
      ['first', 123],
      ['second', 456],
    ]);
    const extensionHostManager = { dispose: jest.fn().mockResolvedValue(undefined) };
    Object.defineProperty(service, 'extensionHostManager', { value: extensionHostManager });

    await service.disposeAllClientExtProcess();

    expect(service.disposeClientExtProcess).toHaveBeenCalledWith('first', false);
    expect(service.disposeClientExtProcess).toHaveBeenCalledWith('second', false);
    expect(extensionHostManager.dispose).toHaveBeenCalledTimes(1);
  });

  it('contains a rejected browser notification during extension host cleanup', async () => {
    expect.hasAssertions();
    const service = createService();
    const notificationError = new Error('connection already closed');
    const infoProcessNotExist = jest.fn().mockRejectedValue(notificationError);
    service.clientServiceMap = new Map([['client', { infoProcessNotExist }]]);

    await service.infoProcessNotExist('client');

    expect(infoProcessNotExist).toHaveBeenCalledTimes(1);
    expect(service.clientServiceMap.has('client')).toBe(true);
    expect(service.logger.warn).toHaveBeenCalledWith(
      'Notify missing extension host failed for client',
      notificationError,
    );
  });

  it('keeps the browser service proxy across a host-only restart', async () => {
    expect.hasAssertions();
    const service = createService();
    service.disposeClientExtProcess = ExtensionNodeServiceImpl.prototype['disposeClientExtProcess'].bind(service);
    service.clientExtProcessMap.clear();
    service.clientExtProcessInspectPortMap = new Map();
    service.clientExtProcessExtConnectionServer = new Map();
    service.clientExtProcessExtConnection = new Map();
    service.clientExtProcessExtConnectionDeferredMap = new Map();
    service.clientExtProcessFinishDeferredMap = new Map();
    service.clientExtProcessInitDeferredMap = new Map();
    service.extServerListenOptions = new Map();
    service.electronMainThreadListenPaths = new Map();
    service.clientServiceMap = new Map([['client', { connected: true }]]);
    service.intentionallyStoppedExtProcesses = new Set();

    await service.disposeClientExtProcess('client', false);

    expect(service.clientServiceMap.has('client')).toBe(true);
    expect(service.maybeZombieClients.size).toBe(0);
  });

  it('uses the latest disconnect state when the browser closes during host shutdown', async () => {
    expect.hasAssertions();
    const service = createService();
    service.disposeClientExtProcess = ExtensionNodeServiceImpl.prototype['disposeClientExtProcess'].bind(service);
    service.clientExtProcessInspectPortMap = new Map();
    service.clientExtProcessExtConnectionServer = new Map();
    service.clientExtProcessExtConnection = new Map();
    service.clientExtProcessExtConnectionDeferredMap = new Map();
    service.clientExtProcessFinishDeferredMap = new Map();
    service.clientExtProcessInitDeferredMap = new Map();
    service.extServerListenOptions = new Map();
    service.electronMainThreadListenPaths = new Map();
    service.clientServiceMap = new Map([['client', { connected: true }]]);
    service.intentionallyStoppedExtProcesses = new Set();
    let finishShutdown: () => void = () => undefined;
    service.requestExtProcessShutdown = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          finishShutdown = resolve;
        }),
    );
    const extensionHostManager = {
      disposeProcess: jest.fn().mockResolvedValue(undefined),
      treeKill: jest.fn().mockResolvedValue(undefined),
    };
    Object.defineProperty(service, 'extensionHostManager', { value: extensionHostManager });

    const disposal = service.disposeClientExtProcess('client', false);
    await Promise.resolve();
    service.maybeZombieClients.add('client');
    finishShutdown();
    await disposal;

    expect(service.clientServiceMap.has('client')).toBe(false);
    expect(service.maybeZombieClients.size).toBe(0);
    expect(extensionHostManager.disposeProcess).toHaveBeenCalledWith(123);
  });

  it('contains rejected crash and reconnect notifications', async () => {
    expect.hasAssertions();
    const service = createService();
    const crashError = new Error('crash notification disconnected');
    const reconnectError = new Error('reconnect notification disconnected');
    const infoProcessCrash = jest.fn().mockRejectedValue(crashError);
    const restartExtProcessByClient = jest.fn().mockRejectedValue(reconnectError);
    service.clientServiceMap = new Map([['client', { infoProcessCrash, restartExtProcessByClient }]]);

    await service.infoProcessCrash('client');
    await service.restartExtProcessByClient('client');

    expect(infoProcessCrash).toHaveBeenCalledTimes(1);
    expect(restartExtProcessByClient).toHaveBeenCalledTimes(1);
    expect(service.logger.warn).toHaveBeenCalledWith('Extension host crash notification failed for client', crashError);
    expect(service.logger.warn).toHaveBeenCalledWith(
      'Restart missing extension host notification failed for client',
      reconnectError,
    );
  });
});
