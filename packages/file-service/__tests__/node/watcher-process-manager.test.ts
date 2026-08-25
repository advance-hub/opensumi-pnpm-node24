import path from 'path';

import { WatcherProcessManagerImpl } from '../../src/node/watcher-process-manager';

const createManager = (watcherHost?: string, watcherHostForkOptions?: Record<string, unknown>) => {
  const manager = Object.create(WatcherProcessManagerImpl.prototype) as WatcherProcessManagerImpl;
  Object.defineProperty(manager, 'appConfig', {
    value: { watcherHost, watcherHostForkOptions },
  });
  return manager;
};

describe('WatcherProcessManagerImpl', () => {
  const originalExtMode = process.env.EXT_MODE;
  const originalExecArgv = process.execArgv.slice();

  afterEach(() => {
    if (originalExtMode === undefined) {
      delete process.env.EXT_MODE;
    } else {
      process.env.EXT_MODE = originalExtMode;
    }
    process.execArgv.splice(0, process.execArgv.length, ...originalExecArgv);
  });

  it('uses source watcher host in js mode when configured host is the default built host', () => {
    expect.hasAssertions();
    process.env.EXT_MODE = 'js';
    const defaultBuiltWatcherHost = path.join(__dirname, '../../lib/node/hosted/watcher.process.js');
    const manager = createManager(defaultBuiltWatcherHost);

    expect(manager.watcherHost).toContain('packages/file-service/src/node/hosted/watcher.process.ts');
  });

  it('keeps custom configured watcher host in js mode', () => {
    expect.hasAssertions();
    process.env.EXT_MODE = 'js';
    const customWatcherHost = path.join(__dirname, 'custom-watcher.process.js');
    const manager = createManager(customWatcherHost);

    expect(manager.watcherHost).toBe(customWatcherHost);
  });

  it('keeps configured watcher host outside js mode', () => {
    expect.hasAssertions();
    delete process.env.EXT_MODE;
    const defaultBuiltWatcherHost = path.join(__dirname, '../../lib/node/hosted/watcher.process.js');
    const manager = createManager(defaultBuiltWatcherHost);

    expect(manager.watcherHost).toBe(defaultBuiltWatcherHost);
  });

  it('starts js-mode watcher process with clean transpile-only ts-node hooks', () => {
    expect.hasAssertions();
    process.env.EXT_MODE = 'js';
    process.execArgv.splice(
      0,
      process.execArgv.length,
      '--require',
      'ts-node/register',
      '--require',
      'source-map-support/register',
      '--inspect=9999',
    );

    const execArgv = (createManager() as any).getWatcherProcessExecArgv();

    expect(execArgv).toEqual([
      '--require',
      'ts-node/register/transpile-only',
      '--require',
      'tsconfig-paths/register',
      '--require',
      'source-map-support/register',
    ]);
  });

  it('gives the watcher process an independent heap limit', () => {
    expect.hasAssertions();
    process.env.EXT_MODE = 'js';
    process.execArgv.splice(0, process.execArgv.length, '--max-old-space-size=512');
    const manager = createManager(undefined, {
      execArgv: ['--max-old-space-size=256'],
    });

    const options = (manager as any).getWatcherProcessForkOptions();

    expect(options.execArgv).toContain('--max-old-space-size=256');
    expect(options.execArgv).not.toContain('--max-old-space-size=512');
    expect(options.silent).toBe(true);
  });
});
