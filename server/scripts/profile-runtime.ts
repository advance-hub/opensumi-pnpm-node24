import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { collectProcessTreeMemory } from './process-tree';
import { summarizeRuntimeProfile } from './runtime-profile-metrics';

import type { ProcessTreeMemorySnapshot } from './process-tree';
import type { RuntimeProfileMetrics } from './runtime-profile-metrics';

const repoRoot = path.resolve(import.meta.dirname, '../..');

interface ProfileOptions {
  rootPid: number;
  durationMs: number;
  intervalMs: number;
  outputPath?: string;
  label: string;
  variant?: 'node' | 'agent';
  sessions?: number;
  run?: number;
}

interface ProfileSummary extends RuntimeProfileMetrics {
  schemaVersion: 2;
  type: 'summary';
  label: string;
  variant?: 'node' | 'agent';
  sessions?: number;
  run?: number;
  rootPid: number;
  startedAt: string;
  finishedAt: string;
  sampleCount: number;
  baselineTreeRssBytes: number;
  finalTreeRssBytes: number;
  retainedTreeRssBytes: number;
}

function usage(): string {
  return [
    'Usage: pnpm --dir server profile:runtime -- --pid <pid> [options]',
    '',
    'Options:',
    '  --duration <seconds>   Sampling duration, default 60',
    '  --interval <ms>        Sampling interval, default 2000',
    '  --output <path>        Also write JSONL to this file',
    '  --label <name>         Workload label stored in every event',
    '  --variant <node|agent>  Runtime variant for paired capacity reports',
    '  --sessions <count>      Number of active browser sessions',
    '  --run <number>          One-based repetition number',
  ].join('\n');
}

function readPositiveNumber(name: string, value: string | undefined, fallback?: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (parsed === undefined || !Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return parsed;
}

function readPositiveInteger(name: string, value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseOptions(argv: string[]): ProfileOptions | undefined {
  argv = argv.filter((argument) => argument !== '--');
  if (argv.includes('--help')) {
    process.stdout.write(`${usage()}\n`);
    return undefined;
  }
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) {
      throw new Error(`Unexpected argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${argument}`);
    }
    values.set(argument, value);
    index += 1;
  }

  const knownOptions = new Set([
    '--pid',
    '--duration',
    '--interval',
    '--output',
    '--label',
    '--variant',
    '--sessions',
    '--run',
  ]);
  const unknownOptions = Array.from(values.keys()).filter((option) => !knownOptions.has(option));
  if (unknownOptions.length > 0) {
    throw new Error(`Unknown options: ${unknownOptions.join(', ')}`);
  }

  const variant = values.get('--variant');
  if (variant !== undefined && variant !== 'node' && variant !== 'agent') {
    throw new Error('--variant must be node or agent');
  }

  return {
    rootPid: readPositiveNumber('--pid', values.get('--pid')),
    durationMs: readPositiveNumber('--duration', values.get('--duration'), 60) * 1000,
    intervalMs: readPositiveNumber('--interval', values.get('--interval'), 2000),
    outputPath: values.get('--output') ? path.resolve(repoRoot, values.get('--output')!) : undefined,
    label: values.get('--label') || 'opensumi-runtime',
    variant,
    sessions: readPositiveInteger('--sessions', values.get('--sessions')),
    run: readPositiveInteger('--run', values.get('--run')),
  };
}

async function runProfile(options: ProfileOptions): Promise<ProfileSummary> {
  if (!Number.isSafeInteger(options.rootPid)) {
    throw new Error('--pid must be a positive integer');
  }
  if (options.intervalMs > options.durationMs) {
    throw new Error('--interval cannot be greater than --duration');
  }

  if (options.outputPath) {
    await mkdir(path.dirname(options.outputPath), { recursive: true });
    await writeFile(options.outputPath, '');
  }

  const emit = async (event: unknown) => {
    const line = `${JSON.stringify(event)}\n`;
    process.stdout.write(line);
    if (options.outputPath) {
      await appendFile(options.outputPath, line);
    }
  };

  const startedAt = new Date().toISOString();
  const deadline = Date.now() + options.durationMs;
  let interrupted = false;
  const handleSignal = () => {
    interrupted = true;
  };
  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);

  const samples: ProcessTreeMemorySnapshot[] = [];

  try {
    do {
      const sample = await collectProcessTreeMemory(options.rootPid);
      samples.push(sample);
      await emit({
        schemaVersion: 2,
        type: 'sample',
        label: options.label,
        variant: options.variant,
        sessions: options.sessions,
        run: options.run,
        ...sample,
      });
      if (!interrupted && Date.now() < deadline) {
        await delay(Math.min(options.intervalMs, Math.max(0, deadline - Date.now())));
      }
    } while (!interrupted && Date.now() < deadline);
  } finally {
    process.off('SIGINT', handleSignal);
    process.off('SIGTERM', handleSignal);
  }

  const baseline = samples[0];
  const finalSample = samples.at(-1);
  if (!baseline || !finalSample) {
    throw new Error('No process samples were collected');
  }
  const metrics = summarizeRuntimeProfile(samples);
  const summary: ProfileSummary = {
    schemaVersion: 2,
    type: 'summary',
    label: options.label,
    variant: options.variant,
    sessions: options.sessions,
    run: options.run,
    rootPid: options.rootPid,
    startedAt,
    finishedAt: new Date().toISOString(),
    baselineTreeRssBytes: baseline.totalRssBytes,
    finalTreeRssBytes: finalSample.totalRssBytes,
    retainedTreeRssBytes: finalSample.totalRssBytes - baseline.totalRssBytes,
    ...metrics,
  };
  await emit(summary);
  return summary;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (!options) {
    return;
  }
  await runProfile(options);
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n\n${usage()}\n`);
  process.exitCode = 1;
});
