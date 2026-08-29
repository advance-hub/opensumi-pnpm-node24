import path from 'path';

import { CancellationTokenSource } from '@opensumi/ide-core-common';
import { AppConfig, FileUri, INodeLogger, NodeLogger } from '@opensumi/ide-core-node';
import { createNodeInjector } from '@opensumi/ide-dev-tool/src/mock-injector';
import { WorkspaceAgentClientToken } from '@opensumi/ide-file-service/lib/node/workspace-agent';
import { ProcessModule } from '@opensumi/ide-process/lib/node';

import { IFileSearchService } from '../../src';
import { FileSearchModule } from '../../src/node';

describe('search-service', () => {
  const workspaceAgent = { fileSearch: jest.fn() };
  const injector = createNodeInjector([FileSearchModule, ProcessModule]);
  injector.addProviders(
    {
      token: AppConfig,
      useValue: {},
    },
    {
      token: INodeLogger,
      useClass: NodeLogger,
    },
    {
      token: WorkspaceAgentClientToken,
      useValue: workspaceAgent,
    },
  );
  const service = injector.get(IFileSearchService);

  afterEach(() => {
    delete process.env.OPENSUMI_WORKSPACE_AGENT_FILE_SEARCH_MODE;
    workspaceAgent.fileSearch.mockReset();
  });

  it('shall fuzzy search this spec file', async () => {
    const rootUri = path.resolve(__dirname, './');
    const matches = await service.find('test', { rootUris: [rootUri] });
    const expectedFile = FileUri.create(__filename).displayName;
    const testFile = matches.find((e) => e.endsWith(expectedFile));
    expect(testFile).toBeDefined();
  });

  it.skip('shall respect nested .gitignore', async () => {
    const rootUri = path.resolve(__dirname, '../test-resources');
    const matches = await service.find('foo', { rootUris: [rootUri], fuzzyMatch: false });

    expect(matches.find((match) => match.endsWith('subdir1/sub-bar/foo.txt'))).toBeUndefined();
    expect(matches.find((match) => match.endsWith('subdir1/sub2/foo.txt'))).toBeDefined();
    expect(matches.find((match) => match.endsWith('subdir1/foo.txt'))).toBeDefined();
  });

  it('shall cancel searches', async () => {
    const rootUri = path.resolve(__dirname, '../../../../..');
    const cancelTokenSource = new CancellationTokenSource();
    cancelTokenSource.cancel();
    const matches = await service.find('foo', { rootUris: [rootUri], fuzzyMatch: false }, cancelTokenSource.token);

    expect(matches && matches.length).toBe(0);
  });

  it('should perform file search across all folders in the workspace', async () => {
    const dirA = path.resolve(__dirname, '../test-resources/subdir1/sub-bar');
    const dirB = path.resolve(__dirname, '../test-resources/subdir1/sub2');

    const matches = await service.find('foo', { rootUris: [dirA, dirB] });
    expect(matches).toBeDefined();
    expect(matches.length).toBe(2);
  });

  it('search hidden file in the workspace', async () => {
    const dir = path.resolve(__dirname, '../test-resources/subdir1');

    const matches = await service.find('.sumi', { rootUris: [dir] });
    expect(matches).toBeDefined();
    expect(matches.length).toBe(1);
  });

  it('supports file URI roots without passing a URI to child_process cwd', async () => {
    const rootUri = FileUri.create(path.resolve(__dirname, '../test-resources/subdir1')).toString();
    const matches = await service.find('.sumi', { rootUris: [rootUri] });

    expect(matches).toHaveLength(1);
    expect(matches[0]).toBe(path.resolve(__dirname, '../test-resources/subdir1/.sumi'));
  });

  it('does not mutate or accumulate caller root options across searches', async () => {
    const rootUri = path.resolve(__dirname, '../test-resources/subdir1/sub2');
    const options = {
      rootOptions: {
        [rootUri]: {
          excludePatterns: ['*bar*'],
        },
      },
      includePatterns: ['**/*oo.*'],
    };
    const originalOptions = JSON.parse(JSON.stringify(options));

    const firstMatches = await service.find('', options);
    const secondMatches = await service.find('', options);

    expect(firstMatches).toEqual(secondMatches);
    expect(firstMatches).toHaveLength(1);
    expect(options).toEqual(originalOptions);
  });

  it('uses the Workspace Agent only when file search is explicitly enabled', async () => {
    process.env.OPENSUMI_WORKSPACE_AGENT_FILE_SEARCH_MODE = 'enabled';
    const rootPath = path.resolve(__dirname, '../test-resources/subdir1');
    const agentPath = path.join(rootPath, '.sumi');
    workspaceAgent.fileSearch.mockResolvedValue({ exactPaths: [agentPath], fuzzyPaths: [], limitHit: false });

    const matches = await service.find('.sumi', {
      rootUris: [FileUri.create(rootPath).toString()],
      useGitIgnore: true,
      limit: 200,
    });

    expect(matches).toEqual([agentPath]);
    expect(workspaceAgent.fileSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        pattern: '.sumi',
        maxResults: 200,
        roots: [
          expect.objectContaining({
            rootPath,
            useGitIgnore: true,
          }),
        ],
      }),
      undefined,
    );
  });

  it('falls back to Node when an enabled Workspace Agent file search is unavailable', async () => {
    process.env.OPENSUMI_WORKSPACE_AGENT_FILE_SEARCH_MODE = 'enabled';
    workspaceAgent.fileSearch.mockRejectedValue(new Error('agent unavailable'));
    const rootPath = path.resolve(__dirname, '../test-resources/subdir1');

    const matches = await service.find('.sumi', { rootUris: [rootPath] });

    expect(matches).toEqual([path.join(rootPath, '.sumi')]);
  });

  describe('search with glob', () => {
    it('should support file searches with globs', async () => {
      const rootUri = path.resolve(__dirname, '../test-resources/subdir1/sub2');

      const matches = await service.find('', { rootUris: [rootUri], includePatterns: ['**/*oo.*'] });
      expect(matches).toBeDefined();
      expect(matches.length).toEqual(1);
    });

    it('should NOT support file searches with globs without the prefixed or trailing star (*)', async () => {
      const rootUri = path.resolve(__dirname, '../test-resources/subdir1/sub2');

      const trailingMatches = await service.find('', { rootUris: [rootUri], includePatterns: ['*oo'] });
      expect(trailingMatches).toBeDefined();
      expect(trailingMatches.length).toEqual(0);

      const prefixedMatches = await service.find('', { rootUris: [rootUri], includePatterns: ['oo*'] });
      expect(prefixedMatches).toBeDefined();
      expect(prefixedMatches.length).toEqual(0);
    });
  });

  describe('search with ignored patterns', () => {
    it('should NOT ignore strings passed through the search options', async () => {
      const rootUri = path.resolve(__dirname, '../test-resources/subdir1/sub2');

      const matches = await service.find('', {
        rootUris: [rootUri],
        includePatterns: ['**/*oo.*'],
        excludePatterns: ['foo'],
      });
      expect(matches).toBeDefined();
      expect(matches.length).toEqual(1);
    });

    const ignoreGlobsUri = FileUri.create(path.resolve(__dirname, '../test-resources/subdir1/sub2')).toString();
    it('should ignore globs passed through the search options #1', () =>
      assertIgnoreGlobs({
        rootUris: [ignoreGlobsUri],
        includePatterns: ['**/*oo.*'],
        excludePatterns: ['*fo*'],
      }));

    it('should ignore globs passed through the search options #2', () =>
      assertIgnoreGlobs({
        rootOptions: {
          [ignoreGlobsUri]: {
            includePatterns: ['**/*oo.*'],
            excludePatterns: ['*fo*'],
          },
        },
      }));

    it('should ignore globs passed through the search options #3', () =>
      assertIgnoreGlobs({
        rootOptions: {
          [ignoreGlobsUri]: {
            includePatterns: ['**/*oo.*'],
          },
        },
        excludePatterns: ['*fo*'],
      }));

    it('should ignore globs passed through the search options #4', () =>
      assertIgnoreGlobs({
        rootOptions: {
          [ignoreGlobsUri]: {
            excludePatterns: ['*fo*'],
          },
        },
        includePatterns: ['**/*oo.*'],
      }));
    it('should ignore globs passed through the search options #5', () =>
      assertIgnoreGlobs({
        rootOptions: {
          [ignoreGlobsUri]: {},
        },
        excludePatterns: ['*fo*'],
        includePatterns: ['**/*oo.*'],
      }));

    async function assertIgnoreGlobs(options: any): Promise<void> {
      const matches = await service.find('', options);
      expect(matches).toBeDefined();
      expect(matches.length).toEqual(0);
    }
  });

  describe('irrelevant absolute results', () => {
    const rootUri = path.resolve(__dirname, '../test-resources/subdir1/');
    const searchPattern = 'oox';

    it('not fuzzy', async () => {
      const matches = await service.find(searchPattern, {
        rootUris: [rootUri.toString()],
        fuzzyMatch: false,
        useGitIgnore: true,
        limit: 200,
      });
      expect(matches.length).toBe(0);
    });

    it('fuzzy', async () => {
      const matches = await service.find(searchPattern, {
        rootUris: [rootUri.toString()],
        fuzzyMatch: true,
        useGitIgnore: true,
        limit: 200,
      });
      for (const match of matches) {
        const relativeUri = path.relative(rootUri, match);
        expect(relativeUri !== undefined).toBe(true);
        const relativeMatch = relativeUri!.toString();
        let position = 0;
        for (const ch of searchPattern) {
          position = relativeMatch.indexOf(ch, position);
          expect(position !== -1).toBe(true);
        }
      }
    });
  });
});
