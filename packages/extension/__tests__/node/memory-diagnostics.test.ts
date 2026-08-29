import { mkdtemp, readFile, rm } from 'fs/promises';
import os from 'os';
import path from 'path';

import { startMemoryDiagnostics } from '../../src/hosted/memory-diagnostics';

describe('Extension Host memory diagnostics', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'ext-host-mem-diag-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('is a no-op without the diagnostics path env', () => {
    expect(startMemoryDiagnostics({})).toBeUndefined();
  });

  it('writes memoryUsage JSONL samples and stops on demand', async () => {
    const outputPath = path.join(tempDir, 'memory.jsonl');
    const handle = startMemoryDiagnostics({
      EXTENSION_HOST_MEMORY_DIAGNOSTICS_PATH: outputPath,
      EXTENSION_HOST_MEMORY_DIAGNOSTICS_INTERVAL_MS: '100',
    });

    expect(handle).toBeDefined();

    // Samples go through an async write stream, so wait until the first
    // sample actually lands on disk before asserting its shape.
    const readLines = async (): Promise<string[]> => {
      const content = await readFile(outputPath, 'utf8').catch(() => '');
      return content.trim().split('\n').filter(Boolean);
    };
    let lines = await readLines();
    for (let i = 0; i < 50 && lines.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      lines = await readLines();
    }
    const firstSample = JSON.parse(lines[0]);
    expect(firstSample.pid).toBe(process.pid);
    expect(firstSample.rssBytes).toBeGreaterThan(0);
    expect(firstSample.heapUsedBytes).toBeGreaterThan(0);
    expect(firstSample.externalBytes).toBeGreaterThanOrEqual(0);
    expect(typeof firstSample.timestamp).toBe('number');

    await new Promise((resolve) => setTimeout(resolve, 350));
    handle!.stop();

    lines = await readLines();
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) {
      const sample = JSON.parse(line);
      expect(sample.pid).toBe(process.pid);
      expect(sample.rssBytes).toBeGreaterThan(0);
    }
  });

  it('keeps running after stop and never throws when the path is unwritable', () => {
    const handle = startMemoryDiagnostics({
      EXTENSION_HOST_MEMORY_DIAGNOSTICS_PATH: path.join(tempDir, 'missing-dir', 'memory.jsonl'),
    });
    // createWriteStream on a missing directory emits an async error rather than
    // throwing; the handle must still be returned and stoppable.
    expect(handle).toBeDefined();
    handle!.stop();
  });
});
