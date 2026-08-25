import path from 'path';

import fse from 'fs-extra';

import { startFromFolder } from './fn/module';
import { run } from './fn/shell';

const folderName = 'tools/electron';

async function main() {
  const semaphore = path.resolve(folderName, 'node_modules/.init-done');

  if (!fse.existsSync(semaphore)) {
    await fse.remove(path.resolve(folderName, 'node_modules'));
    await run('pnpm --dir tools/electron install');
    await run('pnpm --dir tools/electron run link-local');
    await run('pnpm --dir tools/electron run rebuild-native');
    await run('pnpm --dir tools/electron run build');
    fse.closeSync(fse.openSync(semaphore, 'a'));
  }

  startFromFolder(folderName, 'start');
}

main();
