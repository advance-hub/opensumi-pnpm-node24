import path from 'path';

import { IExtensionHostManager } from '../../src';
import { ExtensionHostManager } from '../../src/node/extension.host.manager';

import { extensionHostManagerTester } from './extension.host.manager.common-tester';

extensionHostManagerTester({
  name: 'ext host manager',
  providers: [
    {
      token: IExtensionHostManager,
      useClass: ExtensionHostManager,
    },
  ],
  init: () => {
    // noop
  },
  dispose: () => {
    // noop
  },
});

describe('ExtensionHostManager resource cleanup', () => {
  it('refuses to fork beyond the managed process hard limit', async () => {
    expect.hasAssertions();
    const manager = new ExtensionHostManager();
    const extHostPath = path.join(__dirname, '../../__mocks__/ext.host.js');
    (manager as any).maxProcessCount = 1;
    manager.fork(extHostPath, [], { silent: true });

    expect(() => manager.fork(extHostPath, [], { silent: true })).toThrow(
      'Managed extension child process limit (1) reached',
    );
    expect((manager as any).processMap.size).toBe(1);
    await manager.dispose();
  });

  it('drops process and listener references after a child exits', async () => {
    expect.hasAssertions();
    const manager = new ExtensionHostManager();
    const extHostPath = path.join(__dirname, '../../__mocks__/ext.host.js');
    const pid = manager.fork(extHostPath, [], { silent: true });
    manager.onOutput(pid, () => undefined);
    manager.onMessage(pid, () => undefined);
    const exited = new Promise<void>((resolve) => manager.onExit(pid, () => resolve()));

    manager.kill(pid, 'SIGTERM');
    await exited;

    expect((manager as any).processMap.size).toBe(0);
    expect((manager as any).processDisposables.size).toBe(0);
    await manager.dispose();
  });
});
