import readline from 'readline';

import { Autowired, Injectable, Optional } from '@opensumi/di';
import { CancellationToken, CancellationTokenSource, URI, path } from '@opensumi/ide-core-common';
import { FileUri, INodeLogger } from '@opensumi/ide-core-node';
import {
  WorkspaceAgentClient,
  WorkspaceAgentClientToken,
  WorkspaceAgentFileSearchRoot,
  parseWorkspaceAgentMode,
} from '@opensumi/ide-file-service/lib/node/workspace-agent';
import { IProcessFactory } from '@opensumi/ide-process';
import { rgPath } from '@opensumi/ripgrep';

import { IFileSearchService } from '../common';

const { replaceAsarInPath, Path, dirname } = path;

@Injectable()
export class FileSearchService implements IFileSearchService {
  @Autowired(IProcessFactory)
  processFactory: IProcessFactory;

  @Autowired(INodeLogger)
  logger: INodeLogger;

  constructor(
    @Optional(WorkspaceAgentClientToken)
    private readonly workspaceAgent?: WorkspaceAgentClient,
  ) {}

  private isAbsolutePathPattern(pattern: string): boolean {
    return path.isAbsolute(pattern) || pattern.startsWith('/') || pattern.startsWith('\\');
  }

  /**
   * `fuzzy.test` builds a rendered result array for every candidate even though
   * file search only needs a boolean subsequence check. Keep the same
   * case-insensitive matching semantics without retaining that allocation cost.
   */
  private isFuzzyMatch(pattern: string, candidate: string): boolean {
    const normalizedPattern = pattern.toLowerCase();
    const normalizedCandidate = candidate.toLowerCase();
    let patternIndex = 0;

    for (const candidateChar of normalizedCandidate) {
      if (candidateChar === normalizedPattern[patternIndex]) {
        patternIndex++;
        if (patternIndex === normalizedPattern.length) {
          return true;
        }
      }
    }

    return normalizedPattern.length === 0;
  }

  // 这里应该返回文件的 `fsPath` 而非 `file://` 协议文件路径
  // 否则在 Windows 下，盘符路径会被隐藏
  async find(
    searchPattern: string,
    options: IFileSearchService.Options,
    clientToken?: CancellationToken,
  ): Promise<string[]> {
    const mode = parseWorkspaceAgentMode(process.env.OPENSUMI_WORKSPACE_AGENT_FILE_SEARCH_MODE);
    if (mode === 'enabled' && this.workspaceAgent) {
      try {
        return await this.findWithWorkspaceAgent(searchPattern, options, clientToken);
      } catch (error) {
        this.logger.error(`Workspace Agent file search failed; falling back to Node.\n${error}`);
      }
    }
    if (mode === 'shadow-read' && this.workspaceAgent) {
      const agentOutcome = this.findWithWorkspaceAgent(searchPattern, options, clientToken).then(
        (paths) => ({ paths }),
        (error) => ({ error }),
      );
      const nodeResult = await this.findWithNode(searchPattern, options, clientToken);
      void agentOutcome.then((outcome) => {
        if (clientToken?.isCancellationRequested) {
          return;
        }
        if ('error' in outcome) {
          this.logger.warn(`Workspace Agent shadow file search failed.\n${outcome.error}`);
        } else {
          this.reportAgentParity(searchPattern, nodeResult, outcome.paths, options.limit);
        }
      });
      return nodeResult;
    }
    return this.findWithNode(searchPattern, options, clientToken);
  }

  private normalizeRequest(searchPattern: string, options: IFileSearchService.Options) {
    const opts = {
      ...options,
      fuzzyMatch: options.fuzzyMatch ?? true,
      limit:
        options.limit === undefined || !Number.isSafeInteger(options.limit) || options.limit < 0
          ? Number.MAX_SAFE_INTEGER
          : options.limit,
      useGitIgnore: options.useGitIgnore ?? true,
    };

    const roots: IFileSearchService.RootOptions = Object.fromEntries(
      Object.entries(options.rootOptions || {}).map(([rootUri, rootOptions]) => [
        rootUri,
        {
          ...rootOptions,
          includePatterns: rootOptions.includePatterns ? [...rootOptions.includePatterns] : undefined,
          excludePatterns: rootOptions.excludePatterns ? [...rootOptions.excludePatterns] : undefined,
        },
      ]),
    );
    let effectivePattern = searchPattern;

    // 如果传入绝对路径，则将父级目录作为根目录
    if (this.isAbsolutePathPattern(searchPattern)) {
      const parent = path.dirname(searchPattern);
      roots[parent] = {};
      effectivePattern = path.basename(searchPattern);
    }

    if (options.rootUris) {
      for (const rootUri of options.rootUris) {
        if (!roots[rootUri]) {
          roots[rootUri] = {};
        }
      }
    }

    // eslint-disable-next-line guard-for-in
    for (const rootUri in roots) {
      const rootOptions = roots[rootUri];
      if (opts.includePatterns) {
        const includePatterns = rootOptions.includePatterns || [];
        rootOptions.includePatterns = [...includePatterns, ...opts.includePatterns];
      }
      if (opts.excludePatterns) {
        const excludePatterns = rootOptions.excludePatterns || [];
        rootOptions.excludePatterns = [...excludePatterns, ...opts.excludePatterns];
      }
      if (rootOptions.useGitIgnore === undefined) {
        rootOptions.useGitIgnore = opts.useGitIgnore;
      }
      if (rootOptions.noIgnoreParent === undefined) {
        rootOptions.noIgnoreParent = opts.noIgnoreParent;
      }
      if (rootOptions.followSymlinks === undefined) {
        rootOptions.followSymlinks = opts.followSymlinks;
      }
    }

    return { effectivePattern, opts, roots };
  }

  private async findWithNode(
    searchPattern: string,
    options: IFileSearchService.Options,
    clientToken?: CancellationToken,
  ): Promise<string[]> {
    const cancellationSource = new CancellationTokenSource(clientToken);
    const token = cancellationSource.token;
    const { effectivePattern, opts, roots } = this.normalizeRequest(searchPattern, options);
    const stringPattern = effectivePattern.toLocaleLowerCase();

    const exactMatches = new Set<string>();
    const fuzzyMatches = new Set<string>();

    try {
      await Promise.all(
        Object.keys(roots).map(async (cwd) => {
          try {
            const rootOptions = roots[cwd];
            const rootUri = URI.isUriString(cwd) ? new URI(cwd) : undefined;
            const rootPath = rootUri?.scheme === 'file' ? FileUri.fsPath(rootUri) : cwd;
            await this.doFind(
              rootPath,
              rootOptions,
              (candidate) => {
                const fileUri = path.join(rootPath, candidate);

                if (exactMatches.has(fileUri) || fuzzyMatches.has(fileUri)) {
                  return;
                }
                if (
                  !effectivePattern ||
                  effectivePattern === '*' ||
                  candidate.toLocaleLowerCase().indexOf(stringPattern) !== -1
                ) {
                  exactMatches.add(fileUri);
                } else if (opts.fuzzyMatch && this.isFuzzyMatch(effectivePattern, candidate)) {
                  fuzzyMatches.add(fileUri);
                }
                if (exactMatches.size + fuzzyMatches.size === opts.limit) {
                  cancellationSource.cancel();
                }
              },
              token,
            );
          } catch (e) {
            this.logger.error(`Failed to search on path ${cwd}.\n${e}`);
          }
        }),
      );
    } finally {
      cancellationSource.dispose();
    }
    return this.sortMatches(exactMatches, fuzzyMatches);
  }

  private async findWithWorkspaceAgent(
    searchPattern: string,
    options: IFileSearchService.Options,
    clientToken?: CancellationToken,
  ): Promise<string[]> {
    if (!this.workspaceAgent) {
      throw new Error('Workspace Agent is not available');
    }
    const { effectivePattern, opts, roots } = this.normalizeRequest(searchPattern, options);
    const agentRoots: WorkspaceAgentFileSearchRoot[] = Object.entries(roots).map(([root, rootOptions]) => {
      const rootUri = URI.isUriString(root) ? new URI(root) : undefined;
      return {
        rootPath: rootUri?.scheme === 'file' ? FileUri.fsPath(rootUri) : root,
        include: rootOptions.includePatterns || [],
        exclude: rootOptions.excludePatterns || [],
        useGitIgnore: Boolean(rootOptions.useGitIgnore),
        noIgnoreParent: Boolean(rootOptions.noIgnoreParent),
        followSymlinks: Boolean(rootOptions.followSymlinks),
      };
    });
    const result = await this.workspaceAgent.fileSearch(
      {
        pattern: effectivePattern,
        roots: agentRoots,
        fuzzyMatch: Boolean(opts.fuzzyMatch),
        maxResults: opts.limit,
        ripgrepPath: replaceAsarInPath(rgPath),
      },
      clientToken,
    );
    return this.sortMatches(new Set(result.exactPaths), new Set(result.fuzzyPaths));
  }

  private sortMatches(exactMatches: Set<string>, fuzzyMatches: Set<string>): string[] {
    const sortedExactMatches = Array.from(exactMatches).sort((a, b) => {
      const depthA = Path.pathDepth(a);
      const depthB = Path.pathDepth(b);
      if (depthA === depthB) {
        const dirA = dirname(a);
        const dirB = dirname(b);
        return dirB.localeCompare(dirA, 'en', { numeric: true });
      } else {
        return depthB - depthA;
      }
    });

    return [...sortedExactMatches, ...fuzzyMatches];
  }

  private reportAgentParity(
    searchPattern: string,
    nodePaths: string[],
    agentPaths: string[],
    configuredLimit?: number,
  ): void {
    if (
      configuredLimit !== undefined &&
      configuredLimit > 0 &&
      nodePaths.length >= configuredLimit &&
      agentPaths.length >= configuredLimit
    ) {
      // ripgrep traversal order is not stable, including between two Node runs.
      // Once both sides hit the cap, cardinality is the only valid parity signal.
      this.logger.debug(
        `Workspace Agent file search parity reached the shared ${configuredLimit} result cap for ${JSON.stringify(searchPattern)}`,
      );
      return;
    }
    const node = new Set(nodePaths);
    const agent = new Set(agentPaths);
    const nodeOnly = nodePaths.filter((candidate) => !agent.has(candidate));
    const agentOnly = agentPaths.filter((candidate) => !node.has(candidate));
    if (nodeOnly.length === 0 && agentOnly.length === 0) {
      this.logger.debug(`Workspace Agent file search parity matched for ${JSON.stringify(searchPattern)}`);
      return;
    }
    this.logger.warn(
      `Workspace Agent file search parity mismatch for ${JSON.stringify(searchPattern)}: Node-only ${nodeOnly.length}, Agent-only ${agentOnly.length}`,
    );
  }

  private doFind(
    cwd: string,
    options: IFileSearchService.BaseOptions,
    accept: (fileUri: string) => void,
    token: CancellationToken,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const args = this.getSearchArgs(options);

        const process = this.processFactory.create({ command: replaceAsarInPath(rgPath), args, options: { cwd } });
        const lineReader = readline.createInterface({
          input: process.outputStream,
          output: process.inputStream,
        });
        let settled = false;
        let cancellationDisposable: { dispose(): void } | undefined;
        let errorDisposable: { dispose(): void } | undefined;
        const finish = (error?: unknown) => {
          if (settled) {
            return;
          }
          settled = true;
          cancellationDisposable?.dispose();
          errorDisposable?.dispose();
          lineReader.close();
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        };
        errorDisposable = process.onError(finish);
        process.outputStream.on('close', () => finish());
        cancellationDisposable = token.onCancellationRequested(() => process.dispose());
        lineReader.on('line', (line) => {
          if (token.isCancellationRequested) {
            process.dispose();
          } else {
            accept(line);
          }
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  private getSearchArgs(options: IFileSearchService.BaseOptions): string[] {
    const args = ['--files', '--hidden', '--case-sensitive', '--no-require-git'];

    if (options.includePatterns) {
      for (const includePattern of options.includePatterns) {
        if (includePattern) {
          args.push('--glob', includePattern);
        }
      }
    }
    if (options.excludePatterns) {
      for (const excludePattern of options.excludePatterns) {
        if (excludePattern) {
          args.push('--glob', `!${excludePattern}`);
        }
      }
    }
    if (!options.useGitIgnore) {
      args.push('-uu');
    }
    if (options.noIgnoreParent) {
      args.push('--no-ignore-parent');
    }
    if (options.followSymlinks) {
      args.push('--follow');
    }
    return args;
  }
}
