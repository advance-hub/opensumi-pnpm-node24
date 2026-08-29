import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { compareRuntimeLatencies, compareRuntimeProfiles, summarizeRuntimeProfile } from './runtime-profile-metrics';

import type { ProcessTreeMemorySnapshot } from './process-tree';

const repoRoot = path.resolve(import.meta.dirname, '../..');

interface ComparisonOptions {
  nodeFiles: string[];
  agentFiles: string[];
  sessions: number;
  minimumRuns: number;
  outputPath?: string;
}

interface SampleEvent extends ProcessTreeMemorySnapshot {
  type: 'sample';
  variant?: 'node' | 'agent';
  sessions?: number;
  run?: number;
}

interface WorkloadReadyEvent {
  type: 'browser-workload-ready';
  variant?: 'node' | 'agent';
  sessions?: number;
  run?: number;
  searchLatencyP95Ms?: number;
  fileSearchLatencyP95Ms?: number;
  consoleErrorCount?: number;
}

interface SummaryEvent {
  type: 'summary';
  variant?: 'node' | 'agent';
  sessions?: number;
  run?: number;
  searchLatencyP95Ms?: number;
  fileSearchLatencyP95Ms?: number;
  consoleErrorCount?: number;
}

interface LoadedProfile {
  samples: ProcessTreeMemorySnapshot[];
  run?: number;
  searchLatencyP95Ms?: number;
  fileSearchLatencyP95Ms?: number;
}

function usage(): string {
  return [
    'Usage: pnpm --dir server compare:runtime -- --sessions <count> --node <jsonl> --agent <jsonl> [options]',
    '',
    'Repeat --node and --agent for each paired run (three runs are required by default).',
    '',
    'Options:',
    '  --minimum-runs <count>  Required runs per variant, default 3',
    '  --output <path>         Also write the comparison JSON to this file',
  ].join('\n');
}

function parsePositiveInteger(name: string, value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseOptions(argv: string[]): ComparisonOptions | undefined {
  argv = argv.filter((argument) => argument !== '--');
  if (argv.includes('--help')) {
    process.stdout.write(`${usage()}\n`);
    return undefined;
  }
  const nodeFiles: string[] = [];
  const agentFiles: string[] = [];
  let sessions: string | undefined;
  let minimumRuns: string | undefined;
  let outputPath: string | undefined;
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!option?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`Invalid option near ${option || '<end>'}`);
    }
    if (option === '--node') {
      nodeFiles.push(path.resolve(repoRoot, value));
    } else if (option === '--agent') {
      agentFiles.push(path.resolve(repoRoot, value));
    } else if (option === '--sessions') {
      sessions = value;
    } else if (option === '--minimum-runs') {
      minimumRuns = value;
    } else if (option === '--output') {
      outputPath = path.resolve(repoRoot, value);
    } else {
      throw new Error(`Unknown option: ${option}`);
    }
  }
  const parsedMinimumRuns = parsePositiveInteger('--minimum-runs', minimumRuns || '3');
  if (new Set(nodeFiles).size !== nodeFiles.length || new Set(agentFiles).size !== agentFiles.length) {
    throw new Error('Each runtime profile file may only be supplied once per variant');
  }
  if (nodeFiles.length < parsedMinimumRuns || agentFiles.length < parsedMinimumRuns) {
    throw new Error(
      `At least ${parsedMinimumRuns} Node and Agent profiles are required; received ${nodeFiles.length} and ${agentFiles.length}`,
    );
  }
  if (nodeFiles.length !== agentFiles.length) {
    throw new Error(`Node and Agent profile counts differ (${nodeFiles.length} versus ${agentFiles.length})`);
  }
  return {
    nodeFiles,
    agentFiles,
    sessions: parsePositiveInteger('--sessions', sessions),
    minimumRuns: parsedMinimumRuns,
    outputPath,
  };
}

async function loadProfile(
  filePath: string,
  expectedVariant: 'node' | 'agent',
  expectedSessions: number,
): Promise<LoadedProfile> {
  const contents = await readFile(filePath, 'utf8');
  const events = contents
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line) as Partial<SampleEvent> | Partial<WorkloadReadyEvent> | Partial<SummaryEvent>;
      } catch (error) {
        throw new Error(`${filePath}:${index + 1} is not valid JSON`, { cause: error });
      }
    });
  const samples = events.filter((event): event is SampleEvent => event.type === 'sample');
  if (samples.length === 0) {
    throw new Error(`${filePath} contains no runtime samples`);
  }
  for (const sample of samples) {
    if (sample.variant && sample.variant !== expectedVariant) {
      throw new Error(`${filePath} is marked as ${sample.variant}, expected ${expectedVariant}`);
    }
    if (sample.sessions !== undefined && sample.sessions !== expectedSessions) {
      throw new Error(`${filePath} contains ${sample.sessions} sessions, expected ${expectedSessions}`);
    }
    if (!Number.isFinite(sample.totalRssBytes) || !Number.isSafeInteger(sample.processCount)) {
      throw new Error(`${filePath} contains an invalid process-tree sample`);
    }
  }
  const workloadEvents = events.filter((event): event is WorkloadReadyEvent => event.type === 'browser-workload-ready');
  if (workloadEvents.length > 1) {
    throw new Error(`${filePath} contains more than one browser-workload-ready event`);
  }
  const workload = workloadEvents[0];
  const summaryEvents = events.filter((event): event is SummaryEvent => event.type === 'summary');
  if (summaryEvents.length > 1) {
    throw new Error(`${filePath} contains more than one summary event`);
  }
  const summary = summaryEvents[0];
  if (workload) {
    if (workload.variant && workload.variant !== expectedVariant) {
      throw new Error(`${filePath} workload is marked as ${workload.variant}, expected ${expectedVariant}`);
    }
    if (workload.sessions !== undefined && workload.sessions !== expectedSessions) {
      throw new Error(`${filePath} workload contains ${workload.sessions} sessions, expected ${expectedSessions}`);
    }
    if (!Number.isFinite(workload.searchLatencyP95Ms) || workload.searchLatencyP95Ms! <= 0) {
      throw new Error(`${filePath} contains an invalid searchLatencyP95Ms`);
    }
    if (
      workload.fileSearchLatencyP95Ms !== undefined &&
      (!Number.isFinite(workload.fileSearchLatencyP95Ms) || workload.fileSearchLatencyP95Ms <= 0)
    ) {
      throw new Error(`${filePath} contains an invalid fileSearchLatencyP95Ms`);
    }
    if (workload.consoleErrorCount !== 0) {
      throw new Error(`${filePath} recorded ${workload.consoleErrorCount ?? 'unknown'} browser error(s)`);
    }
    if (!summary) {
      throw new Error(`${filePath} contains workload evidence without a final summary`);
    }
  }
  if (summary) {
    if (summary.variant && summary.variant !== expectedVariant) {
      throw new Error(`${filePath} summary is marked as ${summary.variant}, expected ${expectedVariant}`);
    }
    if (summary.sessions !== undefined && summary.sessions !== expectedSessions) {
      throw new Error(`${filePath} summary contains ${summary.sessions} sessions, expected ${expectedSessions}`);
    }
    if (summary.consoleErrorCount !== 0) {
      throw new Error(`${filePath} summary recorded ${summary.consoleErrorCount ?? 'unknown'} browser error(s)`);
    }
    if (
      workload &&
      summary.searchLatencyP95Ms !== undefined &&
      summary.searchLatencyP95Ms !== workload.searchLatencyP95Ms
    ) {
      throw new Error(`${filePath} workload and summary Search latency disagree`);
    }
    if (
      workload &&
      summary.fileSearchLatencyP95Ms !== undefined &&
      summary.fileSearchLatencyP95Ms !== workload.fileSearchLatencyP95Ms
    ) {
      throw new Error(`${filePath} workload and summary File Search latency disagree`);
    }
  }
  return {
    samples,
    run: workload?.run ?? summary?.run ?? samples[0].run,
    searchLatencyP95Ms: workload?.searchLatencyP95Ms,
    fileSearchLatencyP95Ms: workload?.fileSearchLatencyP95Ms,
  };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (!options) {
    return;
  }
  const [nodeProfiles, agentProfiles] = await Promise.all([
    Promise.all(options.nodeFiles.map((filePath) => loadProfile(filePath, 'node', options.sessions))),
    Promise.all(options.agentFiles.map((filePath) => loadProfile(filePath, 'agent', options.sessions))),
  ]);
  for (const [variant, profiles] of [
    ['node', nodeProfiles],
    ['agent', agentProfiles],
  ] as const) {
    const runIds = profiles.flatMap((profile) => (profile.run === undefined ? [] : [profile.run]));
    if (runIds.length > 0 && (runIds.length !== profiles.length || new Set(runIds).size !== runIds.length)) {
      throw new Error(`${variant} profiles must contain unique run identifiers`);
    }
  }
  const memory = compareRuntimeProfiles(
    nodeProfiles.map((profile) => summarizeRuntimeProfile(profile.samples)),
    agentProfiles.map((profile) => summarizeRuntimeProfile(profile.samples)),
  );
  const hasSearchLatency = [...nodeProfiles, ...agentProfiles].every(
    (profile) => profile.searchLatencyP95Ms !== undefined,
  );
  const search = hasSearchLatency
    ? {
        evidenceAvailable: true,
        ...compareRuntimeLatencies(
          nodeProfiles.map((profile) => profile.searchLatencyP95Ms!),
          agentProfiles.map((profile) => profile.searchLatencyP95Ms!),
        ),
      }
    : {
        evidenceAvailable: false,
        meetsLatencyGate: false,
        missingProfileCount: [...nodeProfiles, ...agentProfiles].filter(
          (profile) => profile.searchLatencyP95Ms === undefined,
        ).length,
      };
  const hasFileSearchLatency = [...nodeProfiles, ...agentProfiles].every(
    (profile) => profile.fileSearchLatencyP95Ms !== undefined,
  );
  const fileSearch = hasFileSearchLatency
    ? {
        evidenceAvailable: true,
        ...compareRuntimeLatencies(
          nodeProfiles.map((profile) => profile.fileSearchLatencyP95Ms!),
          agentProfiles.map((profile) => profile.fileSearchLatencyP95Ms!),
        ),
      }
    : {
        evidenceAvailable: false,
        meetsLatencyGate: false,
        missingProfileCount: [...nodeProfiles, ...agentProfiles].filter(
          (profile) => profile.fileSearchLatencyP95Ms === undefined,
        ).length,
      };
  const result = {
    schemaVersion: 3,
    type: 'workspace-agent-runtime-comparison',
    generatedAt: new Date().toISOString(),
    sessions: options.sessions,
    minimumRuns: options.minimumRuns,
    inputs: {
      node: options.nodeFiles,
      agent: options.agentFiles,
    },
    ...memory,
    search,
    fileSearch,
    meetsQualificationGates:
      memory.meetsTwentyFivePercentMemoryGate && search.meetsLatencyGate && fileSearch.meetsLatencyGate,
  };
  const output = `${JSON.stringify(result, null, 2)}\n`;
  process.stdout.write(output);
  if (options.outputPath) {
    await mkdir(path.dirname(options.outputPath), { recursive: true });
    await writeFile(options.outputPath, output);
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n\n${usage()}\n`);
  process.exitCode = 1;
});
