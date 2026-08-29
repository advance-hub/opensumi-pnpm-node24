import fs from 'fs';

export const EXTENSION_HOST_MEMORY_DIAGNOSTICS_PATH = 'EXTENSION_HOST_MEMORY_DIAGNOSTICS_PATH';
export const EXTENSION_HOST_MEMORY_DIAGNOSTICS_INTERVAL_MS = 'EXTENSION_HOST_MEMORY_DIAGNOSTICS_INTERVAL_MS';

const MIN_INTERVAL_MS = 100;
const DEFAULT_INTERVAL_MS = 1000;

export interface ExtensionHostMemorySample {
  timestamp: number;
  pid: number;
  rssBytes: number;
  heapTotalBytes: number;
  heapUsedBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
}

export interface MemoryDiagnosticsHandle {
  stop(): void;
}

/**
 * Periodically appends this process's memoryUsage() as JSONL so an external
 * profiler can split the extension host RSS into V8 heap, external buffers
 * and native residue. Opt-in only: without EXTENSION_HOST_MEMORY_DIAGNOSTICS_PATH
 * this is a no-op and stays out of the production path.
 */
export function startMemoryDiagnostics(env: NodeJS.ProcessEnv = process.env): MemoryDiagnosticsHandle | undefined {
  const outputPath = env[EXTENSION_HOST_MEMORY_DIAGNOSTICS_PATH];
  if (!outputPath) {
    return undefined;
  }
  const configuredInterval = Number(env[EXTENSION_HOST_MEMORY_DIAGNOSTICS_INTERVAL_MS]);
  const intervalMs =
    Number.isFinite(configuredInterval) && configuredInterval > 0
      ? Math.max(MIN_INTERVAL_MS, configuredInterval)
      : DEFAULT_INTERVAL_MS;

  let stream: fs.WriteStream;
  try {
    stream = fs.createWriteStream(outputPath, { flags: 'a' });
    stream.on('error', () => {
      // The profiler that requested the file is gone or the path is unwritable;
      // diagnostics must never take the extension host down with it.
      stop();
    });
  } catch {
    return undefined;
  }

  const sampleOnce = () => {
    const usage = process.memoryUsage();
    const sample: ExtensionHostMemorySample = {
      timestamp: Date.now(),
      pid: process.pid,
      rssBytes: usage.rss,
      heapTotalBytes: usage.heapTotal,
      heapUsedBytes: usage.heapUsed,
      externalBytes: usage.external,
      arrayBuffersBytes: usage.arrayBuffers,
    };
    stream.write(`${JSON.stringify(sample)}\n`);
  };

  sampleOnce();
  const timer = setInterval(sampleOnce, intervalMs);
  timer.unref?.();

  function stop() {
    clearInterval(timer);
    stream.end();
  }

  return { stop };
}
