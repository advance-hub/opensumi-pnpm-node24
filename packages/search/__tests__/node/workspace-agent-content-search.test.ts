import { status } from '@grpc/grpc-js';

import { FileUri } from '@opensumi/ide-core-node';

import { SEARCH_STATE } from '../../src';
import { ContentSearchService } from '../../src/node/content-search.service';

describe('Workspace Agent content search failure handling', () => {
  it('reports an unexpected client cancellation as an error instead of a completed search', async () => {
    expect.assertions(3);
    let handlers: any;
    const workspaceAgent = {
      search: jest.fn().mockImplementation(async (_request, nextHandlers) => {
        handlers = nextHandlers;
        return { dispose: jest.fn() };
      }),
    };
    const service = Object.create(ContentSearchService.prototype) as any;
    Object.assign(service, {
      workspaceAgent,
      logger: { debug: jest.fn(), error: jest.fn() },
      processMap: new Map(),
      shadowProcessMap: new Map(),
      parityMap: new Map(),
      sendResultToClient: jest.fn(),
    });

    await service.searchWithWorkspaceAgent(7, 'query', [FileUri.create('/workspace').toString()]);
    handlers.onError({ code: status.CANCELLED, details: 'client closed', metadata: {} });

    expect(service.sendResultToClient).toHaveBeenNthCalledWith(1, [], 7, SEARCH_STATE.doing);
    expect(service.sendResultToClient).toHaveBeenNthCalledWith(
      2,
      [],
      7,
      SEARCH_STATE.error,
      'Workspace Agent search failed.',
    );
    expect(service.processMap.has(7)).toBe(false);
  });
});
