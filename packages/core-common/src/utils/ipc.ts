import { tmpdir } from 'os';
import { dirname, join } from 'path';

import { ensureDir, ensureDirSync } from 'fs-extra';

import { isWindows, uuid } from '@opensumi/ide-utils';

export function normalizedIpcHandlerPath(name: string, uuidSuffix = false, ipcPath = tmpdir()) {
  let handler: string;
  if (!isWindows) {
    // macOS limits Unix-domain socket paths to roughly 104 bytes. Keep the
    // random suffix compact so deep temporary/custom IPC directories remain
    // usable while still avoiding collisions between concurrent processes.
    handler = join(ipcPath, 'sumi-ipc', `s-${name}${uuidSuffix ? `-${uuid(10)}` : ''}.sock`);
    ensureDirSync(dirname(handler));
  } else {
    handler = `\\\\.\\pipe\\sumi-ipc-${name}${uuidSuffix ? uuid() : ''}`;
  }
  return handler;
}

export async function normalizedIpcHandlerPathAsync(name: string, uuidSuffix = false, ipcPath = tmpdir()) {
  let handler: string;
  if (!isWindows) {
    handler = join(ipcPath, 'sumi-ipc', `s-${name}${uuidSuffix ? `-${uuid(10)}` : ''}.sock`);
    await ensureDir(dirname(handler));
  } else {
    handler = `\\\\.\\pipe\\sumi-ipc-${name}${uuidSuffix ? uuid() : ''}`;
  }
  return handler;
}
