import path from 'path';

import { ProxyIdentifier } from '@opensumi/ide-connection';
import { Deferred, ILoggerManagerClient, IReporter } from '@opensumi/ide-core-common';
import { REPORT_NAME } from '@opensumi/ide-core-common';
import { AppConfig, DefaultReporter } from '@opensumi/ide-core-node';

import { createBrowserInjector } from '../../../../../../tools/dev-tool/src/injector-helper';
import { MockInjector } from '../../../../../../tools/dev-tool/src/mock-injector';
import { MainThreadExtensionLog } from '../../../../__mocks__/api/mainthread.extension.log';
import { MainThreadExtensionService } from '../../../../__mocks__/api/mainthread.extension.service';
import { MainThreadStorage } from '../../../../__mocks__/api/mathread.storage';
import { mockExtensionProps, mockExtensionProps2 } from '../../../../__mocks__/extensions';
import { createMockPairRPCProtocol } from '../../../../__mocks__/initRPCProtocol';
import { ExtHostAppConfig } from '../../../../src/common/ext.process';
import { ExtHostAPIIdentifier, IExtHostLocalization } from '../../../../src/common/vscode';
import ExtensionHostServiceImpl from '../../../../src/hosted/ext.host';

describe('Extension process test', () => {
  describe('RPCProtocol', () => {
    const proxyMaps = new Map();
    let extHostImpl: ExtensionHostServiceImpl;
    let injector: MockInjector;
    let mainThreadExtensionService: MainThreadExtensionService;

    beforeEach(async () => {
      injector = createBrowserInjector([]);
      injector.addProviders(
        {
          token: ExtHostAppConfig,
          useValue: {
            builtinCommands: [
              {
                id: 'test:builtinCommand:test',
                handler: () => 'fake token',
              },
            ],
          },
        },
        {
          token: IReporter,
          useClass: DefaultReporter,
        },
      );

      const { rpcProtocolExt, rpcProtocolMain } = createMockPairRPCProtocol();
      mainThreadExtensionService = new MainThreadExtensionService();
      rpcProtocolExt.set(ProxyIdentifier.for('MainThreadExtensionService'), mainThreadExtensionService);
      rpcProtocolExt.set(ProxyIdentifier.for('MainThreadStorage'), new MainThreadStorage());
      rpcProtocolExt.set(ProxyIdentifier.for('MainThreadExtensionLog'), new MainThreadExtensionLog());

      extHostImpl = new ExtensionHostServiceImpl(
        rpcProtocolMain,
        injector.get(ILoggerManagerClient).getLogger(),
        injector,
      );

      const localization = rpcProtocolMain.get<IExtHostLocalization>(ExtHostAPIIdentifier.ExtHostLocalization);
      localization.$setCurrentLanguage('en');
      await extHostImpl.init();
      await extHostImpl.$updateExtHostData();
    });

    afterEach(async () => {
      await injector.disposeAll();
      proxyMaps.clear();
    });

    it('should init extensions', async () => {
      await extHostImpl.$updateExtHostData();
      const extensions = extHostImpl.$getExtensions();
      const ext = extHostImpl.getExtension(mockExtensionProps.id);
      expect(extensions[0].id).toBe(mockExtensionProps.id);
      expect(extensions[1].id).toBe(mockExtensionProps2.id);
      expect(ext?.id).toBe(mockExtensionProps.id);
    });

    it('should activate extension', async () => {
      const id = mockExtensionProps.id;
      try {
        await extHostImpl.$activateExtension(id);
      } catch (err) {
        // expected error
      }
      expect(extHostImpl.isActivated(id)).toBe(true);
      expect(extHostImpl.getExtendExports(id)).toEqual({});
      expect(extHostImpl.getExtensionExports(id)).toEqual({});
    });

    it('coalesces concurrent activation requests and releases the in-flight reference', async () => {
      expect.assertions(4);
      const activation = new Deferred<void>();
      const doActivateExtension = jest
        .spyOn(extHostImpl as any, 'doActivateExtension')
        .mockReturnValueOnce(activation.promise)
        .mockResolvedValueOnce(undefined);

      const first = extHostImpl.activateExtension(mockExtensionProps.id);
      const second = extHostImpl.activateExtension(mockExtensionProps.id);

      expect(doActivateExtension).toHaveBeenCalledTimes(1);
      expect((extHostImpl as any).activatingExtensions.size).toBe(1);
      activation.resolve();
      await Promise.all([first, second]);
      expect((extHostImpl as any).activatingExtensions.size).toBe(0);

      await extHostImpl.activateExtension(mockExtensionProps.id);
      expect(doActivateExtension).toHaveBeenCalledTimes(2);
      doActivateExtension.mockRestore();
    });

    it('waits for an in-flight activation before releasing a stale extension', async () => {
      expect.assertions(2);
      const activation = new Deferred<void>();
      const doActivateExtension = jest
        .spyOn(extHostImpl as any, 'doActivateExtension')
        .mockReturnValueOnce(activation.promise);
      const deactivateExtension = jest.spyOn(extHostImpl.extensionsActivator, 'deactivateExtension');

      const activating = extHostImpl.activateExtension(mockExtensionProps.id);
      const releasing = (extHostImpl as any).releaseStaleExtensions(
        extHostImpl.$getExtensions().filter((extension) => extension.id !== mockExtensionProps.id),
      );
      await Promise.resolve();
      expect(deactivateExtension).not.toHaveBeenCalled();

      activation.resolve();
      await Promise.all([activating, releasing]);
      expect(deactivateExtension).toHaveBeenCalledWith(mockExtensionProps.id);
      doActivateExtension.mockRestore();
      deactivateExtension.mockRestore();
    });

    it('releases an activated extension when it is removed from host data', async () => {
      expect.hasAssertions();
      const id = mockExtensionProps.id;
      const cachedModulePath = path.join(mockExtensionProps.realPath, 'index.js');
      require.cache[cachedModulePath] = { id: cachedModulePath } as NodeJS.Module;
      try {
        await extHostImpl.$activateExtension(id);
      } catch {
        // The mock extension may not expose every production API, but it is
        // still retained by the activator after the attempted activation.
      }
      expect(extHostImpl.isActivated(id)).toBe(true);

      mainThreadExtensionService.extensions = [mockExtensionProps2];
      await extHostImpl.$updateExtHostData();

      expect(extHostImpl.isActivated(id)).toBe(false);
      expect(extHostImpl.getExtension(id)).toBeUndefined();
      expect(require.cache[cachedModulePath]).toBeUndefined();
    });

    it('runs extension deactivation during graceful host close', async () => {
      expect.assertions(2);
      const activation = new Deferred<void>();
      (extHostImpl as any).activatingExtensions.set(mockExtensionProps.id, activation.promise);
      const deactivate = jest.spyOn(extHostImpl.extensionsActivator, 'deactivate').mockResolvedValue([]);

      const closing = extHostImpl.close();
      await Promise.resolve();
      expect(deactivate).not.toHaveBeenCalled();
      activation.resolve();
      await closing;

      expect(deactivate).toHaveBeenCalledTimes(1);
    });

    it('should caught runtime error', async () => {
      expect.assertions(3);
      const defered = new Deferred();

      const id = mockExtensionProps2.id;
      const reporter = injector.get(IReporter);
      jest.spyOn(reporter, 'point').mockImplementation((msg: string, data: any) => {
        if (msg === REPORT_NAME.RUNTIME_ERROR_EXTENSION) {
          expect(typeof data.extra.error).toBeTruthy();
          expect(data.extra.stackTraceMessage).toMatch(/Test caught exception/);
          defered.resolve();
        }
      });

      await expect(async () => {
        await extHostImpl.$activateExtension(id);
      }).rejects.toThrow('Test caught exception');
      await defered.promise;
    });

    it('should caught runtime unexpected error', (done) => {
      const reporter = injector.get(IReporter);

      jest.spyOn(extHostImpl as any, 'findExtension').mockImplementation(() => mockExtensionProps2);
      jest.spyOn(reporter, 'point').mockImplementation((msg: string, data: any) => {
        if (msg === REPORT_NAME.RUNTIME_ERROR_EXTENSION) {
          expect(typeof data.extra.error).toBeTruthy();
          expect(data.extra.stackTraceMessage).toMatch(/This is unexpected error/);
          done();
        }
      });
      extHostImpl.reportUnexpectedError(new Error('This is unexpected error'));
    });
  });
});
