import path from 'path';

import * as fs from 'fs-extra';

import { Injector } from '@opensumi/di';
import { IHashCalculateService } from '@opensumi/ide-core-common/lib/hash-calculate/hash-calculate';
import { IExtensionStoragePathServer } from '@opensumi/ide-extension-storage/lib/common';
import { WatcherProcessManagerToken } from '@opensumi/ide-file-service/lib/node/watcher-process-manager';

import { IExtensionNodeClientService, IExtensionNodeService } from '../../src/common';
import { ExtensionNodeServiceImpl } from '../../src/node/extension.service';
import { ExtensionServiceClientImpl } from '../../src/node/extension.service.client';

import { extensionDir, getBaseInjector } from './baseInjector';

type AssertTrue<T extends true> = T;
type IsAny<T> = 0 extends 1 & T ? true : false;
type LegacyExtensionNodeService = Omit<IExtensionNodeService, 'setConnectionServiceClient'> & {
  setConnectionServiceClient(clientId: string, serviceClient: IExtensionNodeClientService): number;
};
const legacyConnectionRegistrationIsCompatible: AssertTrue<
  LegacyExtensionNodeService extends IExtensionNodeService ? true : false
> = true;
const legacyConnectionRegistrationReturnRemainsAny: AssertTrue<
  IsAny<ReturnType<IExtensionNodeService['setConnectionServiceClient']>>
> = true;

class LegacyExtensionNodeServiceImpl extends ExtensionNodeServiceImpl {
  override setConnectionServiceClient(clientId: string, serviceClient: IExtensionNodeClientService): void {
    super.setConnectionServiceClient(clientId, serviceClient);
  }
}

describe('Extension Client Serivce', () => {
  let injector: Injector;
  let extensionNodeClient: IExtensionNodeClientService;
  const testExtId = 'opensumi.ide-dark-theme';
  const testExtPath = 'opensumi.ide-dark-theme-1.13.1';
  const testExtReadme = '# IDE Dark Theme';

  beforeAll(async () => {
    injector = getBaseInjector();
    extensionNodeClient = injector.get(IExtensionNodeClientService);
  });

  describe('get all extensions', () => {
    it('should get all extension and equals dirs', async () => {
      const extensions = await extensionNodeClient.getAllExtensions([extensionDir], [], 'zh-CN', {});
      const dirs = fs.readdirSync(extensionDir);

      expect(extensions.map((e) => path.basename(e.realPath)).sort()).toEqual(dirs.sort());
      expect(extensions.length).toBe(dirs.length);
    });

    it('should get all extension and contains extraMetadata', async () => {
      const extension = await extensionNodeClient.getAllExtensions([extensionDir], [], 'zh_CN', {
        readme: './README.md',
      });
      const expectExtension = extension.find((e) => e.id === testExtId);
      expect(expectExtension?.extraMetadata.readme.trim()).toEqual(testExtReadme);
    });
  });

  describe('get extension', () => {
    it('should get first extension', async () => {
      const extension = await extensionNodeClient.getExtension(path.join(extensionDir, testExtPath), 'zh_CN', {});
      expect(path.basename(extension!.realPath)).toBe(testExtPath);
    });

    it('should get a extension and contains extraMetadata', async () => {
      const extension = await extensionNodeClient.getExtension(path.join(extensionDir, testExtPath), 'zh_CN', {
        readme: './README.md',
      });
      const readme = fs.readFileSync(path.join(extensionDir, testExtPath, 'README.md'), 'utf8').toString();

      expect(extension!.extraMetadata.readme).toBe(readme);
    });
  });

  describe('language pack', () => {
    it('should generate languagepacks.json and set VSCODE_NLS_CONFIG', async () => {
      // download languagepack extension
      const name = 'vscode-language-pack-zh-hans';
      const publisher = 'vscode-extensions';
      const version = '1.37.1';
      injector.addProviders({
        token: WatcherProcessManagerToken,
        useValue: {
          setClient: () => void 0,
        },
      });
      // make sure the workspace-storage path is exist
      const extensionStorageServer = injector.get(IExtensionStoragePathServer);
      const hashCalculateService = injector.get(IHashCalculateService);
      await hashCalculateService.initialize();
      const targetPath = path.join(extensionDir, `${publisher}.${name}-${version}`);
      const storagePath = (await extensionStorageServer.getLastStoragePath()) || '';
      const lpPath = path.join(storagePath, 'languagepacks.json');
      await extensionNodeClient.updateLanguagePack('zh-CN', targetPath, storagePath);
      expect(fs.existsSync(lpPath)).toBe(true);
      // const content = fs.readFileSync(lpPath, { encoding: 'utf8' });

      expect(process.env['VSCODE_NLS_CONFIG']).toBeDefined();
      const nlsConfig = JSON.parse(process.env['VSCODE_NLS_CONFIG']!);
      expect(nlsConfig.locale).toBe('zh-cn');
    });
  });
});

describe('ExtensionServiceClientImpl connection session', () => {
  const clientId = 'bound-client';

  function createExtensionService() {
    const releaseClient = jest.fn();
    return {
      extensionService: {
        createProcess: jest.fn().mockResolvedValue(undefined),
        disposeClientExtProcess: jest.fn().mockResolvedValue(undefined),
        ensureProcessReady: jest.fn().mockResolvedValue(true),
        getElectronMainThreadListenPath: jest.fn().mockResolvedValue('/tmp/main-thread.sock'),
        getExtProcessId: jest.fn().mockResolvedValue(123),
        setConnectionServiceClient: jest.fn(() => releaseClient),
      },
      releaseClient,
    };
  }

  it('accepts legacy connection registration implementations that return void', async () => {
    expect.hasAssertions();
    const { extensionService } = createExtensionService();
    extensionService.setConnectionServiceClient.mockReturnValue(undefined);
    const injector = new Injector([
      { token: IExtensionNodeService, useValue: extensionService },
      { token: IExtensionNodeClientService, useClass: ExtensionServiceClientImpl },
    ]);
    const facade = injector.get<ExtensionServiceClientImpl>(IExtensionNodeClientService);

    expect(legacyConnectionRegistrationIsCompatible).toBe(true);
    expect(legacyConnectionRegistrationReturnRemainsAny).toBe(true);
    expect(LegacyExtensionNodeServiceImpl.prototype.setConnectionServiceClient).toBeDefined();
    expect(() => facade.setConnectionClientId(clientId)).not.toThrow();
    await injector.disposeAll();
    expect(extensionService.setConnectionServiceClient).toHaveBeenCalledTimes(1);
  });

  it('binds once and releases the exact facade with its connection child injector', async () => {
    expect.hasAssertions();
    const { extensionService, releaseClient } = createExtensionService();
    const injector = new Injector([
      {
        token: IExtensionNodeService,
        useValue: extensionService,
      },
      {
        token: IExtensionNodeClientService,
        useClass: ExtensionServiceClientImpl,
      },
    ]);
    const facade = injector.get<ExtensionServiceClientImpl>(IExtensionNodeClientService);

    facade.setConnectionClientId(clientId);
    facade.setConnectionClientId(clientId);

    expect(extensionService.setConnectionServiceClient).toHaveBeenCalledTimes(1);
    expect(extensionService.setConnectionServiceClient).toHaveBeenCalledWith(clientId, facade);
    await injector.disposeAll();
    expect(releaseClient).toHaveBeenCalledTimes(1);
  });

  it('keeps a replacement facade registered when an older connection child is disposed', async () => {
    expect.hasAssertions();
    const extensionService = Object.create(ExtensionNodeServiceImpl.prototype) as IExtensionNodeService & {
      clientServiceMap: Map<string, IExtensionNodeClientService>;
    };
    Object.defineProperty(extensionService, 'appConfig', { value: {} });
    extensionService.clientServiceMap = new Map();
    (extensionService as any).clientExtProcessMap = new Map();
    (extensionService as any).pendingExtHostClients = new Set();
    (extensionService as any).maybeZombieClients = new Set();

    const parentInjector = new Injector([{ token: IExtensionNodeService, useValue: extensionService }]);
    const firstChild = parentInjector.createChild([
      { token: IExtensionNodeClientService, useClass: ExtensionServiceClientImpl },
    ]);
    const secondChild = parentInjector.createChild([
      { token: IExtensionNodeClientService, useClass: ExtensionServiceClientImpl },
    ]);
    const firstFacade = firstChild.get<ExtensionServiceClientImpl>(IExtensionNodeClientService);
    const secondFacade = secondChild.get<ExtensionServiceClientImpl>(IExtensionNodeClientService);

    expect(firstChild.getInstanceId(firstFacade)).toBeDefined();
    expect(secondChild.getInstanceId(secondFacade)).toBeDefined();
    firstFacade.setConnectionClientId(clientId);
    secondFacade.setConnectionClientId(clientId);
    expect(extensionService.clientServiceMap.get(clientId)).toBe(secondFacade);

    await firstChild.disposeAll();
    expect(extensionService.clientServiceMap.get(clientId)).toBe(secondFacade);

    await secondChild.disposeAll();
    expect(extensionService.clientServiceMap.has(clientId)).toBe(false);
    await parentInjector.disposeAll();
  });

  it('rolls back registration when the facade has no injector disposal identity', async () => {
    expect.hasAssertions();
    const { extensionService, releaseClient } = createExtensionService();
    const injector = new Injector([
      { token: IExtensionNodeService, useValue: extensionService },
      { token: IExtensionNodeClientService, useClass: ExtensionServiceClientImpl },
    ]);
    const facade = injector.get<ExtensionServiceClientImpl>(IExtensionNodeClientService);
    injector.instanceRefMap.delete(facade);

    expect(() => facade.setConnectionClientId(clientId)).toThrow('Extension service session lifecycle is unavailable');
    expect(extensionService.setConnectionServiceClient).toHaveBeenCalledWith(clientId, facade);
    expect(releaseClient).toHaveBeenCalledTimes(1);
    await expect(facade.pid()).rejects.toThrow('Extension service session identity is invalid');
    await injector.disposeAll();
  });

  it('rejects empty and rebound identities without leaking either identifier', () => {
    expect.hasAssertions();
    const { extensionService } = createExtensionService();
    const injector = new Injector([
      { token: IExtensionNodeService, useValue: extensionService },
      { token: IExtensionNodeClientService, useClass: ExtensionServiceClientImpl },
    ]);
    const facade = injector.get<ExtensionServiceClientImpl>(IExtensionNodeClientService);

    expect(() => facade.setConnectionClientId('   ')).toThrow('Extension service session identity is invalid');
    facade.setConnectionClientId(clientId);

    const foreignClientId = 'foreign-client-secret';
    let reboundError: Error | undefined;
    try {
      facade.setConnectionClientId(foreignClientId);
    } catch (error) {
      reboundError = error as Error;
    }
    expect(reboundError?.message).toBe('Extension service session identity is invalid');
    expect(reboundError?.message).not.toContain(clientId);
    expect(reboundError?.message).not.toContain(foreignClientId);
    expect(extensionService.setConnectionServiceClient).toHaveBeenCalledTimes(1);
  });

  it('fences process, path, pid and disposal operations to the bound identity', async () => {
    expect.hasAssertions();
    const { extensionService } = createExtensionService();
    const injector = new Injector([
      { token: IExtensionNodeService, useValue: extensionService },
      { token: IExtensionNodeClientService, useClass: ExtensionServiceClientImpl },
    ]);
    const facade = injector.get<ExtensionServiceClientImpl>(IExtensionNodeClientService);
    const options = { enableDebugExtensionHost: false };
    facade.setConnectionClientId(clientId);

    await expect(facade.pid()).resolves.toBe(123);
    await expect(facade.getElectronMainThreadListenPath(clientId)).resolves.toBe('/tmp/main-thread.sock');
    await facade.createProcess(clientId, options);
    await facade.disposeClientExtProcess(clientId, false);

    expect(extensionService.getExtProcessId).toHaveBeenCalledWith(clientId);
    expect(extensionService.getElectronMainThreadListenPath).toHaveBeenCalledWith(clientId);
    expect(extensionService.createProcess).toHaveBeenCalledWith(clientId, options);
    expect(extensionService.ensureProcessReady).toHaveBeenCalledWith(clientId);
    expect(extensionService.disposeClientExtProcess).toHaveBeenCalledWith(clientId, false);

    const foreignClientId = 'foreign-client-secret';
    await expect(facade.getElectronMainThreadListenPath(foreignClientId)).rejects.toThrow(
      'Extension service session identity is invalid',
    );
    await expect(facade.createProcess(foreignClientId, options)).rejects.toThrow(
      'Extension service session identity is invalid',
    );
    await expect(facade.disposeClientExtProcess(foreignClientId, false)).rejects.toThrow(
      'Extension service session identity is invalid',
    );
    expect(extensionService.getElectronMainThreadListenPath).toHaveBeenCalledTimes(1);
    expect(extensionService.createProcess).toHaveBeenCalledTimes(1);
    expect(extensionService.ensureProcessReady).toHaveBeenCalledTimes(1);
    expect(extensionService.disposeClientExtProcess).toHaveBeenCalledTimes(1);
  });

  it('keeps session helpers off the reflected RPC prototype surface', () => {
    expect.hasAssertions();
    const methods = Object.getOwnPropertyNames(ExtensionServiceClientImpl.prototype)
      .filter(
        (name) =>
          typeof Object.getOwnPropertyDescriptor(ExtensionServiceClientImpl.prototype, name)?.value === 'function',
      )
      .sort();

    expect(methods).toEqual([
      'constructor',
      'convertLanguagePack',
      'createProcess',
      'disposeClientExtProcess',
      'getAllExtensions',
      'getElectronMainThreadListenPath',
      'getExtension',
      'getLanguagePack',
      'getOpenVSXRegistry',
      'infoProcessCrash',
      'infoProcessNotExist',
      'pid',
      'restartExtProcessByClient',
      'setConnectionClientId',
      'setupNLSConfig',
      'updateLanguagePack',
    ]);
  });
});
