import http from 'http';
import path from 'path';

import Koa from 'koa';
import fetch from 'node-fetch';

import { Injector } from '@opensumi/di';
import { AppConfig, IServerApp } from '@opensumi/ide-core-node';
import { createNodeInjector } from '@opensumi/ide-dev-tool/src/mock-injector';

import { ExpressFileServerModule } from '../../src/node';
import { ExpressFileServerContribution } from '../../src/node/express-file-server.contribution';

describe('template test', () => {
  let server: http.Server;
  let injector: Injector;
  const resPath = path.join(__dirname, '../res');
  beforeAll(() => {
    injector = createNodeInjector([ExpressFileServerModule]);

    injector.overrideProviders({
      token: AppConfig,
      useValue: {
        marketplace: {},
        staticAllowPath: [resPath],
      },
    });

    const app = new Koa();
    const expressFileServerContribution = injector.get<ExpressFileServerContribution>(ExpressFileServerContribution);
    const mockServerApp: IServerApp = {
      use: app.use.bind(app),
      async start() {
        // 空实现
      },
    };

    expressFileServerContribution.initialize(mockServerApp);
    server = app.listen(50118);
  });

  it('can get png if path in whitelist', async () => {
    expect.assertions(1);
    const res = await fetch(`http://0.0.0.0:50118/assets${path.join(resPath, 'icon.png')}`);
    expect(res.status).toBe(200);
    await res.arrayBuffer();
  });

  it.each(['worker.cjs', 'worker.mjs'])('serves %s Worker entry modules as JavaScript', async (fileName) => {
    expect.assertions(2);
    const res = await fetch(`http://0.0.0.0:50118/assets${path.join(resPath, fileName)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/javascript');
    await res.arrayBuffer();
  });

  it('response 403 if not in whitelist', async () => {
    expect.assertions(1);
    const res = await fetch('http://0.0.0.0:50118/assets/test');
    expect(res.status).toBe(403);
    await res.arrayBuffer();
  });

  it('response 403 if not allowed mime', async () => {
    expect.assertions(1);
    const res = await fetch(`http://0.0.0.0:50118/assets${path.join(resPath, 'icon.exe')}`);
    expect(res.status).toBe(403);
    await res.arrayBuffer();
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await injector.disposeAll();
  });
});
