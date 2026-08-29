import os from 'os';
import path from 'path';

import { StoragePaths } from '@opensumi/ide-core-common';

export const CLI_DEVELOPMENT_PATH = path.join(os.homedir(), `${StoragePaths.DEFAULT_STORAGE_DIR_NAME}-dev`);

function getClientIp(): string {
  for (const network of Object.values(os.networkInterfaces())) {
    const address = network?.find((entry) => entry.family === 'IPv4' && !entry.internal)?.address;
    if (address) {
      return address;
    }
  }
  return '127.0.0.1';
}

export const CLIENT_IP = getClientIp();
