// The package exposes a native `require` runtime entry, but its declaration
// condition is ESM-only. Keep this narrow compatibility boundary while the
// OpenSumi framework packages still emit CommonJS.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { WebsocketProvider } = require('y-websocket') as {
  WebsocketProvider: new (serverUrl: string, roomName: string, doc: YDoc) => IWebsocketProvider;
};
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { Doc as YDoc, Map as YMap, YMapEvent, Text as YText } from 'yjs';

import { Autowired, INJECTOR_TOKEN, Inject, Injectable, Injector } from '@opensumi/di';
import { AppConfig, DisposableCollection } from '@opensumi/ide-core-browser';
import { Deferred, DisposableStore, ILogger, OnEvent, WithEventBus, uuid } from '@opensumi/ide-core-common';
import { WorkbenchEditorService } from '@opensumi/ide-editor';
import {
  EditorDocumentModelCreationEvent,
  EditorDocumentModelRemovalEvent,
  EditorGroupCloseEvent,
  EditorGroupOpenEvent,
  IEditorDocumentModelService,
} from '@opensumi/ide-editor/lib/browser';
import { WorkbenchEditorServiceImpl } from '@opensumi/ide-editor/lib/browser/workbench-editor.service';
import { FileChangeEvent, FileChangeType, IFileServiceClient } from '@opensumi/ide-file-service/lib/common';
import { ICodeEditor, ITextModel } from '@opensumi/ide-monaco';
import { ICSSStyleService } from '@opensumi/ide-theme';

import {
  CollaborationModuleContribution,
  CollaborationServiceForClientPath,
  DEFAULT_COLLABORATION_PORT,
  ICollaborationService,
  ICollaborationServiceForClient,
  ROOM_NAME,
  UserInfo,
  Y_REMOTE_SELECTION,
  Y_REMOTE_SELECTION_HEAD,
} from '../common';

import { getColorByClientID } from './color';
import { CursorWidgetRegistry } from './cursor-widget';
import { TextModelBinding } from './textmodel-binding';

import './styles.less';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore ESM declarations are used only as an erased type in this CommonJS package.
import type { Awareness } from 'y-protocols/awareness';

interface AwarenessChanges {
  added: number[];
  updated: number[];
  removed: number[];
}

const DOCUMENT_INITIALIZATION_TIMEOUT = 15_000;

interface IWebsocketProvider {
  awareness: Awareness;
  destroy(): void;
}

@Injectable()
export class CollaborationService extends WithEventBus implements ICollaborationService {
  @Autowired(INJECTOR_TOKEN)
  private injector: Injector;

  @Autowired(ILogger)
  private logger: ILogger;

  @Autowired(WorkbenchEditorService)
  private workbenchEditorService: WorkbenchEditorServiceImpl;

  @Autowired(ICSSStyleService)
  private cssManager: ICSSStyleService;

  @Autowired(IEditorDocumentModelService)
  private docModelManager: IEditorDocumentModelService;

  @Autowired(IFileServiceClient)
  protected readonly fileServiceClient: IFileServiceClient;

  @Autowired(AppConfig)
  private appConfig: AppConfig;

  private clientStyleDisposables = new Map<number, DisposableStore>();

  private cursorRegistryMap: Map<ICodeEditor, CursorWidgetRegistry> = new Map();

  private userInfo: UserInfo;

  private yDoc: YDoc;

  private yWebSocketProvider: IWebsocketProvider;

  private yTextMap: YMap<YText>;

  private bindingMap: Map<string, TextModelBinding> = new Map();

  private yMapReadyMap: Map<string, Deferred<void>> = new Map();

  private bindingReadyMap: Map<string, Deferred<void>> = new Map();

  protected readonly toDisposableCollection: DisposableCollection = new DisposableCollection();
  private yMapObserver = (event: YMapEvent<YText>) => {
    const changes = event.changes.keys;
    changes.forEach((change, key) => {
      if (change.action === 'add') {
        const { yMapReady } = this.getDeferred(key);
        const binding = this.getBinding(key);
        if (binding) {
          const text = this.yTextMap.get(key)!;
          binding.changeYText(text);
        }
        yMapReady.resolve();
      } else if (change.action === 'delete') {
        this.resetDeferredYMapKey(key);
      }
    });
  };

  constructor(@Inject(CollaborationServiceForClientPath) private readonly backService: ICollaborationServiceForClient) {
    super();
  }

  initialize() {
    /**
     * 优先使用 appConfig.collaborationWsPath 配置
     * 如果没有该配置才根据 wsPath 去转换端口，端口可以用 collaborationOpts.port 配置
     */
    const { collaborationWsPath, wsPath, collaborationOptions } = this.appConfig;
    let serverUrl: string | undefined = collaborationWsPath;

    if (!serverUrl) {
      const path = new URL(wsPath.toString());
      path.port = String(collaborationOptions?.port ?? DEFAULT_COLLABORATION_PORT);

      serverUrl = path.toString();
    }

    this.yDoc = new YDoc();
    this.yTextMap = this.yDoc.getMap();

    this.yWebSocketProvider = new WebsocketProvider(serverUrl.toString(), ROOM_NAME, this.yDoc);

    this.yTextMap.observe(this.yMapObserver);

    this.yWebSocketProvider.awareness.on('update', this.updateCSSManagerWhenAwarenessUpdated);
  }

  registerUserInfo() {
    if (this.userInfo === undefined) {
      // fallback
      this.userInfo = {
        id: uuid().slice(0, 4),
        nickname: `${uuid().slice(0, 4)}`,
      };
    }
    // add userInfo to awareness field
    this.yWebSocketProvider.awareness.setLocalStateField('user-info', this.userInfo);
  }

  initFileWatch() {
    this.toDisposableCollection.push(
      this.fileServiceClient.onFilesChanged((e) => {
        this.handleFileChange(e);
      }),
    );
  }

  destroy() {
    this.yWebSocketProvider.awareness.off('update', this.updateCSSManagerWhenAwarenessUpdated);
    this.yTextMap.unobserve(this.yMapObserver);
    this.bindingMap.forEach((binding) => binding.destroy());
    this.bindingMap.clear();
    this.cursorRegistryMap.forEach((registry) => registry.destroy());
    this.cursorRegistryMap.clear();
    this.clientStyleDisposables.forEach((disposables) => disposables.dispose());
    this.clientStyleDisposables.clear();
    this.bindingReadyMap.clear();
    this.yMapReadyMap.clear();
    this.toDisposableCollection.dispose();
    this.yWebSocketProvider.destroy();
    this.yDoc.destroy();
  }

  registerContribution(contribution: CollaborationModuleContribution) {
    if (this.userInfo) {
      throw new Error('User info is already registered');
    }

    if (contribution.info) {
      this.userInfo = contribution.info;
    }
  }

  undoOnFocusedTextModel() {
    const uri = this.workbenchEditorService.currentResource?.uri.toString();
    if (uri && this.bindingMap.has(uri)) {
      this.bindingMap.get(uri)!.undo();
    }
  }

  redoOnFocusedTextModel() {
    const uri = this.workbenchEditorService.currentResource?.uri.toString();
    if (uri && this.bindingMap.has(uri)) {
      this.bindingMap.get(uri)!.redo();
    }
  }

  private getDeferred(uri: string) {
    if (!this.bindingReadyMap.has(uri)) {
      this.bindingReadyMap.set(uri, new Deferred());
    }
    if (!this.yMapReadyMap.has(uri)) {
      const yMapReady = new Deferred<void>();
      if (this.yTextMap?.has(uri)) {
        yMapReady.resolve();
      }
      this.yMapReadyMap.set(uri, yMapReady);
    }

    const bindingReady = this.bindingReadyMap.get(uri)!;
    const yMapReady = this.yMapReadyMap.get(uri)!;

    return { bindingReady, yMapReady };
  }

  private resetDeferredYMapKey(uri: string) {
    if (this.yMapReadyMap.has(uri)) {
      this.yMapReadyMap.set(uri, new Deferred());
    }
  }

  private async waitForYMap(uri: string, promise: Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        promise,
        new Promise<void>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Timed out waiting for collaboration document: ${uri}`)),
            DOCUMENT_INITIALIZATION_TIMEOUT,
          );
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private createAndSetBinding(uri: string, model: ITextModel): TextModelBinding {
    const cond = this.bindingMap.has(uri);

    if (!cond) {
      const binding = this.injector.get(TextModelBinding, [
        this.yTextMap.get(uri)!, // only be called when entry of yMap is ready
        model,
        this.yWebSocketProvider.awareness,
      ]);
      this.bindingMap.set(uri, binding);
      return binding;
    } else {
      return this.bindingMap.get(uri)!;
    }
  }

  private getBinding(uri: string) {
    const cond = this.bindingMap.has(uri);

    if (cond) {
      return this.bindingMap.get(uri)!;
    } else {
      return null;
    }
  }

  private removeBinding(uri: string) {
    const binding = this.bindingMap.get(uri);

    if (binding) {
      binding.destroy();
      this.bindingMap.delete(uri);
    }
  }

  public getCursorWidgetRegistry(editor: ICodeEditor) {
    return this.cursorRegistryMap.get(editor);
  }

  private updateCSSManagerWhenAwarenessUpdated = (changes: AwarenessChanges) => {
    if (changes.added.length > 0) {
      changes.added.forEach((clientID) => {
        if (!this.clientStyleDisposables.has(clientID)) {
          const [foregroundColor, backgroundColor] = getColorByClientID(clientID);
          const styles = new DisposableStore();
          styles.add(
            this.cssManager.addClass(`${Y_REMOTE_SELECTION}-${clientID}`, {
              backgroundColor,
              opacity: '0.25',
              color: foregroundColor,
            }),
          );
          styles.add(
            this.cssManager.addClass(`${Y_REMOTE_SELECTION_HEAD}-${clientID}`, {
              position: 'absolute',
              borderLeft: `${backgroundColor} solid 2px`,
              borderBottom: `${backgroundColor} solid 2px`,
              borderTop: `${backgroundColor} solid 2px`,
              height: '100%',
              boxSizing: 'border-box',
            }),
          );
          styles.add(
            this.cssManager.addClass(`${Y_REMOTE_SELECTION_HEAD}-${clientID}::after`, {
              position: 'absolute',
              content: ' ',
              border: `3px solid ${backgroundColor}`,
              left: '-4px',
              top: '-5px',
            }),
          );
          this.clientStyleDisposables.set(clientID, styles);
        }
      });
    }

    changes.removed.forEach((clientID) => {
      this.clientStyleDisposables.get(clientID)?.dispose();
      this.clientStyleDisposables.delete(clientID);
    });
  };

  private handleFileChange(e: FileChangeEvent) {
    e.forEach((change) => {
      // 只有从文件系统更新，并且窗口未打开情况，才重置 yTextMap
      if (change.type === FileChangeType.UPDATED && !this.bindingMap.get(change.uri) && this.yTextMap.get(change.uri)) {
        this.yTextMap.delete(change.uri);
        this.resetDeferredYMapKey(change.uri);
      }
    });
  }

  @OnEvent(EditorDocumentModelCreationEvent)
  private async editorDocumentModelCreationHandler(e: EditorDocumentModelCreationEvent) {
    if (e.payload.uri.scheme !== 'file') {
      return;
    }

    const uri = e.payload.uri;
    const uriString = e.payload.uri.toString();
    /**
     * e.payload 里面有文件的完整文件 content 内容，内存占用较大
     * 如果 this.backService.requestInitContent/yMapReady.promise 一直不 resolve，会导致内存泄漏问题
     * 在获取完 e.payload.uri 后，将 e 置为 undefined 主动释放内存
     */
    (e as any) = undefined;

    const { bindingReady, yMapReady } = this.getDeferred(uriString);
    try {
      await this.backService.requestInitContent(uriString);
      await this.waitForYMap(uriString, yMapReady.promise);
      // get monaco model from model ref by uri
      const ref = this.docModelManager.getModelReference(uri);
      const monacoModel = ref?.instance.getMonacoModel();
      ref?.dispose();
      if (monacoModel) {
        this.createAndSetBinding(uriString, monacoModel);
      }
    } catch (error) {
      this.logger.error(`Failed to initialize collaboration for ${uriString}`, error);
      this.yMapReadyMap.delete(uriString);
      await this.backService.releaseContent(uriString).catch((releaseError) => {
        this.logger.error(`Failed to release collaboration content for ${uriString}`, releaseError);
      });
    } finally {
      // Always resolve so editor open/close handlers cannot retain the model
      // forever after a backend read error or a disconnected Yjs provider.
      bindingReady.resolve();
    }
  }

  @OnEvent(EditorDocumentModelRemovalEvent)
  private async editorDocumentModelRemovalHandler(e: EditorDocumentModelRemovalEvent) {
    if (e.payload.codeUri.scheme !== 'file') {
      return;
    }

    const uriString = e.payload.codeUri.toString();
    const { bindingReady } = this.getDeferred(uriString);
    await bindingReady.promise;
    this.removeBinding(uriString);
    this.bindingReadyMap.delete(uriString);
    this.yMapReadyMap.delete(uriString);
    await this.backService.releaseContent(uriString).catch((error) => {
      this.logger.error(`Failed to release collaboration content for ${uriString}`, error);
    });
  }

  @OnEvent(EditorGroupOpenEvent)
  private async groupOpenHandler(e: EditorGroupOpenEvent) {
    const uriString = e.payload.resource.uri.toString();
    const { bindingReady } = this.getDeferred(uriString);
    await bindingReady.promise;
    const binding = this.getBinding(uriString);
    if (binding) {
      binding.addEditor(e.payload.group.codeEditor.monacoEditor);
    }
    // create content widget registry
    // check if editor has its widgetRegistry
    const monacoEditor = e.payload.group.codeEditor.monacoEditor;
    if (!this.cursorRegistryMap.has(monacoEditor) && monacoEditor) {
      const registry = this.injector.get(CursorWidgetRegistry, [monacoEditor, this.yWebSocketProvider.awareness]);
      this.cursorRegistryMap.set(monacoEditor, registry);
      monacoEditor.onDidDispose(() => {
        this.cursorRegistryMap.delete(monacoEditor);
        registry.destroy();
      });
    }
  }

  @OnEvent(EditorGroupCloseEvent)
  private async groupCloseHandler(e: EditorGroupCloseEvent) {
    const uriString = e.payload.resource.uri.toString();
    const { bindingReady } = this.getDeferred(uriString);
    await bindingReady.promise;
    const binding = this.getBinding(uriString);
    if (binding) {
      binding.removeEditor(e.payload.group.codeEditor.monacoEditor);
    }
  }
}
