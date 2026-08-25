import { join } from 'path';

import { Config } from '@jest/types';
import * as jest from 'jest';

import { argv } from '../../packages/core-common/src/node/cli';

export async function runTest(target: string, options: { project?: string; runInBand?: boolean } = {}) {
  const { project, runInBand } = options;
  const jestArgv = { ...argv } as Record<string, unknown>;
  for (const internalArg of ['_', 'module', 'project', 'runInBand']) {
    delete jestArgv[internalArg];
  }

  return await jest.runCLI(
    {
      ...jestArgv,
      runInBand,
      bail: true,
      passWithNoTests: true,
      testPathPattern: [`packages/${target}/__tests?__/.*\\.(test|spec)\\.[jt]sx?$`],
      selectProjects: project ? [project] : undefined,
      detectOpenHandles: true,
      forceExit: true,
      config: join(process.cwd(), 'configs/jest/jest.config.ts'),
    } as unknown as Config.Argv,
    [process.cwd()],
  );
}
