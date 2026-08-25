import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

export interface MemoryHeadroomOptions {
  minimumFreeMemoryMb: number;
  minimumFreeMemoryPercent: number;
}

export function assertMemoryHeadroom(label: string, options: MemoryHeadroomOptions): void {
  if (process.platform === 'darwin') {
    const minimumFreeMemoryPercent = Number(
      process.env.OPENSUMI_MIN_FREE_MEMORY_PERCENT || options.minimumFreeMemoryPercent,
    );
    const output = execFileSync('/usr/bin/memory_pressure', ['-Q'], { encoding: 'utf8' });
    const freePercentage = Number(output.match(/System-wide memory free percentage: (\d+)%/)?.[1]);
    if (!Number.isFinite(minimumFreeMemoryPercent) || minimumFreeMemoryPercent < 0) {
      throw new Error('OPENSUMI_MIN_FREE_MEMORY_PERCENT must be a non-negative number');
    }
    if (!Number.isFinite(freePercentage)) {
      throw new Error('Unable to read macOS memory pressure');
    }
    if (freePercentage < minimumFreeMemoryPercent) {
      throw new Error(
        `${label} stopped: only ${freePercentage}% memory is free (minimum ${minimumFreeMemoryPercent}%)`,
      );
    }
    return;
  }

  const minimumFreeMemoryMb = Number(process.env.OPENSUMI_MIN_FREE_MEMORY_MB || options.minimumFreeMemoryMb);
  if (!Number.isFinite(minimumFreeMemoryMb) || minimumFreeMemoryMb < 0) {
    throw new Error('OPENSUMI_MIN_FREE_MEMORY_MB must be a non-negative number');
  }
  const linuxAvailableMemoryKb =
    process.platform === 'linux'
      ? Number(fs.readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+)\s+kB/m)?.[1])
      : Number.NaN;
  const freeMemoryMb = Math.floor(
    Number.isFinite(linuxAvailableMemoryKb) ? linuxAvailableMemoryKb / 1024 : os.freemem() / 1024 / 1024,
  );
  if (freeMemoryMb < minimumFreeMemoryMb) {
    throw new Error(
      `${label} stopped: only ${freeMemoryMb} MiB memory is available (minimum ${minimumFreeMemoryMb} MiB)`,
    );
  }
}
