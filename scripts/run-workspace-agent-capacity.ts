import { execFile, spawn } from 'node:child_process';
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import { readLinuxCgroupMemory } from '../server/scripts/process-tree.ts';

import type { ProcessRole } from '../server/scripts/process-tree.ts';

type Variant = 'node' | 'agent';

interface CapacityOptions {
  workspacePath: string;
  extensionDirectory?: string;
  query: string;
  expectedResult: string;
  fileSearchQuery: string;
  expectedFileSearchResult: string;
  sessions: number;
  runs: number;
  batchSize: number;
  durationSeconds: number;
  intervalMs: number;
  warmupSeconds: number;
  pageReadyMs: number;
  cleanupWaitMs: number;
  minimumAvailableMemoryGiB: number;
  allowLowMemory: boolean;
  resume: boolean;
  preflightOnly: boolean;
  outputDirectory: string;
}

interface RoleSummary {
  count: number;
  rssBytes: number;
}

interface ProfileEvent {
  type?: string;
  variant?: Variant;
  sessions?: number;
  run?: number;
  expectedResult?: string;
  fileSearchQuery?: string;
  expectedFileSearchResult?: string;
  searchLatencyP95Ms?: number;
  fileSearchLatencyP95Ms?: number;
  consoleErrorCount?: number;
  observedBrowserErrorCount?: number;
  browserErrors?: Array<{ session?: number; source?: string; message?: string }>;
  ignoredBrowserErrors?: Array<{ session?: number; source?: string; message?: string }>;
  byRole?: Partial<Record<ProcessRole, RoleSummary>>;
  processes?: Array<{ pid?: number; role?: ProcessRole }>;
  postCloseByRole?: Partial<Record<ProcessRole, RoleSummary>>;
  extensionHost?: {
    active?: ExtensionHostRuntimeHealth;
    postClose?: ExtensionHostRuntimeHealth;
  };
}

interface ExtensionHostRuntimeHealth {
  active?: number;
  disconnected?: number;
  clientServiceProxies?: number;
  mainThreadConnections?: number;
  limit?: number;
  saturated?: boolean;
  counters?: {
    created?: number;
    crashed?: number;
    disposed?: number;
    reclaimed?: number;
    rejected?: number;
    startupTimeouts?: number;
  };
  activationDiagnostics?: {
    reportedHosts?: number;
    topExtensions?: Array<{
      extensionId?: string;
      reportingHosts?: number;
      activationCount?: number;
      failureCount?: number;
    }>;
  };
}

interface RunEvidence {
  variant: Variant;
  run: number;
  profilePath: string;
  searchLatencyP95Ms: number;
  fileSearchLatencyP95Ms: number;
  agentPid?: number;
}

interface MemoryPreflight {
  totalMemoryBytes: number;
  hostAvailableMemoryBytes: number;
  cgroupAvailableMemoryBytes?: number;
  effectiveAvailableMemoryBytes: number;
  requiredAvailableMemoryBytes: number;
  passed: boolean;
  overrideUsed: boolean;
}

interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  forced: boolean;
}

const repoRoot = path.resolve(import.meta.dirname, '..');
const execFileAsync = promisify(execFile);
const resultPattern = /^\d+ results found in \d+ files$/;
const variants: Variant[] = ['node', 'agent'];
const activeChildren = new Set<ReturnType<typeof spawn>>();
let interruptedBy: NodeJS.Signals | undefined;

function usage(): string {
  return [
    'Usage: pnpm capacity:workspace-agent -- --expected-result <text> --file-search-query <text> --expected-file-search-result <file> [options]',
    '',
    'Build production artifacts first. The suite starts a fresh Server for every',
    'Node/Agent run, opens full Chromium workspaces, validates process roles and',
    'cleanup, and writes a resume-safe comparison report.',
    '',
    'Options:',
    '  --workspace <path>                 Workspace under test, default repository root',
    '  --extension-dir <path>             Explicit controlled VS Code extension directory',
    '  --query <text>                     Search query, default ServerApp',
    '  --file-search-query <text>         Quick Open file-name query',
    '  --expected-file-search-result <file>  Exact accessible file-name result',
    '  --sessions <count>                 Full browser sessions per run, default 50',
    '  --runs <count>                     Runs per variant, default 3',
    '  --batch-size <count>               Concurrent page startup batch, default 3',
    '  --duration <seconds>               Sampling duration, default 8',
    '  --interval <ms>                    Sampling interval, default 1000',
    '  --warmup <seconds>                 Post-search warmup, default 20',
    '  --page-ready <ms>                  Per-page settling time, default 1800',
    '  --cleanup-wait <ms>                Browser child cleanup time, default 4000',
    '  --minimum-available-memory-gb <n>  Override the preflight requirement',
    '  --output-dir <path>                Evidence directory',
    '  --resume                           Reuse complete, validated run files',
    '  --preflight-only                   Persist host/cgroup memory evidence, then exit',
    '  --allow-low-memory                 Exploratory only; disqualifies a 50-session result',
  ].join('\n');
}

function positiveInteger(name: string, value: string | undefined, fallback?: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (parsed === undefined || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function positiveNumber(name: string, value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return parsed;
}

function defaultMinimumMemoryGiB(sessions: number): number {
  return Math.max(8, Math.ceil(sessions * 0.8));
}

function parseOptions(argv: string[]): CapacityOptions | undefined {
  argv = argv.filter((argument) => argument !== '--');
  if (argv.includes('--help')) {
    process.stdout.write(`${usage()}\n`);
    return undefined;
  }
  const flags = new Set<string>(
    argv.filter(
      (argument) => argument === '--resume' || argument === '--preflight-only' || argument === '--allow-low-memory',
    ),
  );
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (flags.has(option)) {
      continue;
    }
    const value = argv[index + 1];
    if (!option?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`Invalid option near ${option || '<end>'}`);
    }
    values.set(option, value);
    index += 1;
  }
  const knownOptions = new Set([
    '--workspace',
    '--extension-dir',
    '--query',
    '--expected-result',
    '--file-search-query',
    '--expected-file-search-result',
    '--sessions',
    '--runs',
    '--batch-size',
    '--duration',
    '--interval',
    '--warmup',
    '--page-ready',
    '--cleanup-wait',
    '--minimum-available-memory-gb',
    '--output-dir',
  ]);
  const unknownOptions = Array.from(values.keys()).filter((option) => !knownOptions.has(option));
  if (unknownOptions.length > 0) {
    throw new Error(`Unknown options: ${unknownOptions.join(', ')}`);
  }
  const expectedResult = values.get('--expected-result');
  if (!expectedResult || !resultPattern.test(expectedResult)) {
    throw new Error('--expected-result must look like "104 results found in 21 files"');
  }
  const fileSearchQuery = values.get('--file-search-query')?.trim();
  if (!fileSearchQuery) {
    throw new Error('--file-search-query must be a non-empty Quick Open query');
  }
  const expectedFileSearchResult = values.get('--expected-file-search-result')?.trim();
  if (!expectedFileSearchResult) {
    throw new Error('--expected-file-search-result must be a non-empty exact file name');
  }
  const sessions = positiveInteger('--sessions', values.get('--sessions'), 50);
  const runs = positiveInteger('--runs', values.get('--runs'), 3);
  if (sessions >= 50 && runs < 3) {
    throw new Error('A 50-session qualification requires at least three runs per variant');
  }
  return {
    workspacePath: path.resolve(repoRoot, values.get('--workspace') || repoRoot),
    extensionDirectory: values.get('--extension-dir')
      ? path.resolve(repoRoot, values.get('--extension-dir')!)
      : undefined,
    query: values.get('--query') || 'ServerApp',
    expectedResult,
    fileSearchQuery,
    expectedFileSearchResult,
    sessions,
    runs,
    batchSize: positiveInteger('--batch-size', values.get('--batch-size'), 3),
    durationSeconds: positiveInteger('--duration', values.get('--duration'), 8),
    intervalMs: positiveInteger('--interval', values.get('--interval'), 1_000),
    warmupSeconds: positiveInteger('--warmup', values.get('--warmup'), 20),
    pageReadyMs: positiveInteger('--page-ready', values.get('--page-ready'), 1_800),
    cleanupWaitMs: positiveInteger('--cleanup-wait', values.get('--cleanup-wait'), 4_000),
    minimumAvailableMemoryGiB: positiveNumber(
      '--minimum-available-memory-gb',
      values.get('--minimum-available-memory-gb'),
      defaultMinimumMemoryGiB(sessions),
    ),
    allowLowMemory: flags.has('--allow-low-memory'),
    resume: flags.has('--resume'),
    preflightOnly: flags.has('--preflight-only'),
    outputDirectory: path.resolve(
      repoRoot,
      values.get('--output-dir') || `output/runtime-profiles/capacity-s${sessions}`,
    ),
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.stack || error.message : String(error);
}

function appendTail(current: string, chunk: Buffer | string): string {
  const maximumLength = 128 * 1024;
  const next = current + String(chunk);
  return next.length <= maximumLength ? next : next.slice(next.length - maximumLength);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readHostAvailableMemoryBytes(): Promise<number> {
  if (process.platform === 'linux') {
    const meminfo = await readFile('/proc/meminfo', 'utf8');
    const availableKiB = Number(meminfo.match(/^MemAvailable:\s+(\d+)\s+kB/m)?.[1]);
    if (Number.isFinite(availableKiB)) {
      return availableKiB * 1024;
    }
  }
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('/usr/bin/memory_pressure', ['-Q'], {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
      });
      const totalMemoryBytes = Number(stdout.match(/The system has (\d+)/)?.[1]);
      const availablePercent = Number(stdout.match(/System-wide memory free percentage:\s*(\d+)%/)?.[1]);
      if (
        Number.isSafeInteger(totalMemoryBytes) &&
        totalMemoryBytes > 0 &&
        Number.isFinite(availablePercent) &&
        availablePercent >= 0 &&
        availablePercent <= 100
      ) {
        return Math.floor((totalMemoryBytes * availablePercent) / 100);
      }
    } catch {
      // Fall back to Node's portable free-memory reading if the host utility is unavailable.
    }
  }
  return os.freemem();
}

async function inspectMemory(options: CapacityOptions): Promise<MemoryPreflight> {
  const hostAvailableMemoryBytes = await readHostAvailableMemoryBytes();
  const cgroup = await readLinuxCgroupMemory(process.pid);
  const cgroupAvailableMemoryBytes =
    cgroup?.maxBytes === undefined || cgroup.currentBytes === undefined
      ? undefined
      : Math.max(0, cgroup.maxBytes - cgroup.currentBytes);
  const effectiveAvailableMemoryBytes = Math.min(
    hostAvailableMemoryBytes,
    cgroupAvailableMemoryBytes ?? Number.POSITIVE_INFINITY,
  );
  const requiredAvailableMemoryBytes = options.minimumAvailableMemoryGiB * 1024 ** 3;
  const passed = effectiveAvailableMemoryBytes >= requiredAvailableMemoryBytes;
  return {
    totalMemoryBytes: os.totalmem(),
    hostAvailableMemoryBytes,
    cgroupAvailableMemoryBytes,
    effectiveAvailableMemoryBytes,
    requiredAvailableMemoryBytes,
    passed,
    overrideUsed: !passed && options.allowLowMemory,
  };
}

function assertMemoryPreflight(preflight: MemoryPreflight, options: CapacityOptions): void {
  if (!preflight.passed && !options.allowLowMemory) {
    const availableGiB = (preflight.effectiveAvailableMemoryBytes / 1024 ** 3).toFixed(1);
    throw new Error(
      `Capacity suite stopped: ${availableGiB} GiB effective memory is available, ` +
        `but ${options.minimumAvailableMemoryGiB} GiB is required. Use a larger isolated host; ` +
        '--allow-low-memory produces exploratory evidence only.',
    );
  }
}

async function runPreflight(options: CapacityOptions): Promise<void> {
  await mkdir(options.outputDirectory, { recursive: true });
  const preflight = await inspectMemory(options);
  const report = {
    schemaVersion: 1,
    type: 'workspace-agent-capacity-preflight',
    status: preflight.passed ? 'passed' : preflight.overrideUsed ? 'exploratory' : 'failed',
    timestamp: new Date().toISOString(),
    host: {
      platform: process.platform,
      architecture: process.arch,
      nodeVersion: process.version,
      cpuCount: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
    },
    qualification: {
      sessions: options.sessions,
      runs: options.runs,
      minimumAvailableMemoryGiB: options.minimumAvailableMemoryGiB,
      memoryHeadroomEnforced: !options.allowLowMemory,
    },
    preflight,
  };
  await writeFile(
    path.join(options.outputDirectory, 'capacity-preflight.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  assertMemoryPreflight(preflight, options);
}

async function findFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Failed to allocate a loopback port'));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function isPortOpen(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (open: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  message: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await predicate()) {
      return;
    }
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error(message);
}

async function waitForHealth(port: number, server: ReturnType<typeof spawn>, getSpawnError: () => Error | undefined) {
  await waitUntil(
    async () => {
      const spawnError = getSpawnError();
      if (spawnError) {
        throw spawnError;
      }
      if (server.exitCode !== null || server.signalCode !== null) {
        throw new Error(`Server exited before health check (code ${server.exitCode}, signal ${server.signalCode})`);
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1_000) });
        return response.ok;
      } catch {
        return false;
      }
    },
    30_000,
    `Server did not become healthy on port ${port}`,
  );
}

function waitForChildExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    timer.unref?.();
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}

function trackChild(child: ReturnType<typeof spawn>): void {
  activeChildren.add(child);
  child.once('exit', () => activeChildren.delete(child));
}

function signalChildTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  try {
    if (process.platform === 'win32') {
      child.kill(signal);
    } else {
      process.kill(-child.pid, signal);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      throw error;
    }
  }
}

async function terminateChild(child: ReturnType<typeof spawn>): Promise<ChildExit> {
  let forced = false;
  if (!(await waitForChildExit(child, 0))) {
    child.kill('SIGTERM');
    if (!(await waitForChildExit(child, 10_000))) {
      forced = true;
      signalChildTree(child, 'SIGKILL');
      if (!(await waitForChildExit(child, 3_000))) {
        throw new Error(`Process ${child.pid} did not exit`);
      }
    }
  }
  return { code: child.exitCode, signal: child.signalCode, forced };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function runCommand(scriptPath: string, args: string[]): Promise<string> {
  const tsxCli = path.join(repoRoot, 'node_modules/tsx/dist/cli.mjs');
  const child = spawn(process.execPath, [tsxCli, scriptPath, ...args], {
    cwd: repoRoot,
    detached: process.platform !== 'win32',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  trackChild(child);
  let outputTail = '';
  child.stdout?.on('data', (chunk) => {
    outputTail = appendTail(outputTail, chunk);
  });
  child.stderr?.on('data', (chunk) => {
    outputTail = appendTail(outputTail, chunk);
  });
  const exited = await waitForChildExit(child, 24 * 60 * 60 * 1_000);
  if (!exited || child.exitCode !== 0) {
    if (interruptedBy) {
      throw new Error(`Capacity suite interrupted by ${interruptedBy}`);
    }
    throw new Error(`Command failed (${path.basename(scriptPath)}):\n${outputTail}`);
  }
  return outputTail;
}

function roleCount(event: ProfileEvent, role: ProcessRole): number {
  return event.byRole?.[role]?.count || 0;
}

async function validateRunEvidence(
  profilePath: string,
  variant: Variant,
  run: number,
  options: CapacityOptions,
): Promise<RunEvidence> {
  const contents = await readFile(profilePath, 'utf8');
  const events = contents
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line) as ProfileEvent;
      } catch (error) {
        throw new Error(`${profilePath}:${index + 1} is not valid JSON`, { cause: error });
      }
    });
  const workloadEvents = events.filter((event) => event.type === 'browser-workload-ready');
  const samples = events.filter((event) => event.type === 'sample');
  const summaries = events.filter((event) => event.type === 'summary');
  if (workloadEvents.length !== 1 || samples.length === 0 || summaries.length !== 1) {
    throw new Error(`${profilePath} is incomplete; expected one workload, samples and one summary`);
  }
  const workload = workloadEvents[0];
  if (
    workload.variant !== variant ||
    workload.sessions !== options.sessions ||
    workload.run !== run ||
    workload.expectedResult !== options.expectedResult ||
    workload.fileSearchQuery !== options.fileSearchQuery ||
    workload.expectedFileSearchResult !== options.expectedFileSearchResult
  ) {
    throw new Error(`${profilePath} metadata does not match ${variant} run ${run}`);
  }
  const summary = summaries[0];
  if (
    workload.consoleErrorCount !== 0 ||
    summary.consoleErrorCount !== 0 ||
    !Number.isFinite(workload.searchLatencyP95Ms) ||
    workload.searchLatencyP95Ms! <= 0 ||
    !Number.isFinite(workload.fileSearchLatencyP95Ms) ||
    workload.fileSearchLatencyP95Ms! <= 0 ||
    summary.searchLatencyP95Ms !== workload.searchLatencyP95Ms ||
    summary.fileSearchLatencyP95Ms !== workload.fileSearchLatencyP95Ms
  ) {
    const errors = [...(workload.browserErrors || []), ...(summary.browserErrors || [])];
    throw new Error(
      `${profilePath} contains browser errors, invalid Search/File Search latency, or a workload/summary mismatch: ${JSON.stringify(errors.slice(0, 50))}`,
    );
  }

  const activeExtensionHostHealth = summary.extensionHost?.active;
  const postCloseExtensionHostHealth = summary.extensionHost?.postClose;
  const activationDiagnostics = activeExtensionHostHealth?.activationDiagnostics;
  const requiresActivationDiagnostics = Boolean(options.extensionDirectory);
  if (
    activeExtensionHostHealth?.active !== options.sessions ||
    activeExtensionHostHealth.disconnected !== 0 ||
    activeExtensionHostHealth.clientServiceProxies !== options.sessions ||
    activeExtensionHostHealth.mainThreadConnections !== options.sessions ||
    activeExtensionHostHealth.counters?.crashed !== 0 ||
    activeExtensionHostHealth.counters?.rejected !== 0 ||
    activeExtensionHostHealth.counters?.startupTimeouts !== 0 ||
    postCloseExtensionHostHealth?.active !== 0 ||
    postCloseExtensionHostHealth.disconnected !== 0 ||
    postCloseExtensionHostHealth.clientServiceProxies !== 0 ||
    postCloseExtensionHostHealth.mainThreadConnections !== 0 ||
    postCloseExtensionHostHealth.counters?.crashed !== 0 ||
    postCloseExtensionHostHealth.counters?.rejected !== 0 ||
    postCloseExtensionHostHealth.counters?.startupTimeouts !== 0 ||
    (requiresActivationDiagnostics &&
      (activationDiagnostics?.reportedHosts !== options.sessions || !activationDiagnostics.topExtensions?.length)) ||
    activationDiagnostics?.topExtensions?.some(
      (extension) =>
        !extension.extensionId ||
        !extension.reportingHosts ||
        extension.reportingHosts > options.sessions ||
        extension.activationCount !== extension.reportingHosts ||
        extension.failureCount !== 0,
    ) ||
    postCloseExtensionHostHealth.activationDiagnostics !== undefined
  ) {
    throw new Error(
      `${profilePath} did not prove crash-free Extension Host lifecycle and bounded activation diagnostics: ${JSON.stringify(summary.extensionHost)}`,
    );
  }

  let agentPid: number | undefined;
  for (const sample of samples) {
    if (sample.variant !== variant || sample.sessions !== options.sessions || sample.run !== run) {
      throw new Error(`${profilePath} contains a sample from another run`);
    }
    if (roleCount(sample, 'extension-host') !== options.sessions) {
      throw new Error(`${variant} run ${run} did not retain ${options.sessions} Extension Hosts during sampling`);
    }
    if (roleCount(sample, 'terminal-shell') !== options.sessions) {
      throw new Error(`${variant} run ${run} did not retain ${options.sessions} terminal shells during sampling`);
    }
    const watcherCount = roleCount(sample, 'watcher-host');
    const agentCount = roleCount(sample, 'workspace-agent');
    if (variant === 'node' && (watcherCount !== options.sessions || agentCount !== 0)) {
      throw new Error(`Node run ${run} did not use one Node watcher per full browser session`);
    }
    if (variant === 'agent' && (watcherCount !== 0 || agentCount !== 1)) {
      throw new Error(`Agent run ${run} used a Node watcher fallback or did not keep exactly one Agent`);
    }
    if (variant === 'agent') {
      const currentAgentPid = sample.processes?.find((process) => process.role === 'workspace-agent')?.pid;
      if (!currentAgentPid || (agentPid !== undefined && currentAgentPid !== agentPid)) {
        throw new Error(`Agent run ${run} did not keep one stable Agent PID`);
      }
      agentPid = currentAgentPid;
    }
  }

  const postClose = summary.postCloseByRole;
  if (!postClose) {
    throw new Error(`${profilePath} has no post-browser-close process evidence`);
  }
  for (const role of ['extension-host', 'watcher-host', 'pty-host', 'terminal-shell'] as const) {
    if ((postClose[role]?.count || 0) !== 0) {
      throw new Error(`${variant} run ${run} did not reclaim ${role} after browser close`);
    }
  }
  const postCloseAgentCount = postClose['workspace-agent']?.count || 0;
  if ((variant === 'agent' && postCloseAgentCount !== 1) || (variant === 'node' && postCloseAgentCount !== 0)) {
    throw new Error(`${variant} run ${run} has an invalid post-close Agent count`);
  }
  return {
    variant,
    run,
    profilePath,
    searchLatencyP95Ms: workload.searchLatencyP95Ms!,
    fileSearchLatencyP95Ms: workload.fileSearchLatencyP95Ms!,
    agentPid,
  };
}

async function runProfile(variant: Variant, run: number, options: CapacityOptions): Promise<RunEvidence> {
  const profilePath = path.join(options.outputDirectory, `${variant}-s${options.sessions}-r${run}.jsonl`);
  if (await fileExists(profilePath)) {
    if (!options.resume) {
      throw new Error(`${profilePath} already exists; use --resume or choose another --output-dir`);
    }
    try {
      const evidence = await validateRunEvidence(profilePath, variant, run, options);
      process.stdout.write(`[capacity] reused validated ${variant} run ${run}\n`);
      return evidence;
    } catch {
      process.stdout.write(`[capacity] rerunning incomplete ${variant} run ${run}\n`);
    }
  }

  const preflight = await inspectMemory(options);
  assertMemoryPreflight(preflight, options);
  const port = await findFreePort();
  const serverEntry = path.join(repoRoot, 'server/dist/main.js');
  const server = spawn(process.execPath, [serverEntry], {
    cwd: repoRoot,
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      NODE_OPTIONS: '--max-old-space-size=512',
      PORT: String(port),
      OPENSUMI_WORKSPACE_AGENT_WATCH_MODE: variant === 'agent' ? 'enabled' : 'off',
      OPENSUMI_WORKSPACE_AGENT_SEARCH_MODE: variant === 'agent' ? 'enabled' : 'off',
      OPENSUMI_WORKSPACE_AGENT_FILE_SEARCH_MODE: variant === 'agent' ? 'enabled' : 'off',
      MAX_EXTENSION_HOSTS: String(Math.max(3, options.sessions)),
      MAX_MANAGED_EXTENSION_PROCESSES: String(Math.max(3, options.sessions)),
      EXTENSION_HOST_IDLE_TIMEOUT: '1000',
      EXTENSION_HOST_SHUTDOWN_TIMEOUT: '1000',
      EXTENSION_HOST_ACTIVATION_DIAGNOSTICS: 'enabled',
      ...(options.extensionDirectory ? { OPENSUMI_EXTENSION_DIR: options.extensionDirectory } : {}),
      TERMINAL_IDLE_TIMEOUT: '1000',
      TERMINAL_PERSISTENT_SESSION_TIMEOUT: '1000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  trackChild(server);
  let serverLogTail = '';
  let spawnError: Error | undefined;
  server.stdout?.on('data', (chunk) => {
    serverLogTail = appendTail(serverLogTail, chunk);
  });
  server.stderr?.on('data', (chunk) => {
    serverLogTail = appendTail(serverLogTail, chunk);
  });
  server.once('error', (error) => {
    spawnError = error;
  });
  let evidence: RunEvidence | undefined;
  let runError: unknown;
  try {
    await waitForHealth(port, server, () => spawnError);
    const url = new URL(`http://127.0.0.1:${port}/`);
    url.searchParams.set('workspaceDir', options.workspacePath);
    process.stdout.write(`[capacity] ${variant} run ${run}/${options.runs} started on port ${port}\n`);
    await runCommand(path.join(repoRoot, 'scripts/profile-browser-runtime.ts'), [
      '--pid',
      String(server.pid),
      '--url',
      url.toString(),
      '--sessions',
      String(options.sessions),
      '--batch-size',
      String(options.batchSize),
      '--query',
      options.query,
      '--expected-result',
      options.expectedResult,
      '--file-search-query',
      options.fileSearchQuery,
      '--expected-file-search-result',
      options.expectedFileSearchResult,
      '--variant',
      variant,
      '--run',
      String(run),
      '--duration',
      String(options.durationSeconds),
      '--interval',
      String(options.intervalMs),
      '--warmup',
      String(options.warmupSeconds),
      '--page-ready',
      String(options.pageReadyMs),
      '--cleanup-wait',
      String(options.cleanupWaitMs),
      '--output',
      profilePath,
    ]);
    evidence = await validateRunEvidence(profilePath, variant, run, options);
  } catch (error) {
    runError = error;
  }

  const cleanupErrors: string[] = [];
  const serverExit = await terminateChild(server).catch((error) => {
    serverLogTail = appendTail(serverLogTail, `\n${errorText(error)}\n`);
    cleanupErrors.push(errorText(error));
    return undefined;
  });
  await writeFile(
    path.join(options.outputDirectory, `${variant}-s${options.sessions}-r${run}.server.log`),
    serverLogTail,
  );
  const controlledServerExit =
    serverExit &&
    !serverExit.forced &&
    (serverExit.code === 0 || (process.platform === 'win32' && serverExit.signal === 'SIGTERM'));
  if (!controlledServerExit) {
    cleanupErrors.push(
      `${variant} run ${run} Server did not stop gracefully: ${JSON.stringify(serverExit)}\n${serverLogTail}`,
    );
  }
  await waitUntil(async () => !(await isPortOpen(port)), 5_000, `${variant} run ${run} left port ${port} open`).catch(
    (error) => cleanupErrors.push(errorText(error)),
  );
  if (evidence?.agentPid) {
    await waitUntil(
      () => !isProcessAlive(evidence!.agentPid!),
      8_000,
      `Agent process ${evidence.agentPid} survived ${variant} run ${run}`,
    ).catch((error) => cleanupErrors.push(errorText(error)));
  }
  if (runError) {
    if (cleanupErrors.length > 0) {
      throw new Error(`${errorText(runError)}\nCleanup failures:\n${cleanupErrors.join('\n')}`);
    }
    throw runError;
  }
  if (cleanupErrors.length > 0) {
    throw new Error(cleanupErrors.join('\n'));
  }
  if (!evidence) {
    throw new Error(`${variant} run ${run} produced no validated evidence`);
  }
  process.stdout.write(`[capacity] ${variant} run ${run} passed\n`);
  return evidence;
}

async function writeSuiteState(outputDirectory: string, state: unknown): Promise<void> {
  await writeFile(path.join(outputDirectory, 'capacity-suite.json'), `${JSON.stringify(state, null, 2)}\n`);
}

async function runSuite(options: CapacityOptions): Promise<void> {
  const workspaceStats = await stat(options.workspacePath);
  if (!workspaceStats.isDirectory()) {
    throw new Error(`Workspace is not a directory: ${options.workspacePath}`);
  }
  if (options.extensionDirectory) {
    const extensionDirectoryStats = await stat(options.extensionDirectory);
    if (!extensionDirectoryStats.isDirectory()) {
      throw new Error(`Extension directory is not a directory: ${options.extensionDirectory}`);
    }
  }
  const requiredArtifacts = [
    'client/dist/index.html',
    'server/dist/main.js',
    `server/dist/workspace-agent/${process.platform === 'win32' ? 'workspace-agent.exe' : 'workspace-agent'}`,
    'server/dist/workspace-agent/workspace-agent.manifest.json',
  ];
  await Promise.all(requiredArtifacts.map((artifact) => access(path.join(repoRoot, artifact))));
  await mkdir(options.outputDirectory, { recursive: true });
  const initialPreflight = await inspectMemory(options);
  assertMemoryPreflight(initialPreflight, options);
  const startedAt = new Date().toISOString();
  const completedRuns: RunEvidence[] = [];
  let terminalState: Record<string, unknown> | undefined;
  const baseState = {
    schemaVersion: 1,
    type: 'workspace-agent-capacity-suite',
    startedAt,
    host: {
      platform: process.platform,
      architecture: process.arch,
      nodeVersion: process.version,
      cpuCount: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
    },
    options,
    initialPreflight,
  };
  await writeSuiteState(options.outputDirectory, { ...baseState, status: 'running', completedRuns });
  try {
    for (let run = 1; run <= options.runs; run += 1) {
      for (const variant of variants) {
        completedRuns.push(await runProfile(variant, run, options));
        await writeSuiteState(options.outputDirectory, { ...baseState, status: 'running', completedRuns });
      }
    }

    const comparisonPath = path.join(options.outputDirectory, 'comparison.json');
    const comparisonArgs = [
      '--sessions',
      String(options.sessions),
      '--minimum-runs',
      String(options.runs),
      '--output',
      comparisonPath,
    ];
    for (const variant of variants) {
      completedRuns
        .filter((run) => run.variant === variant)
        .forEach((run) => comparisonArgs.push(`--${variant}`, run.profilePath));
    }
    await runCommand(path.join(repoRoot, 'server/scripts/compare-runtime-profiles.ts'), comparisonArgs);
    const comparison = JSON.parse(await readFile(comparisonPath, 'utf8')) as {
      meetsTwentyFivePercentMemoryGate?: boolean;
      search?: { meetsLatencyGate?: boolean };
      fileSearch?: { meetsLatencyGate?: boolean };
      meetsQualificationGates?: boolean;
    };
    const qualification = {
      fullFiftySessionWorkload: options.sessions >= 50,
      threeRunsPerVariant: options.runs >= 3,
      memoryHeadroomEnforced: !options.allowLowMemory,
      memoryGatePassed: comparison.meetsTwentyFivePercentMemoryGate === true,
      searchLatencyGatePassed: comparison.search?.meetsLatencyGate === true,
      fileSearchLatencyGatePassed: comparison.fileSearch?.meetsLatencyGate === true,
      allRunsValidated: completedRuns.length === options.runs * variants.length,
    };
    const qualified = Object.values(qualification).every(Boolean) && comparison.meetsQualificationGates === true;
    const finalState = {
      ...baseState,
      status: qualified ? 'qualified' : 'smoke-passed',
      finishedAt: new Date().toISOString(),
      completedRuns,
      comparisonPath,
      qualification: { ...qualification, qualified },
    };
    terminalState = finalState;
    await writeSuiteState(options.outputDirectory, finalState);
    process.stdout.write(`${JSON.stringify(finalState, null, 2)}\n`);
    if (options.sessions >= 50 && !qualified) {
      throw new Error('50-session suite completed but did not satisfy every qualification gate');
    }
  } catch (error) {
    await writeSuiteState(options.outputDirectory, {
      ...baseState,
      ...terminalState,
      status: 'failed',
      failedAt: new Date().toISOString(),
      completedRuns,
      error: errorText(error),
    });
    throw error;
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (options) {
    if (options.preflightOnly) {
      await runPreflight(options);
      return;
    }
    const handleSignal = (signal: NodeJS.Signals) => {
      interruptedBy ||= signal;
      activeChildren.forEach((child) => signalChildTree(child, 'SIGTERM'));
    };
    process.on('SIGINT', handleSignal);
    process.on('SIGTERM', handleSignal);
    try {
      await runSuite(options);
    } finally {
      process.off('SIGINT', handleSignal);
      process.off('SIGTERM', handleSignal);
    }
  }
}

void main().catch((error) => {
  process.stderr.write(`${errorText(error)}\n\n${usage()}\n`);
  process.exitCode = 1;
});
