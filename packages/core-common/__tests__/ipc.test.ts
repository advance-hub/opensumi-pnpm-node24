import { tmpdir } from 'os';

import { normalizedIpcHandlerPath, normalizedIpcHandlerPathAsync } from '../src/utils/ipc';

describe('normalized IPC paths', () => {
  it('keeps randomized Unix socket paths below the macOS limit', async () => {
    if (process.platform === 'win32') {
      return;
    }

    const syncPath = normalizedIpcHandlerPath('watcher_process', true);
    const asyncPath = await normalizedIpcHandlerPathAsync('watcher_process', true);

    expect(syncPath).toMatch(/\/sumi-ipc\/s-watcher_process-[\w-]{10}\.sock$/);
    expect(asyncPath).toMatch(/\/sumi-ipc\/s-watcher_process-[\w-]{10}\.sock$/);
    expect(Buffer.byteLength(syncPath)).toBeLessThan(104);
    expect(Buffer.byteLength(asyncPath)).toBeLessThan(104);
    expect(syncPath.startsWith(tmpdir())).toBe(true);
  });
});
