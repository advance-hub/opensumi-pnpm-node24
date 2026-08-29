import { IDisposable } from '@opensumi/ide-core-common';

import { ExtensionHostType } from '.';

import type vscode from 'vscode';

export class ExtensionActivationTimes {
  public static readonly NONE = new ExtensionActivationTimes(false, -1, -1, -1);

  constructor(
    public readonly startup: boolean,
    public readonly codeLoadingTime: number,
    public readonly activateCallTime: number,
    public readonly activateResolvedTime: number,
  ) {}
}

export interface IExtensionModule {
  activate?(ctx: vscode.ExtensionContext): Promise<any>;
  deactivate?(): void;
}

export type IExtensionAPI = any;

export type IExtendExportAPI = any;

export interface ActivatedExtensionJSON {
  id: string;
  host: ExtensionHostType;
  activationFailed: boolean;
  activationFailedError: Error | null;
  activateCallTime?: number;
}

export class ActivatedExtension {
  constructor(
    public readonly id: string,
    public readonly displayName: string,
    public readonly description: string,
    public readonly host: ExtensionHostType,
    public readonly activationFailed: boolean,
    public readonly activationFailedError: Error | null,
    public readonly module: IExtensionModule,
    public readonly exports: IExtensionAPI | undefined,
    public readonly subscriptions: IDisposable[],
    public readonly activationTimes?: ExtensionActivationTimes,
    public readonly extendExports?: IExtendExportAPI,
    public readonly extendModule?: IExtensionModule,
  ) {}

  public toJSON() {
    return {
      id: this.id,
      displayName: this.displayName,
      description: this.description,
      host: this.host,
      activationFailed: this.activationFailed,
      activationFailedError: this.activationFailedError,
      activateCallTime: this.activationTimes?.activateCallTime,
    };
  }
}

export class ExtensionsActivator {
  private readonly activatedExtensions: Map<string, ActivatedExtension> = new Map();

  constructor(private logger: any = console) {}

  has(id: string) {
    return this.activatedExtensions.has(id);
  }

  set(id: string, extension: ActivatedExtension) {
    return this.activatedExtensions.set(id, extension);
  }

  get(id: string): ActivatedExtension | undefined {
    return this.activatedExtensions.get(id);
  }

  all(): ActivatedExtension[] {
    return Array.from(this.activatedExtensions.values());
  }

  delete(id: string) {
    return this.activatedExtensions.delete(id);
  }

  private async doDeactivate(extensionModule): Promise<void> {
    try {
      await (extensionModule as Required<IExtensionModule>).deactivate();
    } catch (err) {
      this.logger.error(`
        [Extension-Host] deactivate extension module error ${err.message} \n\n
        Stack: ${err.stack && err.stack}
      `);
    }
  }

  async deactivateExtension(id: string): Promise<boolean> {
    const extension = this.activatedExtensions.get(id);
    if (!extension) {
      return false;
    }

    const deactivateTasks: Promise<void>[] = [];
    for (const extensionModule of [extension.module, extension.extendModule]) {
      if (extensionModule?.deactivate && typeof extensionModule.deactivate === 'function') {
        deactivateTasks.push(this.doDeactivate(extensionModule));
      }
    }
    await Promise.all(deactivateTasks);

    for (const disposable of extension.subscriptions) {
      try {
        disposable.dispose();
      } catch (error) {
        this.logger.log('extension deactivated error');
        this.logger.warn(error);
      }
    }
    this.activatedExtensions.delete(id);
    return true;
  }

  deactivate(): Promise<boolean[]> {
    return Promise.all(Array.from(this.activatedExtensions.keys(), (id) => this.deactivateExtension(id)));
  }
}
