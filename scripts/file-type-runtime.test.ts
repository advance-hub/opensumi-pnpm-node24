import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { getFileType } from '../packages/file-service/src/node/hosted/shared/file-type';

test('file-type 21 loads in the Node 24 runtime and classifies text and images', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'opensumi-file-type-'));
  try {
    const textPath = path.join(directory, 'sample.txt');
    const imagePath = path.join(directory, 'sample.png');
    await writeFile(textPath, 'OpenSumi production file type smoke');
    await writeFile(
      imagePath,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
      ),
    );

    assert.equal(await getFileType(pathToFileURL(textPath).toString()), 'text');
    assert.equal(await getFileType(pathToFileURL(imagePath).toString()), 'image');
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
