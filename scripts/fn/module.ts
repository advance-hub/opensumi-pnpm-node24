import fs from 'node:fs';
import * as path from 'path';

import { packageName, packagesDir } from './dir-constants';
import { run } from './shell';

export function getPkgFromFolder(folderName: string) {
  const packageJsonPath = path.join(packagesDir, `./${folderName}/${packageName}`);
  return JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { name: string };
}

export async function startFromFolder(folderName: string, scriptName: string = 'start') {
  await run(`pnpm --dir ${folderName} run ${scriptName}`);
}

export async function addNodeDep(folderName: string, depName: string) {
  const pkg = getPkgFromFolder(folderName);
  await addDep(depName, pkg.name);
}

export async function addBrowserDep(depName: string) {
  const pkg = getPkgFromFolder('core-browser');
  await addDep(depName, pkg.name);
}

export async function addDep(depName: string, pkgName: string) {
  await run(`pnpm --filter ${pkgName} add ${depName}`);
  await run('pnpm run init');
}
