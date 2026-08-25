import { Injector, Provider } from '@opensumi/di';
import { ExpressFileServerModule } from '@opensumi/ide-express-file-server/lib/node';
import { OpenerModule } from '@opensumi/ide-remote-opener/lib/node';
import { CommonNodeModules } from '@opensumi/ide-startup/lib/node/common-modules';
import { PtyServiceManagerToken } from '@opensumi/ide-terminal-next/lib/node/pty.manager';
import {
  PtyServiceManagerRemote,
  PtyServiceManagerRemoteOptions,
} from '@opensumi/ide-terminal-next/lib/node/pty.manager.remote';

import { startServer } from './start-server';

const injectorProviders: Provider[] = [];

if (process.env.PTY_PROXY_SOCK || process.env.PTY_PROXY_PORT) {
  injectorProviders.push(
    {
      token: PtyServiceManagerToken,
      useClass: PtyServiceManagerRemote,
    },
    {
      token: PtyServiceManagerRemoteOptions,
      useValue: {
        socketConnectOpts: process.env.PTY_PROXY_SOCK
          ? { path: process.env.PTY_PROXY_SOCK }
          : {
              port: Number(process.env.PTY_PROXY_PORT),
              host: process.env.PTY_PROXY_HOST,
            },
      },
    },
  );
}

const injector = new Injector(injectorProviders);

async function main() {
  const modules = [...CommonNodeModules, ExpressFileServerModule, OpenerModule];
  if (process.env.ENABLE_AI === '1') {
    const { AINodeModules } = await import('@opensumi/ide-startup/lib/node/ai-modules.js');
    modules.push(...AINodeModules);
  }
  if (process.env.ENABLE_COLLABORATION === '1') {
    const { CollaborationModule } = await import('@opensumi/ide-collaboration/lib/node/index.js');
    modules.push(CollaborationModule);
  }

  await startServer({
    modules,
    injector,
  });
}

void main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Failed to start OpenSumi Node server', error);
  process.exitCode = 1;
});
