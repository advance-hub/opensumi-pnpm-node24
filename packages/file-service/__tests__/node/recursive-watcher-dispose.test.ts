import path from 'node:path';

import * as fse from 'fs-extra';
import temp from 'temp';

import { DisposableCollection, FileUri } from '@opensumi/ide-core-common';
import { ILogServiceManager } from '@opensumi/ide-core-common/lib/log';
import { createNodeInjector } from '@opensumi/ide-dev-tool/src/mock-injector';

import { RecursiveFileSystemWatcher } from '../../src/node/hosted/recursive/file-service-watcher';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

class TestRecursiveFileSystemWatcher extends RecursiveFileSystemWatcher {
  public readonly startDeferred = createDeferred<DisposableCollection>();

  protected async start(): Promise<DisposableCollection> {
    return this.startDeferred.promise;
  }
}

describe('RecursiveFileSystemWatcher dispose', () => {
  const track = temp.track();

  const createLogger = () => {
    const injector = createNodeInjector([]);
    return injector.get(ILogServiceManager).getLogger();
  };

  afterAll(() => {
    track.cleanupSync();
  });

  it('rejects watch requests after dispose', async () => {
    expect.assertions(1);
    const watcher = new RecursiveFileSystemWatcher([], createLogger());
    watcher.dispose();

    await expect(watcher.watchFileChanges(FileUri.create('/tmp/recursive-disposed').toString())).rejects.toThrow(
      /disposed/,
    );
  });

  it('cleans up when disposed while starting', async () => {
    expect.assertions(3);
    const root = FileUri.create(fse.realpathSync(await temp.mkdir('recursive-dispose-test')));
    const watcher = new TestRecursiveFileSystemWatcher([], createLogger());

    const watchPromise = watcher.watchFileChanges(root.toString());

    watcher.dispose();
    watcher.startDeferred.resolve(new DisposableCollection());

    await expect(watchPromise).rejects.toThrow(/disposed while starting/);

    const handlers = (watcher as any).WATCHER_HANDLERS as Map<string, unknown>;
    const watchPathMap = (watcher as any).watchPathMap as Map<string, unknown>;
    expect(handlers.size).toBe(0);
    expect(watchPathMap.size).toBe(0);
  });

  it('maps native events from a resolved path back to the path requested by the workspace', () => {
    expect.assertions(3);
    const watcher = new RecursiveFileSystemWatcher([], createLogger());
    const watchPathMap = (watcher as any).watchPathMap as Map<string, string>;
    const root = path.parse(process.cwd()).root;
    const requestedRoot = path.join(root, 'requested', 'workspace');
    const requestedNestedRoot = path.join(root, 'alternate-request', 'nested');
    const resolvedRoot = path.join(root, 'resolved', 'workspace');
    const resolvedNestedRoot = path.join(resolvedRoot, 'nested');
    watchPathMap.set(requestedRoot, resolvedRoot);
    watchPathMap.set(requestedNestedRoot, resolvedNestedRoot);

    expect((watcher as any).mapEventPathToRequestedPath(path.join(resolvedRoot, 'file.txt'))).toBe(
      path.join(requestedRoot, 'file.txt'),
    );
    expect((watcher as any).mapEventPathToRequestedPath(path.join(resolvedNestedRoot, 'file.txt'))).toBe(
      path.join(requestedNestedRoot, 'file.txt'),
    );
    const unrelatedPath = path.join(root, 'unrelated', 'file.txt');
    expect((watcher as any).mapEventPathToRequestedPath(unrelatedPath)).toBe(unrelatedPath);
  });
});
