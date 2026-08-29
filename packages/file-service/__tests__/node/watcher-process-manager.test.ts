import path from 'path';

import { WatcherProcessManagerImpl, normalizeWorkspaceAgentChangeUri } from '../../src/node/watcher-process-manager';

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

  it('canonicalizes Windows file URIs emitted by the Go watcher', () => {
    expect.assertions(1);
    expect(normalizeWorkspaceAgentChangeUri('file:///C:/Users/RUNNER~1/AppData/Local/Temp/watch-proof.txt')).toBe(
      'file:///c%3A/Users/RUNNER~1/AppData/Local/Temp/watch-proof.txt',
    );
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

  it('releases connection watch streams without stopping the server-scoped agent', async () => {
    expect.hasAssertions();
    const manager = createManager() as any;
    const disposeStream = jest.fn();
    const disposeAgent = jest.fn();
    manager.workspaceAgentWatches = new Map([[1, { generation: 0, handle: { dispose: disposeStream } }]]);
    Object.defineProperty(manager, 'workspaceAgent', { value: { dispose: disposeAgent } });
    manager.logger = { debug: jest.fn() };
    manager.watcherRuntime = 'agent';
    manager.closeWatcherServers = jest.fn().mockResolvedValue(undefined);
    manager.stopWatcherProcess = jest.fn().mockResolvedValue(undefined);

    await manager.dispose();

    expect(disposeStream).toHaveBeenCalledTimes(1);
    expect(disposeAgent).not.toHaveBeenCalled();
    expect(manager.workspaceAgentWatches.size).toBe(0);
  });
});
