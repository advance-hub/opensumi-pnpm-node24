import { ExtensionNodeServiceImpl } from '../../src/node/extension.service';

function createService() {
  const service = Object.create(ExtensionNodeServiceImpl.prototype) as any;
  Object.defineProperties(service, {
    appConfig: { value: { extensionHostShutdownTimeout: 1_000, processCloseExitThreshold: 1_000 } },
    logger: { value: { log: jest.fn(), warn: jest.fn() } },
  });
  service.clientExtProcessMap = new Map([['client', 123]]);
  service.clientExtProcessThresholdExitTimerMap = new Map();
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

    expect(service.disposeClientExtProcess).toHaveBeenCalledWith('client');
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
});
