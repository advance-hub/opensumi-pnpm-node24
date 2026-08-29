import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { chromium } from 'playwright';

import { collectProcessTreeMemory } from '../server/scripts/process-tree.ts';

import type { ProcessTreeMemorySnapshot } from '../server/scripts/process-tree.ts';
import type { Browser, Page } from 'playwright';

const repoRoot = path.resolve(import.meta.dirname, '..');

interface ProfileOptions {
  sessions: number;
  cycles: number;
  idleSeconds: number;
  idleSampleIntervalMs: number;
  extHostIdleTimeoutMs: number;
  maxOldSpaceSizeMiB: number;
  headless: boolean;
  outputPath: string;
}

interface MemorySample {
  timestamp: number;
  pid: number;
  rssBytes: number;
  heapTotalBytes: number;
  heapUsedBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
}

interface HostMemoryTrace {
  pid: number;
  firstSample: MemorySample;
  lastSample: MemorySample;
  maxRssBytes: number;
  sampleCount: number;
  heapUsedShareOfRssAtEnd: number;
}

interface CycleEvidence {
  cycle: number;
  extHostPid: number | undefined;
  extHostRssBytes: number | undefined;
  openedAtSample: ProcessTreeMemorySnapshot;
  serverRssBytes: number;
  reclaimedWithinMs: number;
  postCloseExtensionHostCount: number;
  postCloseServerRssBytes: number;
}

interface IdleEvidence {
  sampleIntervalMs: number;
  samples: Array<{
    atMs: number;
    extHostRssBytes: number;
    extHostHeapUsedBytes: number | undefined;
    serverRssBytes: number;
  }>;
  rssSlopeBytesPerMinute: number | undefined;
}

interface ExtensionHostProfileEvidence {
  schemaVersion: 1;
  platform: string;
  arch: string;
  startedAt: string;
  durationMs: number;
  options: ProfileOptions;
  workspaceAgentPackaged: boolean;
  baseline: {
    extHostCount: number;
    extHostRssBytes: number | undefined;
    extHostHeapUsedBytes: number | undefined;
    extHostExternalBytes: number | undefined;
    serverRssBytes: number;
    totalTreeRssBytes: number;
    activationDiagnostics: unknown;
  };
  idle: IdleEvidence;
  cycles: CycleEvidence[];
  hostTraces: HostMemoryTrace[];
  serverRssAfterFinalCleanup: number | undefined;
  leftoverExtensionHostPids: number[];
  shutdown: { code: number | null; signal: string | null; forced: boolean };
  consoleErrors: string[];
}

function usage(): string {
  return [
    'Usage: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/profile-extension-host.ts [options]',
    'Options:',
    '  --sessions <n>                  Concurrent baseline sessions (default 1)',
    '  --cycles <n>                    Open/close recycling cycles after the idle phase (default 5)',
    '  --idle-seconds <n>              How long the baseline session idles while sampled (default 120)',
    '  --idle-sample-interval <ms>     Sampling interval during the idle phase (default 15000)',
    '  --ext-host-idle-timeout <ms>    EXTENSION_HOST_IDLE_TIMEOUT for this run (default 2000)',
    '  --max-old-space-size <mib>      EXTENSION_HOST_MAX_OLD_SPACE_SIZE for this run (default 256)',
    '  --headed                        Run the browser headed',
    '  --output <path>                 Evidence JSON path (default output/extension-host/ext-host-profile-<platform>.json)',
  ].join('\n');
}

function parseOptions(argv: string[]): ProfileOptions {
  const options: ProfileOptions = {
    sessions: 1,
    cycles: 5,
    idleSeconds: 120,
    idleSampleIntervalMs: 15_000,
    extHostIdleTimeoutMs: 2_000,
    maxOldSpaceSizeMiB: 256,
    headless: true,
    outputPath: path.join(repoRoot, 'output/extension-host', `ext-host-profile-${process.platform}.json`),
  };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    const next = (): string => {
      index += 1;
      if (index >= argv.length) {
        throw new Error(`Missing value for ${value}`);
      }
      return argv[index];
    };
    switch (value) {
      case '--sessions':
        options.sessions = Number(next());
        break;
      case '--cycles':
        options.cycles = Number(next());
        break;
      case '--idle-seconds':
        options.idleSeconds = Number(next());
        break;
      case '--idle-sample-interval':
        options.idleSampleIntervalMs = Number(next());
        break;
      case '--ext-host-idle-timeout':
        options.extHostIdleTimeoutMs = Number(next());
        break;
      case '--max-old-space-size':
        options.maxOldSpaceSizeMiB = Number(next());
        break;
      case '--headed':
        options.headless = false;
        break;
      case '--output':
        options.outputPath = path.resolve(next());
        break;
      case '--help':
      case '-h':
        console.log(usage());
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown option ${value}\n${usage()}`);
    }
  }
  if (!Number.isInteger(options.sessions) || options.sessions < 1) {
    throw new Error('--sessions must be a positive integer');
  }
  if (!Number.isInteger(options.cycles) || options.cycles < 0) {
    throw new Error('--cycles must be a non-negative integer');
  }
  if (!Number.isInteger(options.idleSampleIntervalMs) || options.idleSampleIntervalMs < 1_000) {
    throw new Error('--idle-sample-interval must be at least 1000ms');
  }
  return options;
}

interface HealthResponse {
  status?: string;
  extensionHost?: {
    active?: number;
    disconnected?: number;
    limit?: number;
    saturated?: boolean;
    counters?: { created?: number; crashed?: number; disposed?: number; reclaimed?: number };
    activationDiagnostics?: unknown;
  };
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

async function readHealth(port: number): Promise<HealthResponse> {
  const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2_000) });
  return (await response.json()) as HealthResponse;
}

async function waitForHealth(port: number, server: ReturnType<typeof spawn>): Promise<void> {
  await waitUntil(
    async () => {
      if (server.exitCode !== null || server.signalCode !== null) {
        throw new Error(
          `OpenSumi server exited before becoming healthy (code ${server.exitCode}, signal ${server.signalCode})`,
        );
      }
      try {
        const body = await readHealth(port);
        return body.status === 'ok';
      } catch {
        return false;
      }
    },
    30_000,
    'OpenSumi server did not become healthy within 30 seconds',
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

async function terminateServer(
  child: ReturnType<typeof spawn>,
): Promise<{ code: number | null; signal: string | null; forced: boolean }> {
  let forced = false;
  if (!(await waitForChildExit(child, 0))) {
    child.kill('SIGTERM');
    if (!(await waitForChildExit(child, 8_000))) {
      forced = true;
      child.kill('SIGKILL');
      if (!(await waitForChildExit(child, 3_000))) {
        throw new Error(`OpenSumi server process ${child.pid} did not exit`);
      }
    }
  }
  return { code: child.exitCode, signal: child.signalCode, forced };
}

interface ExtHostProcess {
  pid: number;
  rssBytes: number;
}

function findExtensionHosts(snapshot: ProcessTreeMemorySnapshot): ExtHostProcess[] {
  const hosts: ExtHostProcess[] = [];
  for (const process of snapshot.processes) {
    if (process.role === 'extension-host') {
      hosts.push({ pid: process.pid, rssBytes: process.rssBytes });
    }
  }
  return hosts;
}

function roleRss(snapshot: ProcessTreeMemorySnapshot, role: string): number | undefined {
  const summary = snapshot.byRole?.[role as keyof typeof snapshot.byRole];
  return summary ? summary.rssBytes / Math.max(1, summary.count) : undefined;
}

async function readMemoryTrace(filePath: string): Promise<MemorySample[]> {
  const content = await readFile(filePath, 'utf8').catch(() => '');
  return content
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as MemorySample);
}

function summarizeTraces(samples: MemorySample[]): HostMemoryTrace[] {
  const byPid = new Map<number, MemorySample[]>();
  for (const sample of samples) {
    const list = byPid.get(sample.pid) || [];
    list.push(sample);
    byPid.set(sample.pid, list);
  }
  return Array.from(byPid.entries())
    .map(([pid, list]) => {
      const firstSample = list[0];
      const lastSample = list[list.length - 1];
      return {
        pid,
        firstSample,
        lastSample,
        maxRssBytes: Math.max(...list.map((sample) => sample.rssBytes)),
        sampleCount: list.length,
        heapUsedShareOfRssAtEnd: lastSample.rssBytes > 0 ? lastSample.heapUsedBytes / lastSample.rssBytes : 0,
      };
    })
    .sort((left, right) => left.firstSample.timestamp - right.firstSample.timestamp);
}

function linearSlopeBytesPerMinute(samples: Array<{ atMs: number; value: number }>): number | undefined {
  if (samples.length < 3) {
    return undefined;
  }
  const meanX = samples.reduce((sum, sample) => sum + sample.atMs, 0) / samples.length;
  const meanY = samples.reduce((sum, sample) => sum + sample.value, 0) / samples.length;
  let numerator = 0;
  let denominator = 0;
  for (const sample of samples) {
    numerator += (sample.atMs - meanX) * (sample.value - meanY);
    denominator += (sample.atMs - meanX) ** 2;
  }
  if (denominator === 0) {
    return undefined;
  }
  // slope per ms → per minute
  return (numerator / denominator) * 60_000;
}

async function openSession(browser: Browser, port: number, workspacePath: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const url = new URL(`http://127.0.0.1:${port}/`);
  url.searchParams.set('workspaceDir', workspacePath);
  await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForFunction(
    (expectedTitle) => document.title === expectedTitle,
    `${path.basename(workspacePath)} — OpenSumi`,
    { timeout: 30_000 },
  );
  return page;
}

async function runProfile(options: ProfileOptions): Promise<void> {
  const startedAt = Date.now();
  const port = await findFreePort();
  const serverEntry = path.join(repoRoot, 'server/dist/main.js');
  const clientEntry = path.join(repoRoot, 'client/dist/index.html');
  await Promise.all([serverEntry, clientEntry].map((filePath) => access(filePath)));
  const agentBinary = path.join(
    repoRoot,
    'server/dist/workspace-agent',
    process.platform === 'win32' ? 'workspace-agent.exe' : 'workspace-agent',
  );
  const workspaceAgentPackaged = await access(agentBinary)
    .then(() => true)
    .catch(() => false);

  const evidenceDir = await mkdtemp(path.join(os.tmpdir(), 'opensumi-ext-host-profile-'));
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), 'opensumi-ext-host-workspace-'));
  const memoryTracePath = path.join(evidenceDir, 'ext-host-memory.jsonl');
  await mkdir(workspacePath, { recursive: true });

  const consoleErrors: string[] = [];
  const serverLogs: string[] = [];
  let server: ReturnType<typeof spawn> | undefined;
  let browser: Browser | undefined;
  const baselinePages: Array<{ context: Awaited<ReturnType<Browser['newContext']>>; page: Page }> = [];
  try {
    const serverEnv: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: 'production',
      NODE_OPTIONS: '--max-old-space-size=512',
      PORT: String(port),
      EXTENSION_HOST_IDLE_TIMEOUT: String(options.extHostIdleTimeoutMs),
      EXTENSION_HOST_SHUTDOWN_TIMEOUT: '1000',
      EXTENSION_HOST_MAX_OLD_SPACE_SIZE: String(options.maxOldSpaceSizeMiB),
      EXTENSION_HOST_ACTIVATION_DIAGNOSTICS: '1',
      EXTENSION_HOST_MEMORY_DIAGNOSTICS_PATH: memoryTracePath,
      EXTENSION_HOST_MEMORY_DIAGNOSTICS_INTERVAL_MS: '1000',
    };
    server = spawn(process.execPath, [serverEntry], {
      cwd: repoRoot,
      env: serverEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout?.on('data', (chunk) => serverLogs.push(String(chunk)));
    server.stderr?.on('data', (chunk) => serverLogs.push(String(chunk)));
    await waitForHealth(port, server);

    browser = await chromium.launch({ headless: options.headless });
    for (let session = 0; session < options.sessions; session++) {
      const page = await openSession(browser, port, workspacePath);
      page.on('console', (message) => {
        if (message.type() === 'error' && consoleErrors.length < 30) {
          consoleErrors.push(message.text());
        }
      });
      baselinePages.push({ context: page.context(), page });
    }
    await waitUntil(
      async () => {
        const health = await readHealth(port).catch(() => undefined);
        return (health?.extensionHost?.active ?? 0) >= options.sessions;
      },
      60_000,
      `Extension host did not reach ${options.sessions} active hosts within 60 seconds`,
    );

    const baselineSnapshot = await collectProcessTreeMemory(server.pid!);
    const baselineHosts = findExtensionHosts(baselineSnapshot);
    const baselineTrace = await readMemoryTrace(memoryTracePath);
    const baselineHostSamples = baselineTrace.filter((sample) => baselineHosts.some((host) => host.pid === sample.pid));
    const baselineHealth = await readHealth(port);
    const baseline = {
      extHostCount: baselineHosts.length,
      extHostRssBytes: roleRss(baselineSnapshot, 'extension-host'),
      extHostHeapUsedBytes:
        baselineHostSamples.length > 0
          ? Math.round(
              baselineHostSamples.reduce((sum, sample) => sum + sample.heapUsedBytes, 0) / baselineHostSamples.length,
            )
          : undefined,
      extHostExternalBytes:
        baselineHostSamples.length > 0
          ? Math.round(
              baselineHostSamples.reduce((sum, sample) => sum + sample.externalBytes, 0) / baselineHostSamples.length,
            )
          : undefined,
      serverRssBytes: roleRss(baselineSnapshot, 'server'),
      totalTreeRssBytes: baselineSnapshot.totalRssBytes,
      activationDiagnostics: baselineHealth.extensionHost?.activationDiagnostics ?? undefined,
    };

    // Idle phase: the baseline session stays open; the ext host RSS slope over
    // this window separates a stable steady state from unbounded growth.
    const idleSamples: IdleEvidence['samples'] = [];
    const idleStartedAt = Date.now();
    const idleDeadline = idleStartedAt + options.idleSeconds * 1000;
    while (Date.now() < idleDeadline) {
      await delay(options.idleSampleIntervalMs);
      const snapshot = await collectProcessTreeMemory(server.pid!);
      const hosts = findExtensionHosts(snapshot);
      const trace = await readMemoryTrace(memoryTracePath);
      const heapUsed =
        hosts.length > 0
          ? trace.filter((sample) => hosts.some((host) => host.pid === sample.pid)).at(-1)?.heapUsedBytes
          : undefined;
      idleSamples.push({
        atMs: Date.now() - idleStartedAt,
        extHostRssBytes: hosts.reduce((sum, host) => sum + host.rssBytes, 0),
        extHostHeapUsedBytes: heapUsed,
        serverRssBytes: roleRss(snapshot, 'server') ?? 0,
      });
    }
    const idle: IdleEvidence = {
      sampleIntervalMs: options.idleSampleIntervalMs,
      samples: idleSamples,
      rssSlopeBytesPerMinute: linearSlopeBytesPerMinute(
        idleSamples.map((sample) => ({ atMs: sample.atMs, value: sample.extHostRssBytes })),
      ),
    };

    const closeBaseline = async () => {
      for (const { context } of baselinePages.splice(0)) {
        await context.close();
      }
    };

    // Recycling cycles: open a fresh session, sample it, close it and require
    // the ext host to be reclaimed before continuing. The server is NOT
    // restarted between cycles, so server-side retention shows up directly.
    const cycles: CycleEvidence[] = [];
    for (let cycle = 1; cycle <= options.cycles; cycle++) {
      const page = await openSession(browser, port, workspacePath);
      page.on('console', (message) => {
        if (message.type() === 'error' && consoleErrors.length < 30) {
          consoleErrors.push(message.text());
        }
      });
      await waitUntil(
        async () => {
          const health = await readHealth(port).catch(() => undefined);
          return (health?.extensionHost?.active ?? 0) >= 1;
        },
        60_000,
        `Cycle ${cycle}: extension host did not activate within 60 seconds`,
      );
      const openedSnapshot = await collectProcessTreeMemory(server.pid!);
      const openedHosts = findExtensionHosts(openedSnapshot);
      const openedAt = Date.now();

      await page.context().close();
      let reclaimedWithinMs = -1;
      try {
        await waitUntil(
          async () => {
            const health = await readHealth(port).catch(() => undefined);
            return (health?.extensionHost?.active ?? 1) === 0;
          },
          Math.max(30_000, options.extHostIdleTimeoutMs * 10),
          `Cycle ${cycle}: extension host was not reclaimed`,
        );
        reclaimedWithinMs = Date.now() - openedAt;
      } catch (error) {
        console.error(String(error));
      }
      const postCloseSnapshot = await collectProcessTreeMemory(server.pid!);
      cycles.push({
        cycle,
        extHostPid: openedHosts[0]?.pid,
        extHostRssBytes: openedHosts[0]?.rssBytes,
        openedAtSample: openedSnapshot,
        serverRssBytes: roleRss(openedSnapshot, 'server') ?? 0,
        reclaimedWithinMs,
        postCloseExtensionHostCount: findExtensionHosts(postCloseSnapshot).length,
        postCloseServerRssBytes: roleRss(postCloseSnapshot, 'server') ?? 0,
      });
    }
    await closeBaseline().catch(() => undefined);

    const finalSnapshot = await collectProcessTreeMemory(server.pid!);
    const leftoverExtensionHostPids = findExtensionHosts(finalSnapshot).map((host) => host.pid);
    const serverRssAfterFinalCleanup = roleRss(finalSnapshot, 'server');

    const hostTraceSamples = await readMemoryTrace(memoryTracePath);
    const hostTraces = summarizeTraces(hostTraceSamples);
    const shutdown = await terminateServer(server);
    server = undefined;

    const evidence: ExtensionHostProfileEvidence = {
      schemaVersion: 1,
      platform: process.platform,
      arch: process.arch,
      startedAt: new Date(startedAt).toISOString(),
      durationMs: Date.now() - startedAt,
      options,
      workspaceAgentPackaged,
      baseline,
      idle,
      cycles,
      hostTraces,
      serverRssAfterFinalCleanup,
      leftoverExtensionHostPids,
      shutdown,
      consoleErrors,
    };
    await mkdir(path.dirname(options.outputPath), { recursive: true });
    await writeFile(options.outputPath, JSON.stringify(evidence, null, 2));
    const hostTraceOutput = path.join(repoRoot, 'output/extension-host', `ext-host-memory-${process.platform}.jsonl`);
    await mkdir(path.dirname(hostTraceOutput), { recursive: true });
    await writeFile(hostTraceOutput, hostTraceSamples.map((sample) => JSON.stringify(sample)).join('\n'));
    await rm(evidenceDir, { recursive: true, force: true });
    console.log(`Extension host profile written to ${options.outputPath}`);
    console.log(
      JSON.stringify(
        {
          baseline,
          idleSlopeBytesPerMinute: idle.rssSlopeBytesPerMinute,
          cycles: cycles.map((cycle) => ({
            cycle: cycle.cycle,
            extHostRssMiB:
              cycle.extHostRssBytes !== undefined ? Math.round(cycle.extHostRssBytes / 1024 / 1024) : undefined,
            reclaimedWithinMs: cycle.reclaimedWithinMs,
            postCloseExtensionHostCount: cycle.postCloseExtensionHostCount,
          })),
          leftoverExtensionHostPids,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    if (server !== undefined) {
      await terminateServer(server).catch(() => undefined);
    }
    try {
      const logTail = serverLogsTail(serverLogs);
      if (logTail) {
        console.error(`--- server log tail ---\n${logTail}`);
      }
    } catch {
      // evidence collection must not mask the original failure
    }
    throw error;
  } finally {
    for (const { context } of baselinePages.splice(0)) {
      await context.close().catch(() => undefined);
    }
    await browser?.close().catch(() => undefined);
  }
}

function serverLogsTail(logs: string[]): string {
  return logs.join('').split('\n').slice(-40).join('\n');
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  try {
    await runProfile(options);
  } catch (error) {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
