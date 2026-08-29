import WebSocket from 'ws';

import { Uri } from '@opensumi/ide-core-common';

import { ITerminalController, TerminalOptions } from '../../src/common';

import { injector } from './inject';
import { closeTestServers, createProxyServer, createWsServer, resetPort } from './proxy';

describe('Terminal Controller', () => {
  let controller: ITerminalController;
  let proxy;
  let ws: WebSocket.Server;

  beforeAll(() => {
    // FIXME: happy test
    resetPort();
    ws = createWsServer();
    proxy = createProxyServer();
    controller = injector.get(ITerminalController);
    controller.initContextKey(document.createElement('div'));
  });

  afterAll(async () => {
    controller.dispose();
    await closeTestServers(ws, proxy);
  });

  it('Recovery', async () => {
    await controller.recovery({ groups: [[]], current: undefined });
  });

  it('Controller Initialize', async () => {
    await controller.firstInitialize();
  });
  it('create terminal by profile', async () => {
    const client = await controller.createTerminal({
      config: {
        profileName: 'bash',
        path: 'bash',
        isDefault: false,
      },
    });
    await client.attached.promise;
  });
  it('create terminal by launchConfig', async () => {
    const id = 'test-id';
    const client = await controller.createTerminal({
      id,
    });
    await client.attached.promise;
    expect(client.id).toEqual(id);
  });
  it('can transform terminal options', async () => {
    const terminalOptions = {
      name: 'name',
      shellPath: 'shellPath',
      shellArgs: ['123'],
      cwd: 'cwd',
      env: {
        asd: 'asd',
      },
      iconPath: Uri.file('iconPath'),
      color: { id: '#fff' },
      strictEnv: true,
      hideFromUser: true,
      isExtensionTerminal: true,
      isTransient: true,
    } as TerminalOptions;

    const launchConfig = controller.convertTerminalOptionsToLaunchConfig(terminalOptions);
    expect(launchConfig.name).toEqual(terminalOptions.name);
    expect(launchConfig.executable).toEqual(terminalOptions.shellPath);
    expect(launchConfig.args).toEqual(terminalOptions.shellArgs);
    expect(launchConfig.cwd).toEqual(terminalOptions.cwd);
    expect(launchConfig.env).toEqual(terminalOptions.env);
    expect(launchConfig.icon).toEqual(terminalOptions.iconPath);
    expect(launchConfig.color).toEqual((terminalOptions.color as any).id);
    expect(launchConfig.initialText).toEqual(terminalOptions.message);
    expect(launchConfig.strictEnv).toEqual(terminalOptions.strictEnv);
    expect(launchConfig.hideFromUser).toEqual(terminalOptions.hideFromUser);
    expect(launchConfig.isExtensionOwnedTerminal).toEqual(terminalOptions.isExtensionTerminal);
    expect(launchConfig.disablePersistence).toEqual(terminalOptions.isTransient);
  });
});
