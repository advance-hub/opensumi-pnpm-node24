import path from 'path';

import * as fs from 'fs-extra';
import temp from 'temp';

import { WSChannelHandler } from '@opensumi/ide-connection/lib/browser';
import { AppConfig } from '@opensumi/ide-core-browser';
import {
  FileUri,
  IFileServiceClient,
  ILogger,
  ILoggerManagerClient,
  StoragePaths,
  URI,
} from '@opensumi/ide-core-common';
import { IHashCalculateService } from '@opensumi/ide-core-common/lib/hash-calculate/hash-calculate';
import { createBrowserInjector } from '@opensumi/ide-dev-tool/src/injector-helper';
import { MockInjector } from '@opensumi/ide-dev-tool/src/mock-injector';
import { IExtensionStoragePathServer, IExtensionStorageServer } from '@opensumi/ide-extension-storage';
import { FileStat, FileSystemError, IDiskFileProvider } from '@opensumi/ide-file-service';
import { FileServiceClient } from '@opensumi/ide-file-service/lib/browser/file-service-client';
import { DiskFileSystemProvider } from '@opensumi/ide-file-service/lib/node/disk-file-system.provider';
import { WatcherProcessManagerToken } from '@opensumi/ide-file-service/lib/node/watcher-process-manager';

import { ExtensionStorageModule } from '../../src/browser';

process.on('unhandledRejection', (reason) => {
  // eslint-disable-next-line no-console
  console.error(reason);
});

describe('Extension Storage Server -- Setup directory should be worked', () => {
  let injector: MockInjector;
  let root: URI;
  const track = temp.track();

  const initializeInjector = async () => {
    injector = createBrowserInjector([ExtensionStorageModule]);

    injector.addProviders(
      {
        token: AppConfig,
        useValue: {},
      },
      {
        token: IFileServiceClient,
        useClass: FileServiceClient,
      },
      {
        token: IDiskFileProvider,
        useClass: DiskFileSystemProvider,
      },
      {
        token: WSChannelHandler,
        useValue: {
          clientId: 'test_client_id',
        },
      },
      {
        token: WatcherProcessManagerToken,
        useValue: {
          setClient: () => void 0,
          watch: (() => 1) as any,
          unWatch: () => void 0,
          createProcess: () => void 0,
          setWatcherFileExcludes: () => void 0,
        },
      },
    );
    const hashImpl = injector.get(IHashCalculateService) as IHashCalculateService;
    await hashImpl.initialize();
    const fileServiceClient: FileServiceClient = injector.get(IFileServiceClient);
    fileServiceClient.registerProvider('file', injector.get(IDiskFileProvider));
  };

  beforeEach(() => {
    root = FileUri.create(fs.realpathSync(temp.mkdirSync('extension-storage-test')));

    return initializeInjector();
  });

  afterEach(async () => {
    track.cleanupSync();
    await injector.disposeAll();
  });

  it('Extension Path Server should setup directory correctly', async () => {
    const extensionStorage = injector.get(IExtensionStorageServer);
    const rootFileStat = {
      uri: root.toString(),
      isDirectory: true,
      lastModification: 0,
    } as FileStat;
    const extensionStorageDirName = '.extensionStorageDirName';
    injector.mock(ILoggerManagerClient, 'getLogFolder', () => root.path.toString());
    injector.mock(IExtensionStoragePathServer, 'getUserHomeDir', async () => root.path.toString());
    await extensionStorage.init(rootFileStat, [rootFileStat], extensionStorageDirName);
    expect(fs.existsSync(path.join(root.path.toString(), extensionStorageDirName))).toBeTruthy();
    expect(
      fs.existsSync(
        path.join(root.path.toString(), extensionStorageDirName, StoragePaths.EXTENSIONS_GLOBAL_STORAGE_DIR),
      ),
    ).toBeTruthy();
    expect(
      fs.existsSync(
        path.join(root.path.toString(), extensionStorageDirName, StoragePaths.EXTENSIONS_WORKSPACE_STORAGE_DIR),
      ),
    ).toBeTruthy();
  });
});

describe('Extension Storage Server -- Data operation should be worked', () => {
  let injector: MockInjector;
  let root: URI;
  let extensionStorage: IExtensionStorageServer;
  const track = temp.track();

  const initializeInjector = async () => {
    injector = createBrowserInjector([ExtensionStorageModule]);

    injector.addProviders(
      {
        token: AppConfig,
        useValue: {},
      },
      {
        token: IFileServiceClient,
        useClass: FileServiceClient,
      },
      {
        token: IDiskFileProvider,
        useClass: DiskFileSystemProvider,
      },
      {
        token: WSChannelHandler,
        useValue: {
          clientId: 'test_client_id',
        },
      },
      {
        token: WatcherProcessManagerToken,
        useValue: {
          setClient: () => void 0,
          watch: (() => 1) as any,
          unWatch: () => void 0,
          createProcess: () => void 0,
          setWatcherFileExcludes: () => void 0,
        },
      },
    );

    const fileServiceClient: FileServiceClient = injector.get(IFileServiceClient);
    fileServiceClient.registerProvider('file', injector.get(IDiskFileProvider));
    const hashImpl = injector.get(IHashCalculateService) as IHashCalculateService;
    await hashImpl.initialize();
  };

  beforeEach(async () => {
    root = FileUri.create(fs.realpathSync(temp.mkdirSync('extension-storage-test')));

    await initializeInjector();

    extensionStorage = injector.get(IExtensionStorageServer);
    const rootFileStat = {
      uri: root.toString(),
      isDirectory: true,
      lastModification: 0,
    } as FileStat;
    const extensionStorageDirName = '.extensionStorageDirName';
    injector.mock(ILoggerManagerClient, 'getLogFolder', () => root.path.toString());
    injector.mock(IExtensionStoragePathServer, 'getUserHomeDir', async () => root.path.toString());
    await extensionStorage.init(rootFileStat, [rootFileStat], extensionStorageDirName);
  });

  afterEach(async () => {
    track.cleanupSync();
    await injector.disposeAll();
  });

  it('Global -- set value can be work', async () => {
    const loggerError = jest.spyOn(injector.get(ILogger), 'error');
    const isGlobal = true;
    const key = 'test';
    const value = {
      hello: 'world',
    };
    const data = {};
    data[key] = value;
    await extensionStorage.set(key, value, isGlobal);
    expect(await extensionStorage.get(key, isGlobal)).toEqual(value);
    expect(await extensionStorage.getAll(isGlobal)).toEqual(data);
    expect(loggerError).not.toHaveBeenCalled();
  });

  it('Workspace -- set value can be work', async () => {
    const isGlobal = false;
    const key = 'test';
    const value = {
      hello: 'world',
    };
    const data = {};
    data[key] = value;
    await extensionStorage.set(key, value, isGlobal);
    expect(await extensionStorage.get(key, isGlobal)).toEqual(value);
    expect(await extensionStorage.getAll(isGlobal)).toEqual(data);
  });

  it('Global -- stale concurrent write should merge the latest data and retry', async () => {
    const fileServiceClient = injector.get(IFileServiceClient);
    const setContent = fileServiceClient.setContent.bind(fileServiceClient);
    const peerValue = { from: 'peer-session' };
    let conflictInjected = false;
    const setContentSpy = jest
      .spyOn(fileServiceClient, 'setContent')
      .mockImplementation(async (file, content, options) => {
        if (!conflictInjected) {
          conflictInjected = true;
          await setContent(file, JSON.stringify({ peer: peerValue }), options);
          throw FileSystemError.FileIsOutOfSync(file.uri);
        }
        return setContent(file, content, options);
      });

    const ownValue = { from: 'current-session' };
    await extensionStorage.set('own', ownValue, true);

    expect(setContentSpy).toHaveBeenCalledTimes(2);
    expect(await extensionStorage.getAll(true)).toEqual({ peer: peerValue, own: ownValue });
  });

  it('Global -- non-conflict write errors should not retry', async () => {
    const fileServiceClient = injector.get(IFileServiceClient);
    const setContentSpy = jest.spyOn(fileServiceClient, 'setContent').mockRejectedValue(new Error('write failed'));

    await expect(extensionStorage.set('test', { value: true }, true)).rejects.toThrow('write failed');
    expect(setContentSpy).toHaveBeenCalledTimes(1);
  });
});
