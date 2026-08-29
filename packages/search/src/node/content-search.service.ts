import { Autowired, Injectable, Optional } from '@opensumi/di';
import { RPCService } from '@opensumi/ide-connection';
import { FileUri, path } from '@opensumi/ide-core-node';
import {
  WorkspaceAgentClient,
  WorkspaceAgentClientToken,
  WorkspaceAgentSearchEvent,
  WorkspaceAgentStreamHandle,
  isCancelledServiceError,
  parseWorkspaceAgentMode,
} from '@opensumi/ide-file-service/lib/node/workspace-agent';
import { ILogService, ILogServiceManager, SupportLogNamespace } from '@opensumi/ide-logs/lib/node';
import { IProcess, IProcessFactory, ProcessOptions } from '@opensumi/ide-process';
import { rgPath } from '@opensumi/ripgrep';

import {
  ContentSearchOptions,
  ContentSearchResult,
  FilterFileWithGlobRelativePath,
  IContentSearchServer,
  SEARCH_STATE,
  SendClientResult,
  anchorGlob,
  cutShortSearchResult,
} from '../common';

interface SearchInfo {
  searchId: number;
  resultLength: number;
  dataBuf: string;
}

interface DisposableSearchProcess {
  dispose(): void;
}

interface SearchParityState {
  node: Set<string>;
  agent: Set<string>;
  nodeDone: boolean;
  agentDone: boolean;
}

interface LineInfo {
  type: 'begin' | 'end' | 'match' | 'summary';
  data: {
    path: {
      text: string;
    };
    lines: {
      text: string;
    };
    line_number: number;
    absolute_offset: number;
    submatches: {
      match: {
        text: string;
      };
      start: number;
      end: number;
    }[];
  };
}

const { replaceAsarInPath } = path;

/**
 * Convert the length of a range in `text` expressed in bytes to a number of
 * characters (or more precisely, code points).  The range starts at character
 * `charStart` in `text`.
 */
function byteRangeLengthToCharacterLength(text: string, charStart: number, byteLength: number): number {
  let char: number = charStart;
  for (let byteIdx = 0; byteIdx < byteLength; char++) {
    const codePoint: number = text.charCodeAt(char);
    if (codePoint < 0x7f) {
      byteIdx++;
    } else if (codePoint < 0x7ff) {
      byteIdx += 2;
    } else if (codePoint < 0xffff) {
      byteIdx += 3;
    } else if (codePoint < 0x10ffff) {
      byteIdx += 4;
    } else {
      throw new Error('Invalid UTF-8 string');
    }
  }

  return char - charStart;
}

interface IRPCContentSearchService {
  onSearchResult(sendClientResult: SendClientResult): void;
}

@Injectable()
export class ContentSearchService extends RPCService<IRPCContentSearchService> implements IContentSearchServer {
  @Autowired(IProcessFactory)
  protected processFactory: IProcessFactory;

  private processMap: Map<number, DisposableSearchProcess> = new Map();

  private shadowProcessMap: Map<number, WorkspaceAgentStreamHandle> = new Map();

  private parityMap: Map<number, SearchParityState> = new Map();

  @Autowired(ILogServiceManager)
  private loggerManager!: ILogServiceManager;

  private logger: ILogService;

  constructor(
    @Optional(WorkspaceAgentClientToken)
    private readonly workspaceAgent?: WorkspaceAgentClient,
  ) {
    super();
    this.logger = this.loggerManager.getLogger(SupportLogNamespace.Node);
  }

  private searchStart(searchId: number, searchProcess) {
    this.sendResultToClient([], searchId, SEARCH_STATE.doing);
    this.processMap.set(searchId, searchProcess);
  }

  private searchEnd(searchId: number) {
    this.sendResultToClient([], searchId, SEARCH_STATE.done);
    this.processMap.delete(searchId);
    const parity = this.parityMap.get(searchId);
    if (parity) {
      parity.nodeDone = true;
      this.finishParity(searchId, parity);
    }
  }

  private searchError(searchId: number, error: string) {
    this.sendResultToClient([], searchId, SEARCH_STATE.error, error);
    this.processMap.delete(searchId);
  }

  async search(searchId: number, what: string, rootUris: string[], opts?: ContentSearchOptions): Promise<number> {
    const mode = parseWorkspaceAgentMode(process.env.OPENSUMI_WORKSPACE_AGENT_SEARCH_MODE);
    if (mode === 'enabled' && this.workspaceAgent) {
      try {
        return await this.searchWithWorkspaceAgent(searchId, what, rootUris, opts);
      } catch (error) {
        this.logger.error('Workspace Agent search startup failed; falling back to Node search', error);
      }
    }
    if (mode === 'shadow-read' && this.workspaceAgent) {
      this.parityMap.set(searchId, {
        node: new Set(),
        agent: new Set(),
        nodeDone: false,
        agentDone: false,
      });
      void this.searchWithWorkspaceAgent(searchId, what, rootUris, opts, true).catch((error) => {
        this.logger.warn(`Workspace Agent shadow search ${searchId} unavailable`, error);
        const parity = this.parityMap.get(searchId);
        if (parity) {
          parity.agentDone = true;
          this.finishParity(searchId, parity);
        }
      });
    }
    return this.searchWithNode(searchId, what, rootUris, opts);
  }

  private async searchWithNode(
    searchId: number,
    what: string,
    rootUris: string[],
    opts?: ContentSearchOptions,
  ): Promise<number> {
    const args = this.getSearchArgs(opts);

    if (opts && opts.matchWholeWord && !opts.useRegExp) {
      what = what.replace(/[-\\{}*+?|^$.[\]()#]/g, '\\$&');
      if (!/\B/.test(what.charAt(0))) {
        what = '\\b' + what;
      }
      if (!/\B/.test(what.charAt(what.length - 1))) {
        what = what + '\\b';
      }
    }

    const searchInfo: SearchInfo = {
      searchId,
      resultLength: 0,
      dataBuf: '',
    };

    const processOptions: ProcessOptions = {
      command: replaceAsarInPath(rgPath),
      args: [...args, what].concat(rootUris.map((root) => FileUri.fsPath(root))),
    };

    const rgProcess: IProcess = this.processFactory.create(processOptions);
    this.searchStart(searchInfo.searchId, rgProcess);
    rgProcess.onError((error) => {
      let errorCode = error.code;

      // Try to provide somewhat clearer error messages, if possible.
      if (errorCode === 'ENOENT') {
        errorCode = 'could not find the ripgrep (rg) binary';
      } else if (errorCode === 'EACCES') {
        errorCode = 'could not execute the ripgrep (rg) binary';
      }

      const errorStr = `An error happened while searching (${errorCode}).`;

      this.logger.error(errorStr);
      this.searchError(searchInfo.searchId, errorStr);
    });

    rgProcess.outputStream.on('data', (chunk: Buffer) => {
      searchInfo.dataBuf = searchInfo.dataBuf + chunk;
      this.parseDataBuffer(searchInfo, opts, rootUris);
    });

    rgProcess.onExit(() => {
      this.searchEnd(searchInfo.searchId);
    });

    return searchInfo.searchId;
  }

  cancel(searchId: number): Promise<void> {
    const process = this.processMap.get(searchId);
    if (process) {
      process.dispose();
      this.processMap.delete(searchId);
    }
    this.shadowProcessMap.get(searchId)?.dispose();
    this.shadowProcessMap.delete(searchId);
    this.parityMap.delete(searchId);
    return Promise.resolve();
  }

  private parseDataBuffer(searchInfo: SearchInfo, opts?: ContentSearchOptions, rootUris?: string[]) {
    const lines = searchInfo.dataBuf.toString().split('\n');
    const result: ContentSearchResult[] = [];
    let filterFileWithGlobRelativePath: FilterFileWithGlobRelativePath;

    if (lines.length < 1) {
      return;
    }

    if (rootUris && opts) {
      filterFileWithGlobRelativePath = new FilterFileWithGlobRelativePath(rootUris, opts.include || []);
    }

    lines.some((line) => {
      // 读一行清理一行
      const eolIdx = searchInfo.dataBuf.indexOf('\n');
      if (eolIdx > -1) {
        searchInfo.dataBuf = searchInfo.dataBuf.slice(eolIdx + 1);
      }

      let lintObj: LineInfo | undefined;
      try {
        lintObj = JSON.parse(line.trim());
      } catch {}
      if (!lintObj) {
        return;
      }

      if (lintObj.type === 'match') {
        const data = lintObj.data;
        const file = data.path.text;
        const line = data.line_number;
        const lineText = data.lines.text;

        if (file === undefined || lineText === undefined) {
          return;
        }

        for (const submatch of data.submatches) {
          const startByte = submatch.start;
          const endByte = submatch.end;
          const character = byteRangeLengthToCharacterLength(lineText, 0, startByte);
          const matchLength = byteRangeLengthToCharacterLength(lineText, character, endByte - startByte);
          const fileUri = FileUri.create(file);
          const fileUriSting = fileUri.toString();

          if (filterFileWithGlobRelativePath && !filterFileWithGlobRelativePath.test(fileUriSting)) {
            continue;
          }
          const searchResult: ContentSearchResult = cutShortSearchResult({
            fileUri: fileUriSting,
            line,
            matchStart: character + 1,
            matchLength,
            lineText: lineText.replace(/[\r\n]+$/, ''),
          });

          if (opts && opts.maxResults && searchInfo.resultLength >= opts.maxResults) {
            // 达到设置上限，停止搜索
            this.logger.debug('Reached the set upper limit, stop searching.');
            this.cancel(searchInfo.searchId);
            return true;
          }
          result.push(searchResult);
          this.parityMap.get(searchInfo.searchId)?.node.add(this.resultSignature(searchResult));
          searchInfo.resultLength++;
        }
      }
    });

    if (!result || result.length === 0) {
      return;
    }
    this.sendResultToClient(result, searchInfo.searchId);
  }

  private sendResultToClient(data: ContentSearchResult[], id: number, searchState?: SEARCH_STATE, error?: string) {
    if (this.client) {
      this.client.onSearchResult({
        data,
        id,
        searchState,
        error,
      } as SendClientResult);
    }
  }

  private getSearchArgs(options?: ContentSearchOptions): string[] {
    const args = ['--json', '--max-count=100'];
    args.push(options && options.matchCase ? '--case-sensitive' : '--ignore-case');
    if (options && options.includeIgnored) {
      args.push('-uu');
    }
    if (options && options.include) {
      for (const include of options.include) {
        if (include !== '') {
          args.push('--glob=' + anchorGlob(include));
        }
      }
    }
    if (options && options.exclude) {
      for (const exclude of options.exclude) {
        if (exclude !== '') {
          args.push('--glob=!' + anchorGlob(exclude));
        }
      }
    }

    if (options && options.encoding && options.encoding !== 'utf8') {
      args.push('--encoding', options.encoding);
    }

    if (options?.followSymlinks) {
      args.push('--follow');
    }

    if ((options && options.useRegExp) || (options && options.matchWholeWord)) {
      args.push('--regexp');
    } else {
      args.push('--fixed-strings');
      args.push('--');
    }
    return args;
  }

  dispose(): void {
    this.processMap.forEach((v) => {
      v.dispose();
    });
    this.shadowProcessMap.forEach((v) => v.dispose());
    this.processMap.clear();
    this.shadowProcessMap.clear();
    this.parityMap.clear();
  }

  private async searchWithWorkspaceAgent(
    searchId: number,
    what: string,
    rootUris: string[],
    opts?: ContentSearchOptions,
    shadow = false,
  ): Promise<number> {
    const filter = new FilterFileWithGlobRelativePath(rootUris, opts?.include || []);
    let settled = false;
    if (!shadow) {
      this.sendResultToClient([], searchId, SEARCH_STATE.doing);
    }

    const finish = (error?: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      if (shadow) {
        this.shadowProcessMap.delete(searchId);
        const parity = this.parityMap.get(searchId);
        if (parity) {
          parity.agentDone = true;
          this.finishParity(searchId, parity);
        }
        return;
      }
      this.processMap.delete(searchId);
      if (error) {
        this.searchError(searchId, 'Workspace Agent search failed.');
      } else {
        this.searchEnd(searchId);
      }
    };

    const handle = await this.workspaceAgent!.search(
      {
        requestId: searchId,
        query: what,
        rootPaths: rootUris.map((root) => FileUri.fsPath(root)),
        matchCase: opts?.matchCase ?? false,
        matchWholeWord: opts?.matchWholeWord ?? false,
        useRegexp: opts?.useRegExp ?? false,
        includeIgnored: opts?.includeIgnored ?? false,
        include: (opts?.include || []).filter(Boolean).map((glob) => anchorGlob(glob)),
        exclude: (opts?.exclude || []).filter(Boolean).map((glob) => anchorGlob(glob)),
        encoding: opts?.encoding || 'utf8',
        followSymlinks: opts?.followSymlinks ?? false,
        maxResults: opts?.maxResults || 0,
        ripgrepPath: replaceAsarInPath(rgPath),
      },
      {
        onEvent: (event) => {
          if (settled) {
            return;
          }
          const results = this.convertWorkspaceAgentResults(event, filter);
          if (shadow) {
            const parity = this.parityMap.get(searchId);
            results.forEach((result) => parity?.agent.add(this.resultSignature(result)));
          } else if (results.length > 0) {
            this.sendResultToClient(results, searchId);
          }
        },
        onError: (error) => {
          if (settled) {
            return;
          }
          this.logger.error(
            `Workspace Agent search ${searchId} ${
              isCancelledServiceError(error) ? 'was cancelled unexpectedly' : 'failed'
            } with gRPC code ${error.code}: ${error.details || 'no details'}`,
          );
          finish(error);
        },
        onEnd: () => finish(),
      },
    );
    const cancelHandle: WorkspaceAgentStreamHandle = {
      dispose: () => {
        settled = true;
        handle.dispose();
      },
    };
    if (settled) {
      handle.dispose();
    } else if (shadow) {
      this.shadowProcessMap.set(searchId, cancelHandle);
    } else {
      this.processMap.set(searchId, cancelHandle);
    }
    this.logger.debug(`Workspace Agent ${shadow ? 'shadow ' : ''}search ${searchId} started`);
    return searchId;
  }

  private convertWorkspaceAgentResults(
    event: WorkspaceAgentSearchEvent,
    filter: FilterFileWithGlobRelativePath,
  ): ContentSearchResult[] {
    const results: ContentSearchResult[] = [];
    for (const match of event.matches || []) {
      const fileUri = FileUri.create(match.path).toString();
      if (!filter.test(fileUri)) {
        continue;
      }
      const character = byteRangeLengthToCharacterLength(match.lineText, 0, match.startByte);
      const matchLength = byteRangeLengthToCharacterLength(match.lineText, character, match.endByte - match.startByte);
      results.push(
        cutShortSearchResult({
          fileUri,
          line: match.line,
          matchStart: character + 1,
          matchLength,
          lineText: match.lineText,
        }),
      );
    }
    return results;
  }

  private resultSignature(result: ContentSearchResult): string {
    return `${result.fileUri}\u0000${result.line}\u0000${result.matchStart}\u0000${result.matchLength}\u0000${
      result.lineText || result.renderLineText || ''
    }`;
  }

  private finishParity(searchId: number, parity: SearchParityState): void {
    if (!parity.nodeDone || !parity.agentDone) {
      return;
    }
    const missingFromAgent = Array.from(parity.node).filter((signature) => !parity.agent.has(signature)).length;
    const extraFromAgent = Array.from(parity.agent).filter((signature) => !parity.node.has(signature)).length;
    const summary = {
      searchId,
      nodeResults: parity.node.size,
      agentResults: parity.agent.size,
      missingFromAgent,
      extraFromAgent,
    };
    if (missingFromAgent === 0 && extraFromAgent === 0) {
      this.logger.log(`Workspace Agent shadow search parity passed: ${JSON.stringify(summary)}`);
    } else {
      this.logger.warn(`Workspace Agent shadow search parity mismatch: ${JSON.stringify(summary)}`);
    }
    this.parityMap.delete(searchId);
  }
}
