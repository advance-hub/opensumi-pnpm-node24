import { ExtensionNodeServiceImpl } from '../../src/node/extension.service';

function createService() {
  const service = Object.create(ExtensionNodeServiceImpl.prototype) as any;
  Object.defineProperties(service, {
    appConfig: { value: { maxExtProcessCount: 3 } },
    logger: { value: { error: jest.fn(), log: jest.fn(), warn: jest.fn() } },
  });
  service.clientExtProcessMap = new Map();
  service.maybeZombieClients = new Set();
  service.pendingExtHostClients = new Set();
  service.ensureExtensionHostCapacity = jest.fn().mockResolvedValue(undefined);
  service.disposeClientExtProcess = jest.fn().mockImplementation(async (clientId: string) => {
    service.clientExtProcessMap.delete(clientId);
    service.maybeZombieClients.delete(clientId);
  });
  service._createExtServer = jest.fn().mockResolvedValue(undefined);
  service._createExtHostProcess = jest.fn().mockResolvedValue(undefined);
  return service;
}

describe('ExtensionNodeServiceImpl startup disconnect lifecycle', () => {
  it('uses connection facade disposal as the fallback host disconnect signal', () => {
    expect.hasAssertions();
    const service = createService();
    service.clientExtProcessMap.set('client', 123);
    service.clientServiceMap = new Map();
    service.closeExtProcessWhenConnectionClose = jest.fn();
    service.reportExtensionHostStatus = jest.fn();
    service.setConnectionServiceClient = ExtensionNodeServiceImpl.prototype['setConnectionServiceClient'].bind(service);
    const facade = { connection: 'client' };

    const release = service.registerConnectionServiceClient('client', facade);
    release();

    expect(service.clientServiceMap.has('client')).toBe(false);
    expect(service.maybeZombieClients.has('client')).toBe(true);
    expect(service.closeExtProcessWhenConnectionClose).toHaveBeenCalledWith('client');
  });

  it('does not fork a host after the browser disconnects while the IPC server starts', async () => {
    expect.hasAssertions();
    const service = createService();
    service._createExtServer.mockImplementation(async () => {
      service.maybeZombieClients.add('client');
    });

    await expect(service.createProcessWithCapacity('client')).rejects.toMatchObject({
      name: 'ExtensionHostClientDisconnectedError',
    });

    expect(service._createExtHostProcess).not.toHaveBeenCalled();
    expect(service.disposeClientExtProcess).toHaveBeenCalledWith('client', false);
    expect(service.pendingExtHostClients.size).toBe(0);
  });

  it('disposes a host whose browser disconnects while fork is in flight', async () => {
    expect.hasAssertions();
    const service = createService();
    service._createExtHostProcess.mockImplementation(async (clientId: string) => {
      service.clientExtProcessMap.set(clientId, 123);
      service.maybeZombieClients.add(clientId);
    });

    await expect(service.createProcessWithCapacity('client')).rejects.toMatchObject({
      name: 'ExtensionHostClientDisconnectedError',
    });

    expect(service.disposeClientExtProcess).toHaveBeenCalledWith('client', false);
    expect(service.clientExtProcessMap.size).toBe(0);
    expect(service.pendingExtHostClients.size).toBe(0);
  });
});
