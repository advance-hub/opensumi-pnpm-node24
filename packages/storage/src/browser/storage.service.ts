import { Autowired, Injectable } from '@opensumi/di';
import { Deferred, Emitter, Event, ILogger, STORAGE_SCHEMA, URI, path } from '@opensumi/ide-core-common';
import { FileSystemError, IFileServiceClient } from '@opensumi/ide-file-service';

import { IStoragePathServer, IStorageServer, IUpdateRequest, StorageChange, StringKeyToAnyValue } from '../common';

const { Path } = path;

@Injectable()
export abstract class StorageServer implements IStorageServer {
  private static readonly UPDATE_RETRY_LIMIT = 10;

  @Autowired(IFileServiceClient)
  protected readonly fileSystem: IFileServiceClient;

  private storageExistPromises: Map<string, Promise<boolean>> = new Map();

  @Autowired(IStoragePathServer)
  protected readonly dataStoragePathServer: IStoragePathServer;

  @Autowired(ILogger)
  protected readonly logger: ILogger;

  abstract deferredStorageDirPath: Deferred<string | undefined>;
  abstract databaseStorageDirPath: string | undefined;

  public _cache: any = {};

  public onDidChangeEmitter = new Emitter<StorageChange>();
  readonly onDidChange: Event<StorageChange> = this.onDidChangeEmitter.event;

  abstract init(storageDirName?: string, workspaceNamespace?: string): Promise<string | undefined>;
  abstract getItems(storageName: string): Promise<StringKeyToAnyValue>;
  abstract updateItems(storageName: string, request: IUpdateRequest): Promise<void>;

  async close(recovery?: () => Map<string, string>) {
    // do nothing
  }

  protected async asAccess(storagePath: string, force?: boolean) {
    if (force) {
      return await this.fileSystem.access(storagePath);
    }
    if (!this.storageExistPromises.has(storagePath)) {
      const promise = this.fileSystem.access(storagePath);
      this.storageExistPromises.set(storagePath, promise);
    }
    return await this.storageExistPromises.get(storagePath);
  }

  async setupDirectories(scope: string, storageDirName?: string) {
    if (!this.deferredStorageDirPath) {
      this.deferredStorageDirPath = new Deferred<string | undefined>();
      let fn;
      if (scope === STORAGE_SCHEMA.GLOBAL) {
        fn = this.dataStoragePathServer.provideGlobalStorageDirPath;
      } else {
        fn = this.dataStoragePathServer.provideWorkspaceStorageDirPath;
      }
      const storagePath = await fn.apply(this.dataStoragePathServer, [storageDirName]);
      this.deferredStorageDirPath.resolve(storagePath);
      this.databaseStorageDirPath = storagePath;
      return storagePath;
    }
    return this.databaseStorageDirPath;
  }

  async getStoragePath(scope: string, storageName): Promise<string | undefined> {
    if (!this.databaseStorageDirPath) {
      await this.deferredStorageDirPath.promise;
    }

    const hasSlash = storageName.indexOf(Path.separator) >= 0;

    let fn;
    if (scope === STORAGE_SCHEMA.GLOBAL) {
      fn = this.dataStoragePathServer.getLastGlobalStoragePath;
    } else {
      fn = this.dataStoragePathServer.getLastWorkspaceStoragePath;
    }

    const storagePath = await fn.apply(this.dataStoragePathServer);

    if (hasSlash) {
      const storagePaths = new Path(storageName);
      storageName = storagePaths.name;
      const uriString = new URI(storagePath!).resolve(storagePaths.dir).toString();
      if (!(await this.fileSystem.access(uriString))) {
        await this.fileSystem.createFolder(uriString);
      }
      return storagePath ? new URI(uriString).resolve(`${storageName}.json`).toString() : undefined;
    }

    return storagePath ? new URI(storagePath).resolve(`${storageName}.json`).toString() : undefined;
  }

  protected applyUpdateRequest(raw: Record<string, any>, request: IUpdateRequest): Record<string, any> {
    const updated = request.insert
      ? {
          ...raw,
          ...request.insert,
        }
      : { ...raw };
    for (const key of request.delete || []) {
      delete updated[key];
    }
    return updated;
  }

  protected async updateStorageFile(
    storagePath: string,
    storageName: string,
    update: (raw: Record<string, any>) => Record<string, any>,
  ): Promise<Record<string, any>> {
    let lastConflict: unknown;
    for (let attempt = 1; attempt <= StorageServer.UPDATE_RETRY_LIMIT; attempt += 1) {
      const storageFile = await this.fileSystem.getFileStat(storagePath);
      if (!storageFile) {
        const raw = update({});
        const content = JSON.stringify(raw);
        try {
          const createdFile = await this.fileSystem.createFile(storagePath, { content });
          this._cache[storageName] = raw;
          this.onDidChangeEmitter.fire({ path: createdFile.uri, data: content });
          return raw;
        } catch (error) {
          if (FileSystemError.FileExists.is(error as any)) {
            lastConflict = error;
            continue;
          }
          throw error;
        }
      }

      const latestContent = await this.fileSystem.readFile(storagePath);
      let raw: Record<string, any> = {};
      try {
        raw = JSON.parse(latestContent.content.toString());
      } catch (error) {
        this.logger.error(`Storage [${storageName}] content can not be parse. Error: ${error.stack}`);
      }
      raw = update(raw);
      const content = JSON.stringify(raw);
      try {
        const writtenFile = await this.fileSystem.setContent(storageFile, content, {
          expectedContent: latestContent.content.buffer,
        });
        this._cache[storageName] = raw;
        this.onDidChangeEmitter.fire({ path: writtenFile?.uri || storageFile.uri, data: content });
        return raw;
      } catch (error) {
        if (FileSystemError.FileIsOutOfSync.is(error as any)) {
          lastConflict = error;
          continue;
        }
        throw error;
      }
    }

    throw lastConflict || new Error(`Storage [${storageName}] update retry limit reached.`);
  }
}

@Injectable()
export class WorkspaceStorageServer extends StorageServer {
  private workspaceNamespace: string | undefined;
  public deferredStorageDirPath: Deferred<string | undefined>;
  public databaseStorageDirPath: string | undefined;
  private readyDeferred = new Deferred<void>();

  get whenReady() {
    return this.readyDeferred.promise;
  }

  public async init(storageDirName?: string, workspaceNamespace?: string) {
    this.workspaceNamespace = workspaceNamespace;
    return await this.setupDirectories(STORAGE_SCHEMA.SCOPE, storageDirName);
  }

  async getItems(storageName: string) {
    if (this._cache[storageName]) {
      return this._cache[storageName];
    }

    let items = {};
    const workspaceNamespace = this.workspaceNamespace;
    const storagePath = await this.getStoragePath(STORAGE_SCHEMA.SCOPE, storageName);

    if (!storagePath) {
      this.logger.error(`Storage [${storageName}] is invalid.`);
    } else {
      const uriString = new URI(storagePath).toString();
      if (await this.asAccess(uriString, true)) {
        const data = await this.fileSystem.readFile(uriString);
        try {
          items = JSON.parse(data.content.toString());
        } catch (error) {
          this.logger.error(
            `Storage [${storageName}] content can not be parse with path ${uriString}. Error: ${error.stack}`,
          );
          items = {};
        }
      }
    }
    this._cache[storageName] = items;
    if (workspaceNamespace) {
      items = items[workspaceNamespace] || {};
    }
    this.readyDeferred.resolve();
    return items;
  }

  async updateItems(storageName: string, request: IUpdateRequest) {
    await this.whenReady;
    const workspaceNamespace = this.workspaceNamespace;
    const storagePath = await this.getStoragePath(STORAGE_SCHEMA.SCOPE, storageName);
    if (storagePath) {
      await this.updateStorageFile(storagePath, storageName, (raw) => {
        if (!workspaceNamespace) {
          return this.applyUpdateRequest(raw, request);
        }
        return {
          ...raw,
          [workspaceNamespace]: this.applyUpdateRequest(raw[workspaceNamespace] || {}, request),
        };
      });
    }
  }
}

@Injectable()
export class GlobalStorageServer extends StorageServer {
  public deferredStorageDirPath: Deferred<string | undefined>;
  public databaseStorageDirPath: string | undefined;

  private readyDeferred = new Deferred<void>();

  get whenReady() {
    return this.readyDeferred.promise;
  }

  public async init(storageDirName: string) {
    return await this.setupDirectories(STORAGE_SCHEMA.GLOBAL, storageDirName);
  }

  async getItems(storageName: string) {
    if (this._cache[storageName]) {
      return this._cache[storageName];
    }

    let items = {};
    const storagePath = await this.getStoragePath(STORAGE_SCHEMA.GLOBAL, storageName);

    if (!storagePath) {
      this.logger.error(`Storage [${storageName}] is invalid.`);
    } else {
      const uriString = new URI(storagePath).toString();
      if (await this.asAccess(uriString, true)) {
        const data = await this.fileSystem.readFile(uriString);
        try {
          items = JSON.parse(data.content.toString());
        } catch (error) {
          this.logger.error(`Storage [${storageName}] content can not be parse. Error: ${error.stack}`);
          items = {};
        }
      }
    }
    this._cache[storageName] = items;
    this.readyDeferred.resolve();
    return items;
  }

  async updateItems(storageName: string, request: IUpdateRequest) {
    await this.whenReady;
    const storagePath = await this.getStoragePath(STORAGE_SCHEMA.GLOBAL, storageName);
    if (storagePath) {
      await this.updateStorageFile(storagePath, storageName, (raw) => this.applyUpdateRequest(raw, request));
    }
  }
}
