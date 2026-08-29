import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { FileUri } from '@opensumi/ide-core-node';

import { FileType } from '../../src/common';
import { DiskFileSystemProvider } from '../../src/node/disk-file-system.provider';

describe('DiskFileSystemProvider readDirectory', () => {
  let directory: string;
  const provider = Object.create(DiskFileSystemProvider.prototype) as DiskFileSystemProvider;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'opensumi-read-directory-'));
  });

  afterEach(async () => {
    await rm(directory, { force: true, recursive: true });
  });

  it('uses directory entry metadata while preserving followed symlink types', async () => {
    expect.assertions(1);
    const filePath = path.join(directory, 'file.txt');
    const folderPath = path.join(directory, 'folder');
    await Promise.all([writeFile(filePath, 'content\n'), mkdir(folderPath)]);
    await Promise.all([
      symlink(filePath, path.join(directory, 'file-link')),
      symlink(folderPath, path.join(directory, 'folder-link')),
    ]);

    const entries = await provider.readDirectory(FileUri.create(directory).codeUri);

    expect(entries.slice().sort(([left], [right]) => left.localeCompare(right))).toEqual([
      ['file-link', FileType.File],
      ['file.txt', FileType.File],
      ['folder', FileType.Directory],
      ['folder-link', FileType.Directory],
    ]);
  });

  it('keeps the historical empty result for an unreadable or missing directory', async () => {
    expect.assertions(1);
    await expect(provider.readDirectory(FileUri.create(path.join(directory, 'missing')).codeUri)).resolves.toEqual([]);
  });
});
