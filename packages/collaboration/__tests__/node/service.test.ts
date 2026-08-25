/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-ignore
import * as Y from 'yjs';

import { INodeLogger } from '@opensumi/ide-core-node';
import { MockInjector, createNodeInjector } from '@opensumi/ide-dev-tool/src/mock-injector';
import { IFileService } from '@opensumi/ide-file-service';
import { FileService } from '@opensumi/ide-file-service/src/node';

import { ICollaborationServiceForClient, IYWebsocketServer, ROOM_NAME } from '../../src';
import { CollaborationServiceForClient } from '../../src/node/collaboration.service';
import { YWebsocketServerImpl } from '../../src/node/y-websocket-server';

describe('Collaboration node ws server test', () => {
  let injector: MockInjector;
  let server: YWebsocketServerImpl;
  let service: CollaborationServiceForClient;
  let yDoc: Y.Doc;
  let fileService: FileService;
  let resolveContentSpy: jest.SpyInstance;

  const MOCK_CONTENT = 'init mock content';

  beforeAll(() => {
    injector = createNodeInjector([]);
    injector.mockService(INodeLogger);
    injector.mockService(IFileService);
    injector.addProviders(
      {
        token: IYWebsocketServer,
        useClass: YWebsocketServerImpl,
      },
      {
        token: ICollaborationServiceForClient,
        useClass: CollaborationServiceForClient,
      },
    );

    fileService = injector.get(IFileService);
    resolveContentSpy = jest
      .spyOn(fileService, 'resolveContent')
      .mockImplementation(async () => ({ content: MOCK_CONTENT }) as any);

    server = injector.get(IYWebsocketServer);
    service = injector.get(ICollaborationServiceForClient);
  });

  it('should correctly initialize', () => {
    expect.hasAssertions();
    const spy = jest.spyOn(server, 'initialize');
    server.initialize();
    expect(spy).toHaveBeenCalled();
  });

  it('should get Y.Doc', () => {
    expect.hasAssertions();
    yDoc = server.getYDoc(ROOM_NAME);
    expect(yDoc).toBeInstanceOf(Y.Doc);
  });

  const TEST_URI = 'file://foo';

  it('should set init content correctly', async () => {
    expect.hasAssertions();
    await service.requestInitContent(TEST_URI);
    const yMap: Y.Map<Y.Text> = yDoc.getMap();
    expect(yMap.has(TEST_URI)).toBeTruthy();
    expect(yMap.get(TEST_URI)).toBeInstanceOf(Y.Text);
    expect(yMap.get(TEST_URI)!.toString()).toBe(MOCK_CONTENT);
    expect((server as any).pendingContentRequests.size).toBe(0);
  });

  it('should release content only after the last reference closes', async () => {
    expect.hasAssertions();
    await service.requestInitContent(TEST_URI);
    expect((server as any).contentReferences.get(TEST_URI)).toBe(2);

    await service.releaseContent(TEST_URI);
    expect(yDoc.getMap().has(TEST_URI)).toBeTruthy();
    expect((server as any).contentReferences.get(TEST_URI)).toBe(1);

    await service.releaseContent(TEST_URI);
    expect(yDoc.getMap().has(TEST_URI)).toBeFalsy();
    expect((server as any).contentReferences.has(TEST_URI)).toBeFalsy();
  });

  it('should remove Y.Text', async () => {
    expect.hasAssertions();
    await service.requestInitContent(TEST_URI);
    server.removeYText(TEST_URI);
    const yMap = yDoc.getMap();
    expect(yMap.has(TEST_URI)).toBeFalsy();
    expect((server as any).contentReferences.has(TEST_URI)).toBeFalsy();
  });

  it('should reject oversized documents without retaining pending state', async () => {
    expect.hasAssertions();
    const appConfig = (server as any).appConfig;
    appConfig.collaborationOptions = { maxDocumentBytes: 4 };
    resolveContentSpy.mockImplementationOnce(async () => ({ content: 'too large' }) as any);

    await expect(service.requestInitContent('file://oversized')).rejects.toThrow('exceeding the 4-byte limit');
    expect(yDoc.getMap().has('file://oversized')).toBeFalsy();
    expect((server as any).pendingContentRequests.size).toBe(0);

    appConfig.collaborationOptions = undefined;
  });

  it('should cancel an in-flight load without restoring a deleted file', async () => {
    expect.hasAssertions();
    const delayedUri = 'file://delayed';
    let finishLoading: ((value: { content: string }) => void) | undefined;
    resolveContentSpy.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishLoading = resolve;
        }) as any,
    );

    const initialization = service.requestInitContent(delayedUri);
    await Promise.resolve();
    server.removeYText(delayedUri);

    await expect(initialization).rejects.toThrow('File was removed while loading collaboration content');
    finishLoading!({ content: 'late content' });
    await new Promise((resolve) => setImmediate(resolve));

    expect(yDoc.getMap().has(delayedUri)).toBeFalsy();
    expect((server as any).pendingContentRequests.size).toBe(0);
  });

  it('should reclaim abandoned content after the last client is idle', async () => {
    expect.hasAssertions();
    const idleUri = 'file://idle';
    const appConfig = (server as any).appConfig;
    appConfig.collaborationOptions = { idleTimeout: 1 };
    await service.requestInitContent(idleUri);

    const abandonedDocument = server.getYDoc(ROOM_NAME);
    server['scheduleIdleCleanup']();
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(yDoc.getMap().has(idleUri)).toBeFalsy();
    expect((server as any).contentReferences.has(idleUri)).toBeFalsy();
    expect(server.getYDoc(ROOM_NAME)).not.toBe(abandonedDocument);
    yDoc = server.getYDoc(ROOM_NAME);
    appConfig.collaborationOptions = undefined;
  });

  it('resets CRDT history after the shared state reaches its memory limit', async () => {
    expect.hasAssertions();
    const appConfig = (server as any).appConfig;
    appConfig.collaborationOptions = { maxStateBytes: 1 };
    const pressuredDocument = server.getYDoc(ROOM_NAME);
    pressuredDocument.getMap().set('large-update', new Y.Text('content that exceeds the state limit'));

    server['checkDocumentPressure']();
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(server.getYDoc(ROOM_NAME)).not.toBe(pressuredDocument);
    expect((server as any).accumulatedUpdateBytes).toBe(0);
    yDoc = server.getYDoc(ROOM_NAME);
    appConfig.collaborationOptions = undefined;
  });

  it('should correctly dispose', () => {
    expect.hasAssertions();
    const spy = jest.spyOn(server, 'destroy');
    server.destroy();
    expect(spy).toHaveBeenCalled();
  });

  afterAll(() => {
    // @ts-ignore
    yDoc.destroy();
  });
});
